import type { Env, Identity } from "../types";
import { generateAgentIdentity, pqRuntimeProbe, signAction } from "../crypto/pq";
import { sovereignStatus, tenantKey, planFromIdentity } from "../lib/sovereign";
import { modelsFor } from "../lib/ai-router";

export async function handleSovereign(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/sovereign/status" && req.method === "GET") {
    const status = await sovereignStatus(env);
    return json({
      ok: true,
      tenant: identity.tenant,
      plan: planFromIdentity(identity, req.headers.get("X-Aston-Plan")),
      ...status,
    });
  }

  if (path === "/v1/sovereign/tenant" && req.method === "GET") {
    const plan = planFromIdentity(identity, req.headers.get("X-Aston-Plan"));
    return json({
      ok: true,
      tenant: identity.tenant,
      plan,
      do_keys: {
        session: tenantKey(identity, "session"),
        graph: tenantKey(identity, "graph"),
        safety: tenantKey(identity, "safety"),
      },
      isolation: "logical-do-namespace",
      next: "Workers for Platforms dispatch namespace per customer",
    });
  }

  if (path === "/v1/crypto/pq" && req.method === "GET") {
    return json({ ok: true, ...(await pqRuntimeProbe()) });
  }

  if (path === "/v1/crypto/identity" && req.method === "POST") {
    const id = await generateAgentIdentity();
    return json({
      ok: true,
      algorithm: id.algorithm,
      kem: id.kem,
      note: id.kem
        ? "PQC keys generated in this isolate"
        : "PQC unavailable — ECDSA fallback; confirm webcrypto_modern_algorithms flag after deploy",
    });
  }

  if (path === "/v1/crypto/sign" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const payload = String(body.payload || body.message || "");
    if (!payload) return json({ ok: false, error: "payload required" }, 400);
    const id = await generateAgentIdentity();
    if (!id.signingKeys || !("privateKey" in id.signingKeys)) {
      return json({ ok: false, error: "no signing key" }, 500);
    }
    const signed = await signAction(
      (id.signingKeys as CryptoKeyPair).privateKey,
      payload
    );
    return json({
      ok: true,
      ...signed,
      payload_sha256: await sha256hex(payload),
      tenant: identity.tenant,
    });
  }

  // Sandbox: proxy to SafetyInterlock fail-closed path
  if (path === "/v1/sandbox/exec" && req.method === "POST") {
    if (!env.SAFETY) {
      return json({
        ok: false,
        error: "SAFETY DO not bound",
        note: "Sandbox requires SafetyInterlock + future Containers binding",
      }, 503);
    }
    const body = await req.json<any>().catch(() => ({}));
    const stub = env.SAFETY.get(env.SAFETY.idFromName(tenantKey(identity, "safety")));
    const res = await stub.fetch("https://do/sandbox/exec", {
      method: "POST",
      body: JSON.stringify({
        code: body.code || "",
        language: body.language || "javascript",
        identity,
        timeout_ms: body.timeout_ms || 5000,
      }),
    });
    return json({ ok: res.ok, ...(await res.json<any>()) }, res.ok ? 200 : res.status);
  }

  if (path === "/v1/ai/routes" && req.method === "GET") {
    return json({
      ok: true,
      gateway: env.AI_GATEWAY_ID || null,
      chat_fast: modelsFor(env, "chat_fast"),
      chat_quality: modelsFor(env, "chat_quality"),
      embed: modelsFor(env, "embed"),
    });
  }

  return null;
}

async function sha256hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
