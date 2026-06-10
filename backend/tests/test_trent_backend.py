"""
Backend integration tests for Trent's new orchestrator / wiki / heartbeat APIs.

Auth: NextAuth credentials provider (email-only). We authenticate by:
  1. GET /api/auth/csrf       -> csrfToken + cookie
  2. POST /api/auth/callback/credentials  with csrfToken + email
  3. Reuse the resulting session cookie in subsequent /api/* calls
"""
import io
import os
import time

import pytest
import requests

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "http://localhost:3000").rstrip("/")
DEMO_EMAIL = "demo@trent.app"
COMPANY_ID = "company_trent_demo"


# ─────────────────────────── Fixtures ───────────────────────────
@pytest.fixture(scope="session")
def auth_session():
    s = requests.Session()
    csrf = s.get(f"{BASE_URL}/api/auth/csrf", timeout=15).json()
    token = csrf["csrfToken"]
    r = s.post(
        f"{BASE_URL}/api/auth/callback/credentials",
        data={
            "csrfToken": token,
            "email": DEMO_EMAIL,
            "callbackUrl": f"{BASE_URL}/",
            "json": "true",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        allow_redirects=False,
        timeout=15,
    )
    assert r.status_code in (200, 302), f"sign-in failed: {r.status_code} {r.text[:200]}"
    sess = s.get(f"{BASE_URL}/api/auth/session", timeout=15).json()
    assert sess.get("user", {}).get("email") == DEMO_EMAIL, f"session not established: {sess}"
    return s


# ─────────────────── Health / Backend bridge ────────────────────
class TestBridge:
    def test_proxy_healthz(self):
        r = requests.get("http://localhost:8001/healthz", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["proxy_to"].startswith("http://")

    def test_proxy_forwards_api_health(self):
        r = requests.get("http://localhost:8001/api/health", timeout=45)
        assert r.status_code in (200, 503), r.text[:300]
        body = r.json()
        assert body["status"] in ("ok", "degraded")
        assert "readiness" in body
        assert "checks" in body


# ─────────────────── Orchestrator endpoints ─────────────────────
class TestOrchestrator:
    def test_post_orchestrate_creates_run(self, auth_session):
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/orchestrate",
            json={"objective": "TEST_draft a one-paragraph launch tweet"},
            timeout=30,
        )
        assert r.status_code in (200, 201), f"{r.status_code}: {r.text[:300]}"
        data = r.json()
        assert "run" in data
        run = data["run"]
        assert run["id"]
        assert run["status"] in ("planning", "running", "completed")
        pytest.run_id = run["id"]

    def test_get_orchestrate_returns_run(self, auth_session):
        run_id = getattr(pytest, "run_id", None)
        assert run_id, "no run_id from POST"
        # Wait briefly so planner step kicks in
        time.sleep(8)
        r = auth_session.get(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/orchestrate?runId={run_id}",
            timeout=15,
        )
        assert r.status_code == 200
        run = r.json()["run"]
        assert run["id"] == run_id
        assert "steps" in run
        assert isinstance(run["steps"], list)

    def test_orchestrate_makes_progress(self, auth_session):
        run_id = getattr(pytest, "run_id", None)
        assert run_id
        progressed = False
        for _ in range(12):  # up to ~60s
            time.sleep(5)
            r = auth_session.get(
                f"{BASE_URL}/api/companies/{COMPANY_ID}/orchestrate?runId={run_id}",
                timeout=15,
            )
            run = r.json()["run"]
            steps = run.get("steps") or []
            if run["status"] in ("running", "completed") and len(steps) > 0:
                progressed = True
                break
        assert progressed, f"run never progressed past planning within 60s: status={run.get('status')}"

    def test_post_orchestrate_requires_objective(self, auth_session):
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/orchestrate",
            json={},
            timeout=15,
        )
        assert r.status_code == 400

    def test_orchestrate_unauth(self):
        r = requests.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/orchestrate",
            json={"objective": "x"},
            timeout=15,
        )
        assert r.status_code == 401


# ───────────────────── Heartbeat endpoints ──────────────────────
class TestHeartbeat:
    def test_company_heartbeat(self, auth_session):
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/heartbeat",
            json={},
            timeout=60,
        )
        assert r.status_code == 200, r.text[:300]
        report = r.json().get("report")
        assert report is not None
        assert "decision" in report and "reason" in report

    def test_heartbeat_sweep(self, auth_session):
        # NOTE: docstring says no auth required unless CRON_SECRET set,
        # but middleware blocks all /api/* without session. So we pass session.
        r = auth_session.post(f"{BASE_URL}/api/heartbeat/sweep", timeout=120)
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        assert "reports" in body
        assert isinstance(body["reports"], list)
        assert "count" in body


# ─────────────────────── Wiki notes ─────────────────────────────
class TestWikiNotes:
    def test_create_note_with_links_and_tags(self, auth_session):
        body = {
            "title": "TEST_Strategy Doc",
            "path": "/strategy/test-doc",
            "content": "We will link to [[Vision]] and [[Roadmap]]. #strategy #q1",
        }
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/wiki-notes", json=body, timeout=15
        )
        assert r.status_code == 200, r.text[:300]
        note = r.json()["note"]
        assert note["title"] == "TEST_Strategy Doc"
        assert "strategy" in note.get("tags", []) or "#strategy" in note.get("tags", [])
        outgoing = note.get("outgoing") or note.get("links") or []
        # Some implementations name it links / outgoingLinks
        outgoing_str = " ".join(str(o) for o in outgoing).lower()
        assert "vision" in outgoing_str or "roadmap" in outgoing_str
        pytest.note_id = note["id"]

    def test_list_notes_with_tree(self, auth_session):
        r = auth_session.get(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/wiki-notes", timeout=15
        )
        assert r.status_code == 200
        body = r.json()
        assert "notes" in body
        assert "tree" in body
        assert any(n.get("id") == getattr(pytest, "note_id", None) for n in body["notes"])

    def test_get_note_by_id(self, auth_session):
        nid = getattr(pytest, "note_id", None)
        assert nid
        r = auth_session.get(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/wiki-notes?note={nid}", timeout=15
        )
        assert r.status_code == 200
        assert r.json()["note"]["id"] == nid

    def test_graph_view(self, auth_session):
        r = auth_session.get(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/wiki-notes?view=graph", timeout=15
        )
        assert r.status_code == 200
        graph = r.json().get("graph") or {}
        assert "nodes" in graph and "edges" in graph

    def test_upload_markdown(self, auth_session):
        files = {"file": ("test-upload.md", b"# Hello\n\nLinks to [[Vision]].\n#uploaded", "text/markdown")}
        data = {"folder": "/uploads"}
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/wiki-notes/upload",
            files=files,
            data=data,
            timeout=20,
        )
        assert r.status_code in (200, 201), r.text[:300]
        note = r.json()["note"]
        assert "Hello" in note.get("content", "") or "Vision" in note.get("content", "")
        pytest.uploaded_id = note["id"]

    def test_delete_note(self, auth_session):
        nid = getattr(pytest, "uploaded_id", None) or getattr(pytest, "note_id", None)
        assert nid
        r = auth_session.delete(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/wiki-notes?note={nid}", timeout=15
        )
        assert r.status_code == 200
        # Verify gone
        r2 = auth_session.get(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/wiki-notes?note={nid}", timeout=15
        )
        assert r2.status_code == 404

    def test_post_wiki_requires_title(self, auth_session):
        r = auth_session.post(
            f"{BASE_URL}/api/companies/{COMPANY_ID}/wiki-notes",
            json={"content": "no title"},
            timeout=15,
        )
        assert r.status_code == 400
