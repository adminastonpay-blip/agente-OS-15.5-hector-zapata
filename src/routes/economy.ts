import type { Env, Identity } from "../types";
import { issuePassport, getPassport, listPassports, recordEvent } from "../economy/reputation";
import { certifyArtifact } from "../economy/certify";
import { quoteToolRun } from "../economy/x402";
import { getTool } from "../factory/micro-saas";

export async function handleEconomy(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  // --- Reputation ---
  if (path === "/v1/reputation/issue" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const passport = await issuePassport(env, identity, {
      agent_id: body.agent_id,
      display_name: body.display_name || body.name,
      capabilities: body.capabilities,
    });
    return json({
      ok: true,
      passport,
      note: "Trust passport issued. Mesh/PQC tunnel binding is account-level next step.",
    });
  }

  if (path === "/v1/reputation/list" && req.method === "GET") {
    const items = await listPassports(env, identity.tenant || "default");
    return json({ ok: true, count: items.length, agents: items });
  }

  const repGet = path.match(/^\/v1\/reputation\/([^/]+)$/);
  if (repGet && req.method === "GET") {
    const p = await getPassport(env, identity.tenant || "default", repGet[1]);
    if (!p) return json({ ok: false, error: "passport not found" }, 404);
    return json({ ok: true, passport: p });
  }

  if (path === "/v1/reputation/event" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const agent_id = String(body.agent_id || "");
    const event = body.event as "success" | "failure" | "abuse" | "certified";
    if (!agent_id || !["success", "failure", "abuse", "certified"].includes(event)) {
      return json({ ok: false, error: "agent_id and event required" }, 400);
    }
    const p = await recordEvent(env, agent_id, identity.tenant || "default", event);
    if (!p) return json({ ok: false, error: "passport not found" }, 404);
    return json({ ok: true, passport: p });
  }

  // --- Code certification ---
  if (path === "/v1/certify" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    let code = typeof body.code === "string" ? body.code : "";
    let recipe = body.recipe;
    const tool_id = body.tool_id ? String(body.tool_id) : undefined;

    if (tool_id && !code) {
      const tool = await getTool(env, identity, tool_id);
      if (!tool) return json({ ok: false, error: "tool not found" }, 404);
      code = tool.code_preview;
      recipe = tool.recipe;
    }
    if (!code && !recipe) return json({ ok: false, error: "code, recipe or tool_id required" }, 400);

    const cert = await certifyArtifact(env, identity, { code, recipe, tool_id });
    if (cert.status === "certified" && body.agent_id) {
      await recordEvent(env, String(body.agent_id), identity.tenant || "default", "certified");
    }
    return json({ ok: true, certificate: cert });
  }

  // --- Pricing quote ---
  if (path === "/v1/economy/quote" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const tool_id = String(body.tool_id || "generic");
    const wallet = String(body.wallet || `wallet:agent:${identity.tenant}:${tool_id}`);
    const quote = quoteToolRun(tool_id, wallet, body.amount || "0.001");
    return json({ ok: true, protocol: "x402", quote });
  }

  if (path === "/v1/economy/status" && req.method === "GET") {
    return json({
      ok: true,
      layers: {
        factory: true,
        x402_gate: true,
        reputation: true,
        code_certify: true,
        monetization_gateway: false,
        cloudflare_mesh: false,
        note: "Edge wedges live; Mesh + real USDC need account products",
      },
    });
  }

  return null;
}
