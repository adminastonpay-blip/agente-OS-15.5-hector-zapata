# ASTON TRUST INFRASTRUCTURE 2.0 — Gap Matrix

Branch: `trust/decision-passport-v0`  
Date: 2026-11-08  
Rule: IMPLEMENTED ≠ VALIDATED ≠ PRODUCTION

## Legend
- **I** = code present
- **V** = tests / reproducible check
- **P** = production deploy proven

| Component | I | V | P | Notes |
|-----------|---|---|---|-------|
| Public tenant isolation | ✓ | unit | no | header ignored for public |
| `/v1/validate` not fake-valid | ✓ | — | no | auth required, production_ready false |
| Decision Passport HMAC | ✓ | e2e route | no | needs PII_HMAC_SECRET |
| Trust verify endpoint | ✓ | e2e | no | |
| Decision lifecycle states | ✓ | e2e | no | OTS stays PENDING |
| Agent Constitution evaluate | ✓ | route | no | default policy |
| Risk envelopes | ✓ | — | partial | main worker |
| Governed agent plans | ✓ | — | partial | |
| Economic passport | ✓ | e2e | no | **estimate only** |
| OpenTimestamps / Bitcoin | ✗ | ✗ | ✗ | **not claimed** |
| R2 evidence lake | partial | ✗ | ✗ | optional JOURNAL |
| Vectorize RAG | ✗ binding | ✗ | ✗ | create index first |
| Quantum-ready (ML-DSA) | probe only | ✗ | ✗ | |
| ZK selective disclosure | ✗ | ✗ | ✗ | research |
| Multi-cloud portability | ✗ | ✗ | ✗ | |
| Adversarial full suite | partial | unit | ✗ | |

## E2E insignia

```http
POST /v1/trust/e2e
Content-Type: application/json

{"goal":"Prueba gobernada","action":"analyze","exposure":100}
```

Then:

```http
POST /v1/trust/verify
{"passport": { ... from e2e response ... }}
```

## Secrets required
- `PII_HMAC_SECRET` or `API_KEY` (≥16 chars)

## Explicit non-claims
Do not market: OTS confirmed, quantum safe, Palantir parity, multi-org Trust Network live.
