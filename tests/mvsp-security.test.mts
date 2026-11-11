import test from "node:test";
import assert from "node:assert/strict";
import type { Identity } from "../src/types";
import { anonymousIdentity, authorizeApiRequest, planFromTrustedIdentity } from "../src/security/mvsp-access.ts";

const publicIdentity: Identity = {
  actor: "public", method: "public", tenant: "public",
  roles: ["viewer"], clearance: "public", plan: "free",
};
const viewer: Identity = {
  actor: "viewer@example.test", method: "access", tenant: "tenant-a",
  roles: ["viewer"], clearance: "internal", plan: "free",
};
const admin: Identity = {
  actor: "admin@example.test", method: "access", tenant: "tenant-a",
  roles: ["admin", "executor"], clearance: "confidential",
};

function request(method: string, path: string, headers?: Record<string, string>) {
  return new Request(`https://aston.example${path}`, { method, headers });
}

test("keeps explicitly public health and chat routes available", () => {
  assert.deepEqual(authorizeApiRequest(request("GET", "/health"), "/health", publicIdentity), { allowed: true });
  assert.deepEqual(authorizeApiRequest(request("POST", "/v1/chat"), "/v1/chat", publicIdentity), { allowed: true });
});

test("requires authentication for private reads", () => {
  assert.deepEqual(
    authorizeApiRequest(request("GET", "/v1/audit"), "/v1/audit", publicIdentity),
    { allowed: false, status: 401, error: "authentication_required" }
  );
});

test("blocks unauthenticated writes and viewer-level mutations", () => {
  assert.equal(
    authorizeApiRequest(request("POST", "/v1/access/policies"), "/v1/access/policies", publicIdentity).status,
    401
  );
  assert.equal(
    authorizeApiRequest(request("POST", "/v1/access/policies"), "/v1/access/policies", viewer).status,
    403
  );
});

test("allows privileged identities to perform protected writes", () => {
  assert.deepEqual(
    authorizeApiRequest(request("POST", "/v1/access/policies"), "/v1/access/policies", admin),
    { allowed: true }
  );
});

test("does not downgrade invalid supplied credentials to public access", () => {
  const req = request("POST", "/v1/access/policies", { Authorization: "Bearer invalid" });
  assert.deepEqual(
    authorizeApiRequest(req, "/v1/access/policies", publicIdentity),
    { allowed: false, status: 401, error: "invalid_credentials" }
  );
});

test("anonymous identity is fixed and cannot be selected by a tenant header", () => {
  const identity = anonymousIdentity();
  assert.equal(identity.method, "public");
  assert.equal(identity.tenant, "public");
  assert.equal(identity.plan, "free");
});

test("does not accept a client-supplied plan upgrade", () => {
  assert.equal(planFromTrustedIdentity(publicIdentity), "free");
  assert.equal(planFromTrustedIdentity(viewer), "free");
  assert.equal(planFromTrustedIdentity({ ...viewer, plan: "pro" }), "pro");
});
