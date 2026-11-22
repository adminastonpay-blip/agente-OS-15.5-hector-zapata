# ASTON OS — Data Inventory and Retention Register

**Status:** Fill-in register. Do not infer that a data category is collected. Confirm actual flows by code/configuration and provider contracts.

| Data category | Collected? | Source/system | Purpose | Controller/processor role | Recipients/subprocessors | Location/transfer | Retention | Deletion method | Owner/evidence |
|---|---|---|---|---|---|---|---|---|---|
| Contact name/email/company/role | Verify | Shopify inquiry form | Respond to inquiry | Determine | Verify | Verify | Set period | Verify | Commercial/privacy |
| Inquiry message | Verify | Shopify inquiry form | Respond and maintain correspondence | Determine | Verify | Verify | Set period | Verify | Commercial/privacy |
| Authentication identifiers/logs | Verify | ASTON services | Security/access control | Determine | Verify | Verify | Set period | Verify | Engineering |
| Audit/security events | Verify | ASTON control plane | Accountability/detection | Determine | Verify | Verify | Set period | Verify | Security |
| Billing/customer records | Verify | Shopify/payment provider | Contract/payment/accounting | Determine | Verify | Verify | Legal retention | Provider/process | Finance/legal |
| Cookies/analytics identifiers | Verify | Storefront/apps | Measure/operate | Determine | Verify | Verify | Set period | Verify | Web/privacy |

## Required decisions
- Inventory every form, endpoint, database table, log stream, cookie, analytics tag and connected app.
- Map data transfers, geographic locations, subprocessors and access roles.
- Define retention periods by purpose and applicable legal obligations; avoid indefinite retention.
- Define deletion propagation, backups, legal holds and evidence of completion.
- Define request intake, identity verification, search, response and escalation.
- Reconcile this register against the privacy notice and DPA before publication/signature.

**Do not mark complete based on this template. Attach evidence and owner sign-off for every row.**
