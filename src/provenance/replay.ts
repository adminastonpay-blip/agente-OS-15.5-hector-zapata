/**
 * Decision Replay Engine — record full decision packages and verify reproducibility.
 */
import type { Env, Identity } from "../types";
import { chat } from "../lib/ai";
import { hashObject, canonicalJson, sha256Hex } from "./hash";
import { issueCertificate, type DecisionCertificate } from "./certificate";

export interface DecisionPackage {
  package_id: string;
  tenant: string;
  question: string;
  ontology_version: string;
  policy_version: string;
  model: string;
  prompts: { role: string; content: string }[];
  evidence: unknown[];
  data_snapshot?: Record<string, unknown>;
  agent_id?: string;
  constitution_id?: string;
  human_approver?: string | null;
  outcome?: string;
  outcome_hash?: string;
  package_hash: string;
  certificate?: DecisionCertificate;
  created_at: number;
  created_by: string;
}

export async function recordDecision(
  env: Env,
  identity: Identity,
  input: {
    question: string;
    evidence?: unknown[];
    data_snapshot?: Record<string, unknown>;
    prompts?: { role: string; content: string }[];
    ontology_version?: string;
    policy_version?: string;
    model?: string;
    agent_id?: string;
    constitution_id?: string;
    human_approver?: string | null;
    outcome?: string;
    run_model?: boolean;
  }
): Promise<DecisionPackage> {
  const package_id = `pkg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const model = input.model || env.CHAT_MODEL || "unknown";
  const evidence = input.evidence ?? [];
  const prompts = input.prompts ?? [
    {
      role: "system",
      content:
        "ASTON Decision Provenance. Respondé con la decisión y justificación breve. No inventes evidencia.",
    },
    { role: "user", content: input.question },
  ];

  let outcome = input.outcome;
  if (!outcome && input.run_model !== false && env.AI) {
    try {
      const out = await chat(env, identity, prompts, { max_tokens: 512, temp: 0 });
      outcome = out.response;
    } catch (e: any) {
      outcome = `error:${String(e?.message || e).slice(0, 120)}`;
    }
  }
  outcome = outcome || "no_outcome";

  const body = {
    question: input.question,
    ontology_version: input.ontology_version || "onto-v1",
    policy_version: input.policy_version || "policy-v1",
    model,
    prompts,
    evidence,
    data_snapshot: input.data_snapshot ?? {},
    agent_id: input.agent_id,
    constitution_id: input.constitution_id,
    human_approver: input.human_approver ?? null,
    outcome,
  };
  const package_hash = await hashObject(body);
  const outcome_hash = await hashObject(outcome);

  const cert = await issueCertificate(env, identity, {
    question: input.question,
    outcome,
    evidence,
    policy_version: body.policy_version,
    ontology_version: body.ontology_version,
    model,
    agent_id: input.agent_id,
    human_approver: input.human_approver,
    constitution_id: input.constitution_id,
    context: {
      package_id,
      package_hash,
      data_snapshot: body.data_snapshot,
    },
  });

  const pkg: DecisionPackage = {
    package_id,
    tenant: identity.tenant || "default",
    ...body,
    outcome_hash,
    package_hash,
    certificate: cert,
    created_at: Date.now(),
    created_by: identity.actor,
  };

  await persistPackage(env, pkg);
  return pkg;
}

export async function replayDecision(
  env: Env,
  identity: Identity,
  package_id: string
): Promise<{
  ok: boolean;
  package_id: string;
  original_outcome_hash?: string;
  replay_outcome_hash?: string;
  match?: boolean;
  replay_outcome?: string;
  error?: string;
}> {
  const pkg = await getPackage(env, identity.tenant || "default", package_id);
  if (!pkg) return { ok: false, package_id, error: "package not found" };

  if (!env.AI) {
    return { ok: false, package_id, error: "AI required for replay" };
  }

  try {
    // Deterministic-ish: temperature 0, same prompts
    const out = await chat(env, identity, pkg.prompts, { max_tokens: 512, temp: 0 });
    const replay_outcome = out.response || "";
    const replay_outcome_hash = await hashObject(replay_outcome);
    const original_outcome_hash = pkg.outcome_hash || (await hashObject(pkg.outcome || ""));
    const match = replay_outcome_hash === original_outcome_hash;

    // Also verify package hash integrity
    const recompute = await hashObject({
      question: pkg.question,
      ontology_version: pkg.ontology_version,
      policy_version: pkg.policy_version,
      model: pkg.model,
      prompts: pkg.prompts,
      evidence: pkg.evidence,
      data_snapshot: pkg.data_snapshot ?? {},
      agent_id: pkg.agent_id,
      constitution_id: pkg.constitution_id,
      human_approver: pkg.human_approver ?? null,
      outcome: pkg.outcome,
    });

    return {
      ok: true,
      package_id,
      original_outcome_hash,
      replay_outcome_hash,
      match,
      replay_outcome: replay_outcome.slice(0, 1500),
      ...(recompute !== pkg.package_hash
        ? { error: "package_hash_mismatch_storage_integrity" }
        : {}),
    };
  } catch (e: any) {
    return { ok: false, package_id, error: String(e?.message || e).slice(0, 200) };
  }
}

async function persistPackage(env: Env, pkg: DecisionPackage) {
  if (env.DB) {
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS decision_packages (
          id TEXT PRIMARY KEY,
          tenant TEXT,
          package_hash TEXT,
          payload TEXT,
          created_at INTEGER
        )`
      ).run();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO decision_packages (id, tenant, package_hash, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(pkg.package_id, pkg.tenant, pkg.package_hash, JSON.stringify(pkg), pkg.created_at)
        .run();
    } catch (e) {
      console.error("[PKG_PERSIST]", String(e));
    }
  }
  if (env.JOURNAL) {
    try {
      await env.JOURNAL.put(
        `catalog/${pkg.tenant}/decision/${pkg.package_id}.json`,
        JSON.stringify(pkg),
        { httpMetadata: { contentType: "application/json" } }
      );
    } catch {
      /* optional */
    }
  }
}

export async function getPackage(
  env: Env,
  tenant: string,
  id: string
): Promise<DecisionPackage | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT payload FROM decision_packages WHERE id = ? AND tenant = ?`
    )
      .bind(id, tenant)
      .first<{ payload: string }>();
    if (!row?.payload) return null;
    return JSON.parse(row.payload) as DecisionPackage;
  } catch {
    return null;
  }
}

export async function impactByEvidenceHash(
  env: Env,
  tenant: string,
  evidenceHash: string
): Promise<string[]> {
  if (!env.DB) return [];
  try {
    const rows = await env.DB.prepare(
      `SELECT id, payload FROM decision_packages WHERE tenant = ? ORDER BY created_at DESC LIMIT 100`
    )
      .bind(tenant)
      .all();
    const ids: string[] = [];
    for (const r of (rows.results || []) as any[]) {
      try {
        const p = JSON.parse(r.payload) as DecisionPackage;
        const hashes = p.certificate?.evidence_hashes || [];
        if (hashes.includes(evidenceHash)) ids.push(p.package_id);
      } catch {
        /* skip */
      }
    }
    return ids;
  } catch {
    return [];
  }
}
