# ASTON OS — External audit verification observability

## Endpoint

`POST /v1/audit/anchor/verify`

This increment wraps the existing external R2/OpenTimestamps verification path with an operation-level span and a sanitized evidence envelope. It does not create, stamp, mutate, or approve an audit checkpoint.

## Authorization and tenant isolation

- The central API boundary requires a verified non-public identity with an `admin` or `executor` role for POST requests.
- The handler independently enforces the same privileged-role requirement.
- The Durable Object is selected only from `identity.tenant`.
- The request accepts only `event_count`; any caller-supplied tenant or extra field is rejected.
- No tenant ID, tenant hash, actor, proof bytes, manifest contents, or verifier exception is returned or emitted as telemetry.

## Verification contract

The handler accepts success only when the SafetyInterlock response has all of the following: `ok=true`, `integrity=true`, the exact requested event count, a 64-character lowercase root hash, a positive safe-integer Bitcoin block height, and a boolean local-state indicator. An optional Bitcoin timestamp must be a non-negative safe integer.

The Worker does not implement OpenTimestamps cryptography itself. It trusts the separately deployed `OTS_VERIFIER` service binding to verify the proof against Bitcoin headers and the exact checkpoint bytes. A missing binding, pending proof, unavailable verifier, malformed response, or mismatched root fails closed.

## Operation telemetry and evidence

The closed operation name is `audit.external_anchor_verify`. Its child span is parented to the request trace and records only bounded operation name, outcome, duration, and deployment profile. Telemetry is best-effort and cannot change the verification result.

The response adds request/child operation IDs and a SHA-256 digest over sanitized verification fields. The digest is ephemeral and is not a signature, durable attestation, append-only record, WORM guarantee, or external timestamp.

## Validation

The focused test suite covers role enforcement, method restrictions, strict request schema, tenant-bound Durable Object selection, confirmed proof contract, missing/mismatched/unavailable states, malformed verifier responses, exception redaction, trace correlation, and telemetry sink failure isolation.

## Deployment boundary

Code and CI validation do not prove that the R2 bucket lock rules, `AUDIT_ARCHIVE` binding, `OTS_VERIFIER` service, GitHub R2 secrets, or Bitcoin confirmation are live. Those remain staging acceptance gates. No Cloudflare resources, secrets, production routes, or Shopify settings are changed by this increment.
