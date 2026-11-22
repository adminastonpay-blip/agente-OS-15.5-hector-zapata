# ASTON — Global Legal, Cybersecurity and English-First Requirements

**Status:** Governance requirements / implementation backlog. This document is not a legal opinion, certification, or evidence of compliance.

## 1. Corporate identity — owner-provided, not independently verified

The owner has instructed that ASTON's contracting entity be represented as a Delaware limited liability company (LLC), with the owner/member name supplied exactly as:

**ZAPATA HECTOR HORACIO ZAPATA**

Until primary corporate records are reviewed, treat both the LLC's exact registered legal name and the person's legal role/title as **OWNER-PROVIDED / UNVERIFIED**. Do not invent or publish an LLC legal name, file number, registered agent, address, EIN, tax status, good-standing status, ownership percentage, or signing authority.

Before public legal pages, invoices, contracts, payment onboarding, or regulatory filings are released, obtain and verify:
- Certificate of Formation and current Delaware Division of Corporations status/good-standing evidence.
- Exact registered LLC name, file number, formation date, registered agent and registered office.
- Operating Agreement and member/manager authority; confirm the supplied person's exact legal name and capacity.
- EIN confirmation and tax classification with the appropriate adviser.
- Foreign qualification, tax, licensing and registered-agent requirements in every state/country where the company conducts business.
- Beneficial ownership reporting obligations as applicable under the law in force at the relevant date; do not assume a historical filing rule remains applicable.

Use a neutral placeholder such as **[VERIFIED LEGAL ENTITY NAME], a Delaware limited liability company** in draft legal documents until verification. Do not imply the individual is the LLC itself.

## 2. English-first public website requirement

All public-facing website content must be written and reviewed in professional English before release, including:
- Homepage, navigation, product and service pages, pricing, checkout, cart and customer account surfaces.
- Contact forms, validation messages, consent language, transactional notices and customer-facing error states.
- Privacy notice, cookie notice, terms of service, acceptable-use policy, refund/cancellation and shipping policies where applicable.
- Security, trust, compliance, accessibility, status and support pages.
- SEO titles/descriptions, structured data, metadata, image alt text, downloadable public documents and public help content.

Internal engineering notes may remain in their working language unless designated for publication. No machine-translated legal text may be published without qualified review. English-first does not remove mandatory local-language disclosures or consumer rights: provide required localized notices and translations where a target jurisdiction requires them.

Release gate: automated detection of unintended non-English public strings, followed by human editorial/legal review. Do not rewrite customer data or user-generated content merely to force English.

## 3. Compliance operating model — jurisdiction and service based

ASTON must maintain a living applicability register. “Global compliance” means identifying every applicable obligation for each actual market, product, data flow and legal entity; implementing controls; retaining evidence; and blocking unsupported claims. It does **not** mean asserting that every law worldwide applies or that compliance is guaranteed.

For each jurisdiction and product, record:
- Countries/states served, customer types, sales channels and legal entities.
- Data subjects, data categories, purposes, lawful bases, retention and transfers.
- Whether ASTON acts as controller/business, processor/service provider, merchant, marketplace, payment facilitator, employer, or another regulated role.
- Applicable statutes, regulator guidance, effective dates, local representative/registration needs, contractual obligations and exemptions.
- Named accountable owner, counsel review, technical controls, evidence, open gaps and next review date.

Initial legal domains to assess (applicability must be determined, not presumed):
1. Corporate, commercial, contract, consumer protection, e-commerce, advertising and accessibility.
2. Privacy, data protection, cookies/e-privacy, data-subject rights, cross-border transfers, breach notification and records of processing.
3. Cybersecurity, critical infrastructure, incident reporting, secure software development and vendor/supply-chain risk.
4. Payments and financial regulation, money transmission, stored value, lending, securities, sanctions, AML/KYC and fraud controls where the actual service triggers them.
5. Tax, sales/use tax, VAT/GST, invoicing, accounting, payroll and employment.
6. Intellectual property, open-source licenses, content rights and data/database rights.
7. Export controls, sanctions screening, trade restrictions and government procurement restrictions.
8. Sector rules (for example health, education, telecom, insurance, public sector or defense) only where the service, customer or data brings them into scope.

## 4. Jurisdictional baseline to evaluate

