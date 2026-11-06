/**
 * Certified Decision Certificate — signed, verifiable decision record.
 */
import type { Env, Identity } from "../types";
import { generateAgentIdentity, signAction } from "../crypto/pq";
import { canonicalJson, hashObject, sha256Hex } from "./hash";

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
  signature?: string;
  sig_alg?: string;
  replay_key: string;
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
  const replay_key = await sha256Hex(
    `${input_hash}:${context_hash}:${input.policy_version || "v1"}:${input.model || env.CHAT_MODEL}`
  );

  const cert: DecisionCertificate = {
    certificate_version: "1.0",
    decision_id,
    question: String(input.question).slice(0, 2000),
    outcome: String(input.outcome).slice(0, 2000),
    evidence_hashes,
    policy_version: input.policy_version || "policy-v1",
    ontology_version: input.ontology_version || "onto-v1",
    model: input.model || env.CHAT_MODEL || "unknown",
    agent_id: input.agent_id,
    human_approver: input.human_approver ?? null,
    constitution_id: input.constitution_id ?? null,
    input_hash,
    context_hash,
    tenant: identity.tenant || "default",
    actor: identity.actor,
    issued_at: Date.now(),
    replay_key,
  };

  try {
    const keys = await generateAgentIdentity();
    if (keys.signingKeys && "privateKey" in keys.signingKeys) {
      const payload = canonicalJson({
        decision_id: cert.decision_id,
        input_hash: cert.input_hash,
        context_hash: cert.context_hash,
        outcome: cert.outcome,
        replay_key: cert.replay_key,
        issued_at: cert.issued_at,
      });
      const signed = await signAction((keys.signingKeys as CryptoKeyPair).privateKey, payload);
      cert.signature = signed.signature;
      cert.sig_alg = signed.alg;
    }
  } catch {
    /* signature optional if crypto unavailable */
  }

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
