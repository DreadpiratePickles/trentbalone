"""
Backend integration tests for Trent's Goal Loop:
- AUTH (dev credentials via NextAuth)
- RBAC on goal endpoints
- GET goals (pre-seeded demo goal)
- INTAKE (POST /goals -> 201 with success criteria) [Claude call]
- HUMAN GATE PATCH (approve_criteria / stop)
- RUN ROUND (gating: 409 from intake / when round_running)
- Verify pre-seeded goal has 3 rounds + 2 met criteria with evidence
"""
import os
import time
import pytest
import requests

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or "http://localhost:3000").rstrip("/")
DEMO_EMAIL = "demo@trent.app"
DEMO_EMAIL_ALT = "demo@trent.local"
COMPANY_ID = "company_trent_demo"


# ─────────────────────── Auth fixtures ───────────────────────
import re

def _extract_session_token(raw_set_cookie: str) -> str | None:
    """Cloudflare collapses multiple Set-Cookie headers via comma; requests
    mis-splits them. Pull __Secure-authjs.session-token=... directly."""
    if not raw_set_cookie:
        return None
    m = re.search(r"__Secure-authjs\.session-token=([^;,]+)", raw_set_cookie)
    return m.group(1) if m else None


def _sign_in(email: str) -> requests.Session:
    s = requests.Session()
    csrf = s.get(f"{BASE_URL}/api/auth/csrf", timeout=15).json()
    token = csrf["csrfToken"]
    r = s.post(
        f"{BASE_URL}/api/auth/callback/credentials",
        data={"csrfToken": token, "email": email, "callbackUrl": f"{BASE_URL}/", "json": "true"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        allow_redirects=False,
        timeout=15,
    )
    assert r.status_code in (200, 302), f"sign-in failed: {r.status_code} {r.text[:200]}"
    # Manually extract session-token (requests drops it through Cloudflare comma-coalesced Set-Cookie)
    raw = r.headers.get("Set-Cookie", "")
    tok = _extract_session_token(raw)
    if tok and "__Secure-authjs.session-token" not in s.cookies.get_dict():
        s.cookies.set("__Secure-authjs.session-token", tok, domain=BASE_URL.replace("https://", "").replace("http://", ""))
    sess = s.get(f"{BASE_URL}/api/auth/session", timeout=15).json()
    if not isinstance(sess, dict) or not sess.get("user"):
        raise AssertionError(f"session not established: {sess} ; raw set-cookie={raw[:300]}")
    assert sess["user"].get("email") == email, f"wrong email in session: {sess}"
    return s


@pytest.fixture(scope="session")
def auth_session() -> requests.Session:
    return _sign_in(DEMO_EMAIL)


# ─────────────────────── 1. RBAC ───────────────────────
class TestRBAC:
    def test_get_goals_unauthenticated_is_401(self):
        r = requests.get(f"{BASE_URL}/api/companies/{COMPANY_ID}/goals", timeout=15)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"

    def test_post_goals_unauthenticated_is_401(self):
        r = requests.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals",
            json={"command": "Should be rejected"},
            timeout=15,
        )
        assert r.status_code == 401

    def test_demo_alt_email_also_authenticates(self):
        s = _sign_in(DEMO_EMAIL_ALT)
        r = s.get(f"{BASE_URL}/api/companies/{COMPANY_ID}/goals", timeout=15)
        assert r.status_code == 200, f"demo@trent.local cannot read goals: {r.status_code}"


# ─────────────────────── 2. Read pre-seeded goal ───────────────────────
class TestSeededGoal:
    def test_list_goals_returns_seeded(self, auth_session):
        r = auth_session.get(f"{BASE_URL}/api/companies/{COMPANY_ID}/goals", timeout=20)
        assert r.status_code == 200, r.text[:200]
        body = r.json()
        goals = body.get("goals") if isinstance(body, dict) else body
        assert isinstance(goals, list) and len(goals) >= 1, f"no goals returned: {body}"
        # Find the seeded waitlist goal
        seeded = next((g for g in goals if "waitlist" in (g.get("objective") or "").lower()), None)
        assert seeded is not None, f"seeded waitlist goal not found in {[g.get('objective') for g in goals]}"
        pytest.shared_seeded_id = seeded["id"]

    def test_seeded_goal_has_rounds_and_met_criteria(self, auth_session):
        gid = getattr(pytest, "shared_seeded_id", None)
        assert gid, "seeded id missing"
        r = auth_session.get(f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}", timeout=20)
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        goal = body.get("goal") if isinstance(body, dict) and "goal" in body else body
        rounds = goal.get("rounds") or []
        crits = goal.get("successCriteria") or goal.get("criteria") or []
        assert len(rounds) >= 3, f"expected >=3 rounds, got {len(rounds)}"
        met = [c for c in crits if c.get("status") == "met"]
        assert len(met) >= 2, f"expected >=2 met criteria, got {len(met)} of {len(crits)}"
        # every met criterion has evidence
        for c in met:
            ev = c.get("evidenceArtifactIds") or []
            assert len(ev) > 0, f"met criterion has no evidence: {c}"


