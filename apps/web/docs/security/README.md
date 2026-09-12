# Trent — Security & Compliance Documentation

> **Status:** SOC 2 Type I preparation in progress. Observation window not yet started. See `audit-readiness.md` for gap analysis.

This directory contains all security policy and compliance documentation for Trent AI Cofounder OS.

## Document index

| Document | Purpose |
|---|---|
| `policies/information-security-policy.md` | Overarching InfoSec policy (CC1, CC2) |
| `policies/access-control-policy.md` | Access provisioning and RBAC (CC6) |
| `policies/change-management-policy.md` | Code review, CI gates, deploy controls (CC8) |
| `policies/incident-response-policy.md` | Incident classification, response, post-mortem (CC7) |
| `policies/vendor-management-policy.md` | Sub-processor review and approval (CC9) |
| `policies/business-continuity-policy.md` | BCP/DR: RTO/RPO, backup drills, runbooks (CC7, A1) |
| `policies/acceptable-use-policy.md` | Employee device and data handling rules (CC1) |
| `controls-mapping.md` | SOC 2 CC1–CC9 criteria → Trent controls |
| `vendor-list.md` | All sub-processors: service, data touched, DPA status |
| `evidence-checklist.md` | Evidence items, owner, cadence, collection status |
| `audit-readiness.md` | Gap analysis and next steps for Type I engagement |

## How to use

- **Auditors:** Start with `controls-mapping.md` to see the full control set, then `evidence-checklist.md` to understand what evidence is available.
- **Engineers:** When making infrastructure or access changes, update `controls-mapping.md` and relevant policies.
- **Leadership:** Review `audit-readiness.md` quarterly and before engaging an auditor.

## Key dates

| Milestone | Target |
|---|---|
| All policy docs written | 2026-05-28 |
| Controls mapping complete | 2026-05-28 |
| Compliance platform selected (Vanta / Drata) | TBD — before first paying customer |
| Observation window start | TBD |
| SOC 2 Type I audit | Month 9 after first paid customer |
| SOC 2 Type II audit | Month 15–18 after first paid customer |
