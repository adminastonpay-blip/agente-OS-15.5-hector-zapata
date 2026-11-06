import type { Env, Identity } from "../types";
import { recordDecision, replayDecision, getPackage, impactByEvidenceHash } from "../provenance/replay";
import { getCertificate } from "../provenance/certificate";
import { buildConstitution, checkConstitution } from "../provenance/constitution";

export async function handleProvenance(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  // Record + optional model run + certificate
  if (path === "/v1/provenance/decide" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const question = String(body.question || body.message || "").trim();
    if (!question) return json({ ok: false, error: "question required" }, 400);
    try {
      const pkg = await recordDecision(env, identity, {
        question,
        evidence: Array.isArray(body.evidence) ? body.evidence : undefined,
        data_snapshot: body.data_snapshot,
        prompts: body.prompts,
        ontology_version: body.ontology_version,
        policy_version: body.policy_version,
        model: body.model,
        agent_id: body.agent_id,
        constitution_id: body.constitution_id,
        human_approver: body.human_approver,
        outcome: body.outcome,
        run_model: body.run_model !== false && !body.outcome,
      });
      return json({
        ok: true,
        package_id: pkg.package_id,
        package_hash: pkg.package_hash,
        outcome: pkg.outcome,
        certificate: pkg.certificate,
        note: "Decision Provenance Layer — replay via POST /v1/provenance/replay",
      });
    } catch (e: any) {
      return json(
        { ok: false, error: String(e?.message || e).slice(0, 250) },
        502
      );
    }
  }

  if (path === "/v1/provenance/replay" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const package_id = String(body.package_id || body.id || "");
    if (!package_id) return json({ ok: false, error: "package_id required" }, 400);
    const result = await replayDecision(env, identity, package_id);
    return json(result, result.ok ? 200 : 404);
  }

  if (path === "/v1/provenance/package" && req.method === "GET") {
    const u = new URL(req.url);
    const id = u.searchParams.get("id") || "";
    if (!id) return json({ ok: false, error: "id required" }, 400);
    const pkg = await getPackage(env, identity.tenant || "default", id);
    if (!pkg) return json({ ok: false, error: "not found" }, 404);
    return json({ ok: true, package: pkg });
  }

  if (path === "/v1/provenance/certificate" && req.method === "GET") {
    const u = new URL(req.url);
    const id = u.searchParams.get("id") || "";
    if (!id) return json({ ok: false, error: "id required" }, 400);
    const cert = await getCertificate(env, identity.tenant || "default", id);
    if (!cert) return json({ ok: false, error: "not found" }, 404);
    return json({ ok: true, certificate: cert });
  }

  if (path === "/v1/provenance/impact" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const evidence_hash = String(body.evidence_hash || "");
    if (!evidence_hash) return json({ ok: false, error: "evidence_hash required" }, 400);
    const ids = await impactByEvidenceHash(env, identity.tenant || "default", evidence_hash);
    return json({ ok: true, affected_packages: ids, count: ids.length });
  }

  // Agent constitution
  if (path === "/v1/constitution" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const agent_id = String(body.agent_id || `agent_${crypto.randomUUID().slice(0, 8)}`);
    const objective = String(body.objective || "Assist with governed decisions").slice(0, 500);
    const c = buildConstitution({
      agent_id,
      objective,
      allowed_tools: body.allowed_tools,
      budget: body.budget,
      risk: body.risk,
    });
    if (env.DB) {
      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS agent_constitutions (
            id TEXT PRIMARY KEY,
            tenant TEXT,
            payload TEXT,
            created_at INTEGER
          )`
        ).run();
        await env.DB.prepare(
          `INSERT OR REPLACE INTO agent_constitutions (id, tenant, payload, created_at) VALUES (?, ?, ?, ?)`
        )
          .bind(agent_id, identity.tenant || "default", JSON.stringify(c), c.created_at)
          .run();
      } catch (e) {
        console.error("[CONST]", String(e));
      }
    }
    return json({ ok: true, constitution: c });
  }

  if (path === "/v1/constitution/check" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    if (!body.constitution) return json({ ok: false, error: "constitution required" }, 400);
    const result = checkConstitution(body.constitution, {
      calls: Number(body.calls) || 0,
      cost_usdc: Number(body.cost_usdc) || 0,
      writes: Number(body.writes) || 0,
      wall_ms: Number(body.wall_ms) || 0,
      risk_score: Number(body.risk_score) || 0,
      tool: String(body.tool || "reason"),
    });
    return json({ ok: true, ...result });
  }

  if (path === "/v1/provenance/status" && req.method === "GET") {
    return json({
      ok: true,
      layer: "Decision Provenance",
      ip_assets: [
        "Decision Replay Engine",
        "Certified Decision Certificates",
        "Agent Constitutions",
        "Evidence impact index",
      ],
      endpoints: {
        decide: "POST /v1/provenance/decide",
        replay: "POST /v1/provenance/replay",
        package: "GET /v1/provenance/package?id=",
        certificate: "GET /v1/provenance/certificate?id=",
        impact: "POST /v1/provenance/impact",
        constitution: "POST /v1/constitution",
      },
      category: "Sovereign Decision OS — trust kernel for agent economy",
    });
  }

  return null;
}