# ─────────────────────── 3. Intake (Claude call) ───────────────────────
class TestIntake:
    def test_post_creates_intake_goal(self, auth_session):
        cmd = "TEST_Write a short FAQ document covering our top 5 customer questions"
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals",
            json={"command": cmd},
            timeout=180,
        )
        assert r.status_code == 201, f"expected 201, got {r.status_code}: {r.text[:400]}"
        body = r.json()
        goal = body.get("goal") if isinstance(body, dict) and "goal" in body else body
        assert goal.get("status") == "intake", f"status={goal.get('status')}"
        crits = goal.get("successCriteria") or goal.get("criteria") or []
        assert 3 <= len(crits) <= 6, f"expected 3-6 criteria, got {len(crits)}"
        for c in crits:
            assert "id" in c and "text" in c, c
            assert c.get("status") == "unmet", c
        pytest.shared_intake_id = goal["id"]


# ─────────────────────── 4. Human Gate ───────────────────────
class TestHumanGate:
    def test_post_round_on_intake_is_409(self, auth_session):
        gid = getattr(pytest, "shared_intake_id", None)
        if not gid:
            pytest.skip("intake goal not created")
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}/rounds",
            timeout=30,
        )
        assert r.status_code == 409, f"expected 409 (must approve first), got {r.status_code}: {r.text[:200]}"

    def test_patch_approve_criteria_flips_to_active(self, auth_session):
        gid = getattr(pytest, "shared_intake_id", None)
        if not gid:
            pytest.skip("intake goal not created")
        r = auth_session.patch(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}",
            json={"action": "approve_criteria"},
            timeout=20,
        )
        assert r.status_code == 200, f"approve failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        goal = body.get("goal") if isinstance(body, dict) and "goal" in body else body
        assert goal.get("status") == "active", f"status after approve={goal.get('status')}"

    def test_patch_stop_flips_to_stopped(self, auth_session):
        # Create a second throwaway intake goal to stop (don't kill the 'active' one we may run)
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals",
            json={"command": "TEST_Throwaway goal to be stopped"},
            timeout=180,
        )
        assert r.status_code == 201, r.text[:300]
        gid = (r.json().get("goal") or r.json())["id"]
        r = auth_session.patch(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}",
            json={"action": "stop"},
            timeout=20,
        )
        assert r.status_code == 200, f"stop failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        goal = body.get("goal") if isinstance(body, dict) and "goal" in body else body
        assert goal.get("status") == "stopped", f"status after stop={goal.get('status')}"


# ─────────────────────── 5. Run round (slow) ───────────────────────
class TestRunRound:
    """Fires ONE round via fire-and-poll to validate the full goal loop."""

    @pytest.mark.timeout(600)
    def test_run_one_round_via_polling(self, auth_session):
        gid = getattr(pytest, "shared_intake_id", None)
        if not gid:
            pytest.skip("active goal not available")
        # capture rounds.length before
        r0 = auth_session.get(f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}", timeout=20)
        before = r0.json()
        before_goal = before.get("goal", before)
        before_rounds = len(before_goal.get("rounds") or [])

        # fire the round in a thread / via short read timeout, then poll
        try:
            requests.post(
                f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}/rounds",
                cookies=auth_session.cookies.get_dict(),
                timeout=(10, 5),  # connect=10s, read=5s -> intentional read-timeout, server keeps running
            )
        except requests.exceptions.ReadTimeout:
            pass  # expected — server runs round async to our perspective

        # Poll up to ~5 min
        deadline = time.time() + 300
        final_status = None
        final_goal = None
        while time.time() < deadline:
            time.sleep(10)
            rr = auth_session.get(f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}", timeout=20)
            if rr.status_code != 200:
                continue
            g = rr.json().get("goal") or rr.json()
            final_status = g.get("status")
            final_goal = g
            if final_status in ("awaiting_review", "completed", "active"):
                # If status returned to 'active' but rounds increased, we're done too
                if len(g.get("rounds") or []) > before_rounds:
                    break
            if final_status == "stopped":
                break

        assert final_goal is not None, "never got final goal state"
        rounds = final_goal.get("rounds") or []
        assert len(rounds) > before_rounds, (
            f"rounds did not increase ({before_rounds} -> {len(rounds)}), final status={final_status}"
        )
        last = rounds[-1]
        planned = last.get("plannedTaskCount") or len(last.get("plannedTasks") or last.get("tasks") or [])
        assert planned > 0, f"last round has no planned tasks: {last}"
        artifacts = last.get("artifactIds") or last.get("artifacts") or []
        assert len(artifacts) > 0, f"last round produced no artifacts: {last}"

        # any criterion flipped to met must carry non-empty evidence
        crits = final_goal.get("successCriteria") or final_goal.get("criteria") or []
        for c in crits:
            if c.get("status") == "met":
                assert (c.get("evidenceArtifactIds") or []), f"met without evidence: {c}"


# ─────────────────────── 6. Round-running gating ───────────────────────
class TestConcurrencyGating:
    def test_double_post_round_returns_409(self, auth_session):
        """Cannot reliably trigger 'round_running' from a black-box test without race.
        We instead verify that POSTing a round on a 'stopped' goal returns 409."""
        # find or create a stopped goal
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals",
            json={"command": "TEST_Goal to verify stopped 409"},
            timeout=180,
        )
        if r.status_code != 201:
            pytest.skip(f"could not create intake goal: {r.status_code}")
        gid = (r.json().get("goal") or r.json())["id"]
        auth_session.patch(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}",
            json={"action": "stop"},
            timeout=20,
        )
        rr = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/goals/{gid}/rounds",
            timeout=30,
        )
        assert rr.status_code == 409, f"expected 409 on stopped, got {rr.status_code}: {rr.text[:200]}"
