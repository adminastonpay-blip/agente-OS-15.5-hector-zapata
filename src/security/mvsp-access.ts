import type { Identity } from "../types";

export type ApiAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: "authentication_required" | "invalid_credentials" | "privileged_role_required" };

const PUBLIC_READ_PATHS = new Set([
  "/", "/health", "/v1/capabilities", "/v1/models", "/v1/voice/profiles",
  "/v1/risk/status", "/v1/defense/status", "/v1/infra/status",
  "/v1/economy/status", "/v1/provenance/status", "/v1/sovereign/status",
  "/v1/sovereign/tenant", "/v1/crypto/pq", "/v1/ai/routes",
]);

// These POST routes are intentionally public and do not mutate tenant data,
// policy, infrastructure, or agent execution state.
const PUBLIC_POST_PATHS = new Set([
  "/chat", "/v1/chat", "/chat/stream", "/v1/chat/stream",
  "/v1/solve", "/v1/tts", "/v1/speech", "/v1/voice",
  "/v1/risk/score", "/v1/defense/triage", "/v1/constitution/check",
  "/v1/economy/quote", "/v1/crypto/identity", "/v1/crypto/sign",
  "/v1/validate",
]);

function hasPresentedCredentials(req: Request): boolean {
  return Boolean(
    req.headers.get("Cf-Access-Jwt-Assertion") ||
    req.headers.get("Authorization") ||
    req.headers.get("X-Sensor-Key")
  );
}

function isPrivileged(identity: Identity): boolean {
  return identity.method !== "public" &&
    (identity.roles.includes("admin") || identity.roles.includes("executor"));
}

/**
 * Central API boundary:
 * - public endpoints are an explicit allowlist;
 * - private reads require a verified identity;
 * - every non-public write requires an authenticated admin/executor;
 * - invalid supplied credentials never silently downgrade to public access.
 */
export function authorizeApiRequest(
  req: Request,
  path: string,
  identity: Identity
): ApiAccessDecision {
  if (identity.method === "public" && hasPresentedCredentials(req)) {
    return { allowed: false, status: 401, error: "invalid_credentials" };
  }

  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    if (PUBLIC_READ_PATHS.has(path)) return { allowed: true };
    if (identity.method === "public") {
      return { allowed: false, status: 401, error: "authentication_required" };
    }
    return { allowed: true };
  }

  if (method === "POST" && PUBLIC_POST_PATHS.has(path)) {
    return { allowed: true };
  }

  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    if (identity.method === "public") {
      return { allowed: false, status: 401, error: "authentication_required" };
    }
    if (!isPrivileged(identity)) {
      return { allowed: false, status: 403, error: "privileged_role_required" };
    }
    return { allowed: true };
  }

  // Unsupported methods are left to route handlers to return their normal 404/405.
  return { allowed: true };
}
