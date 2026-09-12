# Vendor Management Policy

**Version:** 1.0  
**Effective:** 2026-05-28  
**Owner:** CEO / founding team  
**Review cadence:** Annually, or when adding a new sub-processor

---

## 1. Purpose

Ensure that all third-party vendors (sub-processors) who handle Trent customer data meet our security standards and that customers have visibility into who processes their data.

## 2. Definition of sub-processor

A sub-processor is any vendor that receives, stores, or processes Trent customer data as part of providing the Trent service. Vendors who only process anonymized analytics or billing metadata are not sub-processors.

## 3. Approval process for new vendors

Before integrating a new sub-processor:

1. **Security review** — Is the vendor SOC 2 Type II certified? Do they have a published security page and DPA?
2. **Data minimization** — What is the minimum data the vendor needs? Can we anonymize or redact before sending?
3. **DPA execution** — Sign a Data Processing Agreement with the vendor before sending any customer data.
4. **Approval** — CEO approval required for any new sub-processor.
5. **Vendor list update** — Add to `docs/security/vendor-list.md` within 24 hours of approval.

## 4. Ongoing monitoring

- All sub-processors are reviewed annually for:
  - Continued SOC 2 / ISO 27001 certification validity
  - Any reported breaches or security incidents
  - Changes to their data handling practices
- If a sub-processor is breached or their certification lapses, we evaluate alternatives within 30 days.

## 5. Termination

- When a sub-processor relationship ends, request data deletion within 30 days.
- Update `vendor-list.md` to mark the vendor as terminated.
- Log the termination in the audit log.
