# Security policy

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, **Report a vulnerability**.
If that button is not there yet (private vulnerability reporting is a repository setting the
maintainer has to switch on), open an ordinary issue that says only that you have a security report
and asks for a private channel. Do not put the details, a proof of concept or any credential in a
public issue.

A useful report names the commit or `trent --version`, the operating system, the exact commands,
and which boundary was crossed: what a process could reach, read or do that it should not have.
Never paste a real API key or token; describe where it was and what could see it instead.

This is a one-maintainer project with no tagged release yet. A report is fixed on the development
branch with a failing test first, and credited in the fix unless you ask otherwise. There is no
bounty and no promised response time.

## What is in scope

The security surfaces are the ones this repository adds around the wrapped application, described
in [docs/security.md](docs/security.md):

- **The egress proxy** ([Egress credential brokering](docs/security.md#egress-credential-brokering)):
  a sandboxed process holds an opaque token, the host holds the secret, and the proxy swaps one for
  the other only for an allowlisted host. Anything that lets agent-authored code hold a real key,
  reach a host nobody allowlisted, or get a request forwarded without a resolvable token is in scope.
- **The side-effect gate** ([Side-effecting tools: the gate](docs/security.md#side-effecting-tools-the-gate)):
  sending, money-moving and customer-facing calls ask a human at every autonomy level, and the
  approval is bound to the exact call arguments. Anything that sends, charges or books without that
  approval, or lets one approval cover a different call, is in scope.
- Around them: the sandbox and terminal backends, the hardline blocklist and deny globs, the
  redaction boundary, secret handling in the profile `.env`, the signed audit export, `trent connect`
  token storage, the messaging gateway's pairing and sender checks, and the installer and update
  signature verification (`scripts/install.sh`, `scripts/install.ps1`, `trent update`).

## What is out of scope

- Defects in the wrapped application under `apps/web/`. It is read-only in this repository; the
  known ones are listed in [Reported, not fixed](docs/security.md#reported-not-fixed-defects-in-the-wrapped-application).
  New ones are still welcome as reports, and are recorded there.
- The model providers' and third-party APIs' own behaviour.
- Anything that needs an attacker who already controls your user account on the host.
