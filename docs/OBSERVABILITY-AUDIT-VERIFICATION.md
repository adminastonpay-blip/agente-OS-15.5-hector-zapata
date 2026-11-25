# ASTON OS — Private audit-chain verification

## Endpoint

`GET /v1/engineering/audit/verify`

The endpoint is read-only and requires a verified, non-public identity with the `admin` or `executor` role. It verifies the local tenant-scoped SHA-256 chain already maintained by the SafetyInterlock Durable Object.

## Tenant boundary

- The tenant comes only from the authenticated `Identity` produced by the existing authentication layer.
- The Worker selects the Durable Object named `audit:<verified-tenant>` and passes that same tenant to the internal verifier.
- A caller-supplied `tenant` query parameter is rejected. No tenant value is accepted from a request body.
- The response exposes neither the tenant identifier nor a tenant-derived pseudonym.
- No audit event payloads, actors, credentials, prompts, or row contents are returned.

## Result contract

| HTTP | Status | Meaning |
|---|---|---|
| 200 | `intact` | The existing chain verifier accepted one or more events |
| 200 | `empty` | No events exist; the empty chain is structurally valid but proves no audit coverage |
| 409 | `mismatch` | A previous-hash link or record digest failed verification |
| 503 | `unknown` | The Safety binding or verifier response is unavailable or invalid |
| 403 | — | Identity is not a verified admin/executor, or its tenant scope is invalid |
| 405 | — | Method is not GET |
| 400 | — | Caller attempted a tenant override |

The response includes trace/request/child-operation identifiers and an ephemeral SHA-256 fingerprint over the sanitized result. The child operation is `audit.chain_verify`; it emits only closed-vocabulary outcome and duration fields. Tenant, actor, request data, audit payloads, and exception text are not telemetry dimensions.

## Assurance limits

- This verifies the local Durable Object hash chain at the time of the request. It does not prove that all expected events were recorded or that the chain was never replaced wholesale.
- An `empty` result is not evidence of complete audit coverage.
- The response digest is an integrity fingerprint, not a signature, authenticated attestation, append-only evidence object, or external timestamp.
- External R2/OpenTimestamps verification remains a separate operation at `POST /v1/audit/anchor/verify`; this endpoint does not claim that an external anchor exists or is confirmed.
- The endpoint performs no writes, migrations, approval decisions, or sensitive actions. Existing SafetyInterlock and human-approval gates remain unchanged.

## Validation

The focused tests cover role enforcement, GET-only behavior, tenant-override rejection, tenant-bound Durable Object selection, intact/empty/mismatch states, missing and malformed dependencies, exception redaction, trace correlation, and telemetry sink failure isolation.
