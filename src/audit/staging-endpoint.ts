import type { Env, Identity } from "../types";

const ROUTE = "/v1/audit-target";
const MAX_BODY_BYTES = 8 * 1024;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,63}$/;
const CASE_ID = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;

type ChatHandler = (req: Request, env: Env) => Promise<Response>;

async function boundedBody(req: Request): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel("audit_body_too_large");
        throw new Error("audit_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function equalSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b || a.length !== b.length) return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Staging-only diagnostic harness. It reports the current public chat path's
 * control gaps instead of claiming that a separate preflight protects it.
 */
export async function handleStagingAudit(
  req: Request,
  env: Env,
  chatHandler: ChatHandler
): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== ROUTE) return null;
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (
    env.AUDIT_ENABLED !== "true" ||
    !String(env.DEPLOY_PROFILE || "").toLowerCase().includes("staging")
  ) {
    return json({ ok: false, error: "not_found" }, 404);
  }
  if (!env.AUDIT_SECRET || env.AUDIT_SECRET.length < 32 || !env.SAFETY || !env.AI) {
    return json({ ok: false, error: "audit_staging_not_configured" }, 503);
  }

  const supplied = req.headers.get("x-audit-token") || "";
  if (!(await equalSecret(supplied, env.AUDIT_SECRET))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "request_too_large" }, 413);
  }

  let body: any;
  try {
    body = JSON.parse(await boundedBody(req));
  } catch (error) {
    const message = String((error as Error)?.message || error);
    return json(
      { ok: false, error: message === "audit_body_too_large" ? message : "invalid_json" },
      message === "audit_body_too_large" ? 413 : 400
    );
  }

  if (
    body?.schema_version !== "aston.audit.request.v1" ||
    typeof body.run_id !== "string" ||
    !RUN_ID.test(body.run_id) ||
    typeof body.test_case_id !== "string" ||
    !CASE_ID.test(body.test_case_id) ||
    !body.payload ||
    typeof body.payload !== "object" ||
    Array.isArray(body.payload) ||
    Object.keys(body.payload).some((key: string) => key !== "message") ||
    typeof body.payload.message !== "string" ||
    body.payload.message.length < 1 ||
    body.payload.message.length > 4000
  ) {
    return json({ ok: false, error: "invalid_audit_case_schema" }, 400);
  }

  const safety = env.SAFETY.get(env.SAFETY.idFromName("aston-audit-staging"));
  const claimResponse = await safety.fetch("https://do/audit/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      run_id: body.run_id,
      case_id: body.test_case_id,
    }),
  });
  const claim = await claimResponse.json<any>().catch(() => ({}));
  if (!claimResponse.ok || claim.status !== "claimed") {
    return json(
      { ok: false, error: claim.error || "audit_claim_rejected", claim },
      claimResponse.status || 503
    );
  }

  const auditIdentity: Identity = {
    actor: "trust-fabric-audit",
    method: "apikey",
    tenant: "aston-audit-staging",
    roles: ["auditor"],
    clearance: "internal",
  };
  const policyResponse = await safety.fetch("https://do/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: {
        tool: "audit_chat_observation",
        args: { message_length: body.payload.message.length },
        context: { objective: "non-destructive staging audit" },
      },
      identity: auditIdentity,
    }),
  });
  const policy = await policyResponse.json<any>().catch(() => ({}));
  if (!policyResponse.ok || policy.status !== "allowed") {
    return json({
      ok: false,
      run_id: body.run_id,
      test_case_id: body.test_case_id,
      error: "safety_preflight_did_not_allow",
      policy,
      observation: null,
    }, 403);
  }

  const sessionHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body.run_id + ":" + body.test_case_id)
  );
  const sessionId = "audit-" + Array.from(new Uint8Array(sessionHash))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  // One model invocation maximum per audit case. Disable session persistence,
  // D1, queues, R2 and AI Gateway for this diagnostic call.
  let modelCalls = 0;
  const boundedAI = {
    run: async (model: any, inputs: any, options?: any) => {
      if (modelCalls >= 1) throw new Error("audit_model_call_budget_exceeded");
      modelCalls += 1;
      return env.AI!.run(model, inputs, options);
    },
  };
  const isolatedEnv: Env = {
    ...env,
    AI: boundedAI as unknown as Ai,
    AI_GATEWAY_ID: undefined,
    SESSION: undefined,
    DB: undefined,
    ETL_QUEUE: undefined,
    MISSIONS: undefined,
    JOURNAL: undefined,
    VECTORIZE: undefined,
    HYPERDRIVE: undefined,
  };
  const chatResponse = await chatHandler(
    new Request("https://aston-audit-staging.invalid/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: body.payload.message,
        session_id: sessionId,
      }),
    }),
    isolatedEnv
  );
  const chatObservation = await chatResponse.json<any>().catch(() => ({
    ok: false,
    error: "chat_response_not_json",
  }));

  return json({
    ok: true,
    schema_version: "aston.audit.observation.v1",
    run_id: body.run_id,
    test_case_id: body.test_case_id,
    target_version: env.DEPLOY_PROFILE || "unknown",
    policy_preflight: {
      status: policy.status,
      decision: policy.policy?.decision,
      risk: policy.policy?.risk,
      score: policy.policy?.score,
    },
    observation: {
      http_status: chatResponse.status,
      ok: chatResponse.ok,
      answer: typeof chatObservation.answer === "string" ? chatObservation.answer : null,
      model: chatObservation.model || null,
      error: chatObservation.error || null,
    },
    control_coverage: {
      safety_interlock_preflight: "executed_separately",
      existing_public_chat_uses_safety_interlock: false,
      input_guard_on_existing_chat_path: "not_verified",
      output_guard_on_existing_chat_path: "not_present_in_inspected_handler",
      tool_execution: "not_invoked",
      model_invocations_per_case: 1,
      persistence_and_external_data_bindings: "disabled_for_chat_call",
      verdict: "evaluator_required",
    },
  }, chatResponse.ok ? 200 : 502);
}
