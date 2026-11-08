/**
 * Single insignia demo: identify → authorize → budget → execute → passport → verify
 */
import type { Env, Identity } from "../types";
import { issueCertificate } from "../provenance/certificate";
import { verifyPassport } from "./hmac-passport";
import { defaultConstitution, evaluateConstitution } from "./constitution";
import { newTrace, advance, type DecisionTrace } from "./decision-lifecycle";
import { estimateChatCost } from "./economic-passport";

export async function runTrustE2E(
  env: Env,
  identity: Identity,
  input: { goal?: string; action?: string; exposure?: number }
) {
  const goal = (input.goal || "Evaluar riesgo de operación de prueba").slice(0, 500);
  const action = input.action || "analyze";
  const exposure = Number(input.exposure) || 100;
  const decision_id = `e2e_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let trace: DecisionTrace = newTrace(decision_id);

  // IDENTIFY
  trace = advance(trace, "IDENTIFIED", `actor=${identity.actor};tenant=${identity.tenant}`);

  // AUTHORIZE via constitution
  const constitution = defaultConstitution(identity.actor || "public-agent", identity.tenant);
  const cv = evaluateConstitution(constitution, {
    action,
    object_type: "decision",
    estimated_exposure: exposure,
  });
  if (!cv.allowed) {
    trace = advance(trace, "DENIED", cv.reasons.join(","));
    return {
      ok: false,
      stage: "authorize",
      decision_id,
      trace,
      constitution: cv,
      error: "constitution_deny",
    };
  }
  trace = advance(trace, "AUTHORIZED", cv.constitution_id);

  // BUDGET
  const budget_usd = 1.0;
  if (exposure > constitution.max_exposure_usd) {
    trace = advance(trace, "DENIED", "budget_exposure");
    return { ok: false, stage: "budget", decision_id, trace, error: "exposure_cap" };
  }
  trace = advance(trace, "BUDGET_RESERVED", `budget_usd=${budget_usd}`);

  // EXECUTE (synthetic outcome — no irreversible side effect)
  const t0 = Date.now();
  trace = advance(trace, "EXECUTING");
  const outcome = `Decisión gobernada: ${goal} | action=${action} | exposure_usd=${exposure} | tenant=${identity.tenant}`;
  const latency_ms = Date.now() - t0;
  trace = advance(trace, "EXECUTED", outcome.slice(0, 120));

  // VERIFY + RECORD (certificate + HMAC passport)
  const cert = await issueCertificate(env, identity, {
    question: goal,
    outcome,
    evidence: [{ type: "e2e", decision_id, constitution_id: cv.constitution_id }],
    agent_id: constitution.agent_id,
    constitution_id: cv.constitution_id,
    context: { exposure, action, lifecycle: trace.states },
  });
  const passportOk = cert.passport
    ? await verifyPassport(env, cert.passport)
    : { ok: false, reason: "no_passport" };
  trace = advance(
    trace,
    passportOk.ok ? "VERIFIED" : "FAILED",
    passportOk.ok ? "passport_ok" : passportOk.reason
  );
  if (passportOk.ok) {
    trace = advance(trace, "EVIDENCE_STORED", cert.decision_id);
    // OTS not claimed
    trace = advance(trace, "TIMESTAMP_PENDING", "ots_not_configured");
  }

  const economic = estimateChatCost({
    decision_id: cert.decision_id,
    model: env.CHAT_MODEL || "n/a",
    messageChars: goal.length,
    responseChars: outcome.length,
    latency_ms,
    budget_usd,
  });

  return {
    ok: passportOk.ok,
    decision_id: cert.decision_id,
    trace,
    constitution: { id: cv.constitution_id, require_human: cv.require_human },
    certificate_id: cert.decision_id,
    passport: cert.passport,
    passport_verified: passportOk,
    economic,
    ots: { status: "TIMESTAMP_PENDING", note: "OpenTimestamps not integrated — do not claim confirmed" },
    trust_note: cert.trust_note,
  };
}
