# ASTON OS — Phase 6 Enterprise Go-Live Gate

**Release status: BLOCKED — NOT READY FOR PUBLIC LAUNCH**

This checklist tracks release readiness. It is not legal advice. Candidate Shopify theme only; production theme is unchanged.

## 1. Legal, privacy and contracting gates
- [ ] Have qualified counsel review privacy policy against applicable jurisdictions and actual data flows. Confirm controller identity/contact, purposes, legal basis, Shopify and other processors, retention, user rights, cross-border transfers and request-handling process.
- [ ] Finalize and review B2B Master Services Agreement (scope, acceptance, fees, taxes, payment, support, warranty, liability, IP, termination, dispute resolution).
- [ ] Finalize DPA where processing customer personal data requires it.
- [ ] Finalize subscription, cancellation/refund terms if recurring billing is offered.
- [ ] Publish acceptable-use and responsible-disclosure policy.
- [ ] Finalize SLA only if one is offered; ensure support windows, uptime metric, exclusions, remedies, and maintenance are accurate.
- [ ] Verify legal entity name, address, business contact, privacy contact and incident-reporting contact.
- [ ] Publish only final, reviewed legal documents; ensure storefront links are active and accurate.

## 2. Contact form and privacy
- [ ] Link a published, final privacy notice from the form consent statement.
- [ ] Confirm what data is collected and minimize fields to what is needed.
- [ ] Test contact submission, spam protection, email delivery, validation and confirmation/error states end-to-end.
- [ ] Define retention, access, deletion and rights-request workflow for lead data.
- [ ] Ensure form copy never implies the privacy notice is already final while it is under review.
- [ ] Do not request passwords, access tokens, secrets or sensitive personal information.

## 3. Commercial / checkout
- [ ] Approve product pricing, billing cadence, currencies, tax, availability and scope.
- [ ] Ensure six ASTON offerings are intentionally priced and no Draft item is linked as a purchasable offer.
- [ ] Configure and test payment provider, checkout, receipt, refund and customer support paths before activation.
- [ ] Validate all claims, deliverables, certifications, SLAs and capabilities against implemented/verified reality.

## 4. Technical and user-experience QA
- [ ] Verify every CTA, menu, footer and page handle on the preview theme.
- [ ] Test desktop, tablet and mobile, keyboard navigation, focus states, contrast and screen-reader labels.
- [ ] Complete manual visual review with preview screenshots (not yet completed).
- [ ] Review app permissions, integrations, cookies/analytics and applicable consent requirements.
- [ ] Confirm security configuration and third-party dependencies.

## 5. Release / rollback
- [ ] Legal owner, commercial owner and technical owner approve release.
- [ ] Record theme ID, commit/version and release time.
- [ ] Publish only after explicit owner launch authorization.
- [ ] Rollback procedure: republish previously active theme immediately if launch QA fails; log incident and follow-up.

## Current blockers observed during Phase 6 (2026-11-22)
- Legal policy pages (privacy, B2B terms, DPA, refunds/subscriptions, SLA, acceptable-use, financial disclaimer) are unpublished.
- Footer legal URLs are empty.
- Commercial contact form copy states the expanded privacy notice is still under review.
- Six commercial products are Draft; variants show 0.00. Pricing and checkout have not been approved or activated.
- Form email delivery and real end-to-end testing are not yet verified.
- Visual review/screenshots across devices are not completed.

## Scope safety
No production theme publishing, legal-page publishing, product publishing, pricing changes, checkout activation, or content deletion without explicit approval.
