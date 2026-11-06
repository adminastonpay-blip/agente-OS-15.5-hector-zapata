import type { Env, Identity } from "../types";
import {
  generateMicroTool,
  listTools,
  getTool,
  runRecipe,
  simulateDeploy,
} from "../factory/micro-saas";
import { quoteToolRun, paymentSatisfied, paymentRequiredResponse, logPayment } from "../economy/x402";
import { certifyArtifact } from "../economy/certify";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,Accept,X-Aston-Tenant,X-Aston-Plan,X-Payment,X-402-Payment,X-Aston-Free",
};

export async function handleFactory(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
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
      let certificate = null;
      if (body.certify !== false) {
        certificate = await certifyArtifact(env, identity, {
          code: tool.code_preview,
          recipe: tool.recipe,
          tool_id: tool.id,
        });
      }
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
        certificate,
        endpoints: {
          run: "/v1/factory/run",
          quote: "/v1/economy/quote",
          certify: "/v1/certify",
          get: `/v1/factory/tools/${tool.id}`,
        },
        note: "Factory + auto-certify. Pay on /run via x402 headers or X-Aston-Free: 1",
      });
    } catch (e: any) {
      return json(
        { ok: false, error: "factory generate failed", detail: String(e?.message || e).slice(0, 250) },
        502
      );
    }
  }

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

  const m = path.match(/^\/v1\/factory\/tools\/([^/]+)$/);
  if (m && req.method === "GET") {
    const tool = await getTool(env, identity, m[1]);
    if (!tool) return json({ ok: false, error: "tool not found" }, 404);
    return json({ ok: true, tool });
  }

  if (path === "/v1/factory/run" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const toolId = String(body.tool_id || body.id || "");
    if (!toolId) return json({ ok: false, error: "tool_id required" }, 400);
    const tool = await getTool(env, identity, toolId);
    if (!tool) return json({ ok: false, error: "tool not found" }, 404);

    const requirePay = body.require_payment === true || req.headers.get("X-Require-Payment") === "1";
    const pay = paymentSatisfied(req, env);
    if (requirePay && !pay.paid) {
      const quote = quoteToolRun(tool.id, tool.wallet_hint);
      return paymentRequiredResponse(quote, CORS);
    }

    const input =
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? body.input
        : { input: body.input ?? body.message ?? "" };

    const result = await runRecipe(env, tool, input);
    if (!result.ok) return json({ ok: false, error: result.error }, 400);

    await logPayment(env, identity, {
      type: "tool_run",
      tool_id: tool.id,
      method: pay.method,
      wallet: tool.wallet_hint,
    });

    return json({
      ok: true,
      tool_id: tool.id,
      output: result.output,
      steps: result.steps,
      economy: {
        wallet_hint: tool.wallet_hint,
        payment_method: pay.method,
        protocol: "x402-compatible",
        metering: pay.method === "none" ? "free_discovery" : pay.method,
      },
    });
  }

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
