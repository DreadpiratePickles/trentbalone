# Incident Response Policy

**Version:** 1.0  
**Effective:** 2026-05-28  
**Owner:** CEO / founding team  
**Review cadence:** Annually, or after any Severity 1 incident

---

## 1. Purpose

Define how Trent detects, responds to, and recovers from security incidents and service disruptions.

## 2. Incident severity matrix

| Severity | Definition | Response time | Examples |
|---|---|---|---|
| **S1 — Critical** | Customer data breach, complete service outage, ransomware | Immediate (< 15 min) | DB exposed, API down, credentials leaked |
| **S2 — High** | Partial outage, unauthorized access, data integrity issue | < 1 hour | Specific API endpoint failing, unusual auth activity |
| **S3 — Medium** | Degraded performance, minor data issue, single-customer impact | < 4 hours | Slow cycles, one company's tasks failing |
| **S4 — Low** | Non-urgent anomaly, no customer impact | Next business day | Elevated error rate in logs, test failure in CI |

## 3. Response process

### Detection
- Automated: Sentry alerts, Grafana anomaly detection, health endpoint (`GET /api/health`) monitoring
- Manual: Team member discovers issue or customer reports it

### Triage (all severities)
1. Assign an incident commander (IC) — the person who detected it, or on-call engineer.
2. Classify severity using the matrix above.
3. Open an incident channel (Slack `#incidents` or equivalent).

### Containment (S1 and S2)
- Immediately isolate the affected system (disable route, revoke keys, enable kill switch).
- Preserve logs and artifacts before cleaning up.

### Eradication
- Identify root cause.
- Apply fix in a feature branch with accelerated review.

### Recovery
- Restore service from backup if needed (see `scripts/backup/pg-restore-drill.sh`).
- Verify integrity post-restore.
- Re-enable affected functionality incrementally.

### Post-mortem (S1 and S2)
- Written post-mortem within 48 hours of resolution.
- Format: timeline, root cause, impact, what went well, corrective actions with owners and due dates.
- Stored in `docs/security/post-mortems/YYYY-MM-DD-<slug>.md`.

## 4. Customer notification

| Severity | Notification timeline | Channel |
|---|---|---|
| S1 (data breach) | Within 72 hours (GDPR) / as soon as feasible | Email direct to affected customers |
| S2 (service degradation) | Within 24 hours if > 1 hour impact | Status page + email |
| S3–S4 | Status page update when resolved | Status page |

## 5. Security incident reporting

Any suspected security incident must be reported to the security owner at: **security@trent.app** (or current security contact).

If a team member discovers a potential breach, they must report it within 1 hour regardless of severity. Do not attempt to investigate alone — loop in the IC immediately.
