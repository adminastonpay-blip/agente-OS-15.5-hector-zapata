import type { Env, Identity } from "../types";

const TENANT_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const AUDIT_READ_ROLES = new Set(["admin", "executor", "auditor"]);

export async function appendTenantAuditEvent(
  env: Env,
  identity: Identity,
  eventType: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  if (
    identity.method === "public" ||
    !TENANT_ID.test(identity.tenant) ||
    !identity.actor.trim() ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("verified_tenant_identity_required");
  }
  if (!env.SAFETY) {
    if (env.AUDIT_ANCHOR_REQUIRED === "true") throw new Error("audit_safety_binding_missing");
    return false;
  }
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > 8192) {
    throw new Error("audit_payload_too_large");
  }
  const stub = env.SAFETY.get(env.SAFETY.idFromName("audit:" + identity.tenant));
  let response: Response;
  try {
    response = await stub.fetch("https://safety.internal/audit/append", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant: identity.tenant,
        actor: identity.actor,
        event_type: eventType,
        payload,
      }),
    });
  } catch {
    if (env.AUDIT_ANCHOR_REQUIRED === "true") throw new Error("audit_append_failed");
    return false;
  }
  if (!response.ok) {
    if (env.AUDIT_ANCHOR_REQUIRED === "true") throw new Error("audit_append_failed");
    return false;
  }
  return true;
}

export async function handleAuditLedger(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (data: unknown, status?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/audit") {
    return json({
      ok: false,
      error: "legacy_audit_endpoint_retired",
      replacement: "GET /v1/audit/events",
    }, 410);
  }
  if (path !== "/v1/audit/events") return null;
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (
    identity.method === "public" ||
    !identity.tenant ||
    !TENANT_ID.test(identity.tenant)
  ) {
    return json({ ok: false, error: "verified_tenant_identity_required" }, 403);
  }
  if (!identity.roles.some((role) => AUDIT_READ_ROLES.has(role))) {
    return json({ ok: false, error: "audit_reader_role_required" }, 403);
  }
  if (!env.SAFETY) return json({ ok: false, error: "audit_safety_binding_unavailable" }, 503);

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const rawBefore = url.searchParams.get("before_id");
  const beforeId = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return json({ ok: false, error: "invalid_audit_page_limit" }, 400);
  }
  if (!Number.isSafeInteger(beforeId) || beforeId < 1) {
    return json({ ok: false, error: "invalid_audit_cursor" }, 400);
  }

  const stub = env.SAFETY.get(env.SAFETY.idFromName("audit:" + identity.tenant));
  const target = new URL("https://safety.internal/audit/list");
  target.searchParams.set("tenant", identity.tenant);
  target.searchParams.set("limit", String(limit));
  target.searchParams.set("before_id", String(beforeId));
  try {
    const response = await stub.fetch(target.toString(), { method: "GET" });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || typeof body !== "object") {
      return json({ ok: false, error: "audit_ledger_read_failed" }, response.status >= 400 ? response.status : 503);
    }
    return json(body, response.status);
  } catch {
    return json({ ok: false, error: "audit_ledger_unavailable" }, 503);
  }
}
