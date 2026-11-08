/**
 * Certified Decision Certificate + HMAC Decision Passport (stable verification).
 */
import type { Env, Identity } from "../types";
import { canonicalJson, hashObject, sha256Hex } from "./hash";
import { issuePassport, type DecisionPassport } from "../trust/hmac-passport";

export interface DecisionCertificate {
  certificate_version: "1.0";
  decision_id: string;
  question: string;
  outcome: string;
  evidence_hashes: string[];
  policy_version: string;
  ontology_version: string;
  model: string;
  agent_id?: string;
  human_approver?: string | null;
  constitution_id?: string | null;
  input_hash: string;
  context_hash: string;
  tenant: string;
  actor: string;
  issued_at: number;
  /** @deprecated ephemeral asymmetric sig — prefer passport */
  signature?: string;
  sig_alg?: string;
  replay_key: string;
  /** Stable HMAC passport for independent verification */
  passport?: DecisionPassport | null;
  trust_note?: string;
}

export async function issueCertificate(
  env: Env,
  identity: Identity,
  input: {
    question: string;
    outcome: string;
    evidence?: unknown[];
    policy_version?: string;
    ontology_version?: string;
    model?: string;
    agent_id?: string;
    human_approver?: string | null;
    constitution_id?: string | null;
    context?: Record<string, unknown>;
  }
): Promise<DecisionCertificate> {
  const decision_id = `dec_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const evidence = input.evidence ?? [];
  const evidence_hashes: string[] = [];
  for (const e of evidence.slice(0, 32)) {
    evidence_hashes.push(await hashObject(e));
  }

  const context = input.context ?? {};
  const input_hash = await hashObject({
    question: input.question,
    outcome: input.outcome,
    evidence_hashes,
  });
  const context_hash = await hashObject(context);
  const model = input.model || env.CHAT_MODEL || "unknown";
  const replay_key = await sha256Hex(
    `${input_hash}:${context_hash}:${input.policy_version || "v1"}:${model}`
  );
  const issued_at = Date.now();

  const cert: DecisionCertificate = {
    certificate_version: "1.0",
    decision_id,
    question: String(input.question).slice(0, 2000),
    outcome: String(input.outcome).slice(0, 2000),
    evidence_hashes,
    policy_version: input.policy_version || "policy-v1",
    ontology_version: input.ontology_version || "onto-v1",
    model,
    agent_id: input.agent_id,
    human_approver: input.human_approver ?? null,
    constitution_id: input.constitution_id ?? null,
    input_hash,
    context_hash,
    tenant: identity.tenant || "default",
    actor: identity.actor,
    issued_at,
    replay_key,
  };

  // Stable passport (HMAC with deploy secret) — independently verifiable
  const passport = await issuePassport(env, {
    decision_id,
    tenant: cert.tenant,
    actor: cert.actor,
    question: cert.question,
    outcome: cert.outcome,
    evidence_hashes,
    input_hash,
    context_hash,
    replay_key,
    model,
    issued_at,
  });
  cert.passport = passport;
  cert.trust_note = passport
    ? "HMAC-SHA256 passport issued; verify via POST /v1/trust/verify"
    : "No PII_HMAC_SECRET/API_KEY — passport not issued; set secret for verifiable certificates";

  await persistCertificate(env, cert);
  return cert;
}

async function persistCertificate(env: Env, cert: DecisionCertificate) {
  if (env.DB) {
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS decision_certificates (
          id TEXT PRIMARY KEY,
          tenant TEXT,
          replay_key TEXT,
          payload TEXT,
          issued_at INTEGER
        )`
      ).run();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO decision_certificates (id, tenant, replay_key, payload, issued_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(cert.decision_id, cert.tenant, cert.replay_key, JSON.stringify(cert), cert.issued_at)
        .run();
    } catch (e) {
      console.error("[CERT_PERSIST]", String(e));
    }
  }
  if (env.JOURNAL) {
    try {
      await env.JOURNAL.put(
        `catalog/${cert.tenant}/cert/${cert.decision_id}.json`,
        JSON.stringify(cert),
        { httpMetadata: { contentType: "application/json" } }
      );
    } catch {
      /* optional */
    }
  }
}

export async function getCertificate(
  env: Env,
  tenant: string,
  id: string
): Promise<DecisionCertificate | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT payload FROM decision_certificates WHERE id = ? AND tenant = ?`
    )
      .bind(id, tenant)
      .first<{ payload: string }>();
    if (!row?.payload) return null;
    return JSON.parse(row.payload) as DecisionCertificate;
  } catch {
    return null;
  }
}
