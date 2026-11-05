import type { Env, Identity } from "../types";
import {
  generateMicroTool,
  listTools,
  getTool,
  runRecipe,
  simulateDeploy,
} from "../factory/micro-saas";

export async function handleFactory(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  // POST /v1/factory/generate  { problem | description | message }
  if (path === "/v1/factory/generate" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const problem =
      (typeof body.problem === "string" && body.problem.trim()) ||
      (typeof body.description === "string" && body.description.trim()) ||
      (typeof body.message === "string" && body.message.trim()) ||
      "";
    if (!problem) return json({ ok: false, error: "problem required" }, 400);
    if (problem.length > 4000) return json({ ok: false, error: "problem too long" }, 413);

    try {
      const tool = await generateMicroTool(env, identity, problem);
      const sim = await simulateDeploy(env, identity, tool);
      return json({
        ok: true,
        tool: {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
          recipe: tool.recipe,
          status: tool.status,
          wallet_hint: tool.wallet_hint,
          code_preview: tool.code_preview.slice(0, 2000),
        },
        simulation: sim,
        endpoints: {
          run: "/v1/factory/run",
          get: `/v1/factory/tools/${tool.id}`,
          list: "/v1/factory/tools",
        },
        note: "Wedge activo: recipe allowlisted. Dynamic Worker + Wallet = siguiente capa en dashboard.",
      });
    } catch (e: any) {
      return json(
        { ok: false, error: "factory generate failed", detail: String(e?.message || e).slice(0, 250) },
        502
      );
    }
  }

  // GET /v1/factory/tools
  if (path === "/v1/factory/tools" && req.method === "GET") {
    const tools = await listTools(env, identity);
    return json({
      ok: true,
      count: tools.length,
      tools: tools.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        status: t.status,
        created_at: t.created_at,
        wallet_hint: t.wallet_hint,
      })),
    });
  }

  // GET /v1/factory/tools/:id
  const m = path.match(/^\/v1\/factory\/tools\/([^/]+)$/);
  if (m && req.method === "GET") {
    const tool = await getTool(env, identity, m[1]);
    if (!tool) return json({ ok: false, error: "tool not found" }, 404);
    return json({ ok: true, tool });
  }

  // POST /v1/factory/run  { tool_id, input }
  if (path === "/v1/factory/run" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const toolId = String(body.tool_id || body.id || "");
    if (!toolId) return json({ ok: false, error: "tool_id required" }, 400);
    const tool = await getTool(env, identity, toolId);
    if (!tool) return json({ ok: false, error: "tool not found" }, 404);
    const input =
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? body.input
        : { input: body.input ?? body.message ?? "" };

    const result = await runRecipe(env, tool, input);
    if (!result.ok) return json({ ok: false, error: result.error }, 400);
    return json({
      ok: true,
      tool_id: tool.id,
      output: result.output,
      steps: result.steps,
      economy: {
        wallet_hint: tool.wallet_hint,
        metering: "placeholder — Cloudflare Wallets later",
      },
    });
  }

  // POST /v1/factory/simulate  { tool_id }
  if (path === "/v1/factory/simulate" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const toolId = String(body.tool_id || body.id || "");
    const tool = await getTool(env, identity, toolId);
    if (!tool) return json({ ok: false, error: "tool not found" }, 404);
    const sim = await simulateDeploy(env, identity, tool);
    return json({ ok: true, tool_id: tool.id, simulation: sim });
  }

  return null;
}
