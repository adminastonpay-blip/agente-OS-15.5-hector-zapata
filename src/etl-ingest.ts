import type { Env, Identity } from "./types";

const TENANT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_ETL_TEXT_LENGTH = 64_000;

type JsonResponse = (data: unknown, status?: number) => Response;

/**
 * Enqueue ETL work only for a verified Cloudflare Access identity.
 * Tenant and actor are derived from the authenticated identity, never the body.
 */
export async function handleETLIngest(
  req: Request,
  env: Env,
  identity: Identity,
  json: JsonResponse,
): Promise<Response> {
  if (identity.method !== "access") {
    return json({ ok: false, error: "verified_access_identity_required" }, 403);
  }
  if (!identity.roles.includes("admin") && !identity.roles.includes("executor")) {
    return json({ ok: false, error: "privileged_role_required" }, 403);
  }
  if (!TENANT_PATTERN.test(identity.tenant) || !identity.actor.trim()) {
    return json({ ok: false, error: "trusted_tenant_identity_required" }, 403);
  }
  if (!env.ETL_QUEUE) {
    return json({ ok: false, error: "etl_queue_unavailable" }, 503);
  }

  const body = await req.json<any>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "invalid_etl_payload" }, 400);
  }
  if (Object.prototype.hasOwnProperty.call(body, "tenant") ||
      Object.prototype.hasOwnProperty.call(body, "actor")) {
    return json({ ok: false, error: "tenant_and_actor_must_come_from_verified_identity" }, 400);
  }
  if (typeof body.text !== "string" || !body.text.trim() ||
      body.text.length > MAX_ETL_TEXT_LENGTH) {
    return json({ ok: false, error: "etl_text_required_or_too_large", max_length: MAX_ETL_TEXT_LENGTH }, 400);
  }

  const source = typeof body.source === "string" && body.source.trim()
    ? body.source.trim()
    : "api";
  if (source.length > 200) {
    return json({ ok: false, error: "etl_source_too_long" }, 400);
  }
  const kind = typeof body.kind === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(body.kind)
    ? body.kind
    : "ingest";

  try {
    await env.ETL_QUEUE.send({
      tenant: identity.tenant,
      actor: identity.actor,
      text: body.text.trim(),
      source,
      kind,
    });
    return json({ ok: true, status: "queued" }, 202);
  } catch {
    return json({ ok: false, error: "etl_enqueue_failed" }, 503);
  }
}