The compliance register must at minimum assess, when relevant to actual operations:
- United States: federal privacy/security and consumer laws; Delaware entity law; state privacy laws (including California where applicable), breach-notification laws, state consumer-protection rules, tax and sector-specific requirements.
- European Economic Area: GDPR, ePrivacy rules as implemented nationally, consumer/e-commerce rules, NIS2 and DORA only if the entity/service falls in scope, and the EU AI Act where AI system/provider/deployer obligations apply.
- United Kingdom: UK GDPR, Data Protection Act 2018, PECR, consumer/e-commerce and applicable cybersecurity/sector rules.
- Argentina: Personal Data Protection Law 25.326 and implementing rules, consumer protection, electronic commerce, cybersecurity and tax obligations applicable to the activity.
- Brazil: LGPD and applicable consumer/e-commerce rules.
- Other countries and subnational jurisdictions: add before offering services, collecting personal data, employing staff or targeting customers there.

This list is a screening baseline, not an exhaustive global legal inventory. Laws and enforcement guidance change; counsel must validate current requirements before launch and at scheduled reviews.

## 5. Cybersecurity control framework

Adopt a risk-based control system mapped to recognized frameworks, without claiming certification unless independently assessed:
- NIST Cybersecurity Framework 2.0 for Govern, Identify, Protect, Detect, Respond and Recover.
- ISO/IEC 27001:2022 ISMS controls; consider ISO/IEC 27017 and 27018 for cloud and personal-data processing.
- CIS Critical Security Controls v8.1 as prioritized technical safeguards.
- OWASP ASVS and OWASP API Security Top 10 for application/API verification.
- SOC 2 Trust Services Criteria as an assurance target if required by customers; SOC 2 is an audit report, not a law.
- PCI DSS only where cardholder data environment or contractual/payment-provider scope requires it. Prefer hosted/tokenized payment collection and never store sensitive authentication data.
- Additional sector/government frameworks (e.g. HIPAA, CMMC, FedRAMP) only after formal scope determination.

Minimum engineering safeguards:
- Default-deny authorization, tenant isolation, server-side validation and least privilege.
- Phishing-resistant MFA for privileged access; short-lived credentials, managed secrets and rotation.
- Encryption in transit and at rest; documented key management and access logging.
- Secure SDLC, threat modeling, peer review, dependency/SBOM and vulnerability scanning, signed/reproducible releases where feasible.
- SAST, DAST, secret scanning, container/IaC scanning, API authorization tests and adversarial tests in isolated environments.
- Centralized tamper-evident audit trails, alerting, time synchronization and retention controls.
- Tested backup/restore, disaster recovery, incident response and customer/regulator notification workflows.
- Vendor due diligence, subprocessors register, data-processing agreements and exit/deletion plans.
- Accessibility, abuse prevention, rate limiting, anti-automation protections and resilience testing.
- Human approval and additional safeguards for destructive, financial, privileged or high-impact actions.

## 6. Evidence and release gates

Every control must be labeled **VERIFIED**, **PARTIALLY VERIFIED**, **NOT VERIFIED**, **NOT APPLICABLE (with rationale)**, or **BLOCKED**. A policy document alone is not evidence that a control operates.

Required evidence includes dated test results, configuration snapshots, access reviews, incident exercises, restore tests, vulnerability remediation records, vendor assessments, data-flow maps, legal applicability decisions and approvals.

No production launch, customer-data migration, payment activation or regulated-market expansion while a critical legal, security, privacy, identity, payment or operational gate is BLOCKED. Do not claim “fully compliant”, “bank-grade”, “military-grade”, “certified”, or “zero vulnerabilities” without current independent evidence supporting the exact claim and scope.

## 7. Required owners and review

Assign accountable owners for Legal/Privacy, Security, Engineering, Finance/Tax, Operations and Product. Require qualified counsel in Delaware/US and in each material operating jurisdiction. Review the register at least quarterly and whenever a new country, product, processor, data category, payment flow, AI capability or material law change is introduced.

## 8. Immediate open items

- Verify the LLC's exact registered name and formation/good-standing records.
- Verify the supplied person's legal name, role and signing authority against corporate records.
- Determine actual markets, customer types, products, payment flows and data processing roles.
- Complete a data inventory, data-flow map, retention schedule and transfer assessment.
- Obtain counsel-reviewed privacy, cookie, terms, consumer, DPA and sector-specific documents.
- Inventory all public website routes and establish English-language QA plus mandatory local disclosures.
- Map existing ASTON controls to the frameworks above and attach operational evidence.
- Identify payment/regulatory perimeter before enabling any financial functionality.

**Release rule:** This document creates requirements and work items only. It does not establish that ASTON or any entity is incorporated, licensed, compliant, audited, certified, or ready for production.
