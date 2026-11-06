/**
 * Sovereign Agent Reputation Registry — trust passport for agents.
 */
import type { Env, Identity } from "../types";
import { generateAgentIdentity, signAction, pqRuntimeProbe } from "../crypto/pq";

export interface AgentPassport {
  agent_id: string;
  tenant: string;
  display_name: string;
  trust_score: number;
  status: "probation" | "trusted" | "restricted" | "revoked";
  capabilities: string[];
  attestations: string[];
  algorithm: string;
  created_at: number;
  updated_at: number;
  signature?: string;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export async function issuePassport(
  env: Env,
  identity: Identity,
  opts: { agent_id?: string; display_name?: string; capabilities?: string[] }
): Promise<AgentPassport> {
  const agent_id =
    (opts.agent_id || `agent_${crypto.randomUUID().slice(0, 10)}`).slice(0, 64);
  const pq = await pqRuntimeProbe();
  const keys = await generateAgentIdentity();

  const passport: AgentPassport = {
    agent_id,
    tenant: identity.tenant || "default",
    display_name: (opts.display_name || agent_id).slice(0, 80),
    trust_score: 50,
    status: "probation",
    capabilities: (opts.capabilities || ["factory.run", "chat"]).slice(0, 20),
    attestations: [
      pq.ml_dsa ? "pqc-capable" : "classical-crypto",
      "edge-issued",
    ],
    algorithm: keys.algorithm,
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  if (keys.signingKeys && "privateKey" in keys.signingKeys) {
    const payload = JSON.stringify({
      agent_id: passport.agent_id,
      tenant: passport.tenant,
      trust_score: passport.trust_score,
      ts: passport.created_at,
    });
    const sig = await signAction((keys.signingKeys as CryptoKeyPair).privateKey, payload);
    passport.signature = sig.signature;
    passport.algorithm = sig.alg;
  }

  await savePassport(env, passport);
  return passport;
}

export async function recordEvent(
  env: Env,
  agent_id: string,
  tenant: string,
  event: "success" | "failure" | "abuse" | "certified"
): Promise<AgentPassport | null> {
  const p = await getPassport(env, tenant, agent_id);
  if (!p) return null;
  if (event === "success") p.trust_score = clamp(p.trust_score + 2, 0, 100);
  if (event === "certified") p.trust_score = clamp(p.trust_score + 5, 0, 100);
  if (event === "failure") p.trust_score = clamp(p.trust_score - 3, 0, 100);
  if (event === "abuse") {
    p.trust_score = clamp(p.trust_score - 15, 0, 100);
    p.attestations.push(`abuse:${Date.now()}`);
  }
  if (p.trust_score >= 75) p.status = "trusted";
  else if (p.trust_score < 25) p.status = "restricted";
  else if (p.status !== "revoked") p.status = "probation";
  p.updated_at = Date.now();
  await savePassport(env, p);
  return p;
}

async function savePassport(env: Env, p: AgentPassport) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS agent_passports (
        agent_id TEXT PRIMARY KEY,
        tenant TEXT,
        payload TEXT,
        trust_score INTEGER,
        updated_at INTEGER
      )`
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO agent_passports (agent_id, tenant, payload, trust_score, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(p.agent_id, p.tenant, JSON.stringify(p), p.trust_score, p.updated_at)
      .run();
  } catch (e) {
    console.error("[PASSPORT]", String(e));
  }
}

export async function getPassport(
  env: Env,
  tenant: string,
  agent_id: string
): Promise<AgentPassport | null> {
  if (!env.DB) return null;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS agent_passports (
        agent_id TEXT PRIMARY KEY,
        tenant TEXT,
        payload TEXT,
        trust_score INTEGER,
        updated_at INTEGER
      )`
    ).run();
    const row = await env.DB.prepare(
      `SELECT payload FROM agent_passports WHERE agent_id = ? AND tenant = ?`
    )
      .bind(agent_id, tenant)
      .first<{ payload: string }>();
    if (!row?.payload) return null;
    return JSON.parse(row.payload) as AgentPassport;
  } catch {
    return null;
  }
}

export async function listPassports(env: Env, tenant: string): Promise<AgentPassport[]> {
  if (!env.DB) return [];
  try {
    const rows = await env.DB.prepare(
      `SELECT payload FROM agent_passports WHERE tenant = ? ORDER BY trust_score DESC LIMIT 50`
    )
      .bind(tenant)
      .all();
    return (rows.results || [])
      .map((r: any) => {
        try {
          return JSON.parse(r.payload) as AgentPassport;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as AgentPassport[];
  } catch {
    return [];
  }
}
