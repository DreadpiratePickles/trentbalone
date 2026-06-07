# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |

---

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@trent.app** with:

1. A clear description of the vulnerability
2. Steps to reproduce (proof-of-concept if possible)
3. Estimated impact (data exposure, privilege escalation, etc.)
4. Your preferred disclosure timeline

We will acknowledge receipt within **48 hours** and aim to provide a fix within **14 days** for critical issues.

---

## Scope

In scope:
- Authentication / authorization bypasses
- Multi-tenant data isolation failures (company data crossing tenants)
- Remote code execution in the worker or API
- Prompt-injection attacks that cause agents to exfiltrate data or take unauthorized actions
- Secrets / credentials exposed in responses or logs

Out of scope:
- Theoretical vulnerabilities without a working proof-of-concept
- UI bugs that don't have a security impact
- Rate-limiting or DoS (report anyway, but lower priority)
- Issues in dependencies not related to how Trent uses them

---

## Security practices

- All secrets encrypted at rest with `SECRET_ENCRYPTION_KEY` (AES-256-GCM)
- Agent kill switch (`cmd+shift+.`) halts execution at every step boundary
- Approval queue gates all consequential agent actions before execution
- Tamper-evident SHA-256 hash chain on every audit log entry
- Per-company spend caps with hard-stop enforcement
- Credentials never returned in API responses; decrypted only inside worker context

---

## Security & Compliance Documentation

Internal security policies, SOC 2 controls mapping, vendor list, and audit readiness assessment are maintained at [`docs/security/`](docs/security/README.md).

---

## Disclosure policy

We follow coordinated disclosure. We will credit researchers in release notes unless they prefer anonymity.
