/**
 * ASTON OS — Micro-SaaS / Micro-tool factory (agent economy wedge)
 *
 * Generates tool definitions + restricted recipes (not arbitrary eval).
 * Ready for future Dynamic Workers / Sandbox / Wallets.
 */
import type { Env, Identity } from "../types";
import { chat } from "../lib/ai";
import { tenantKey } from "../lib/sovereign";

export interface MicroTool {
  id: string;
  tenant: string;
  name: string;
  description: string;
  problem: string;
  input_schema: Record<string, unknown>;
  recipe: RecipeStep[];
  code_preview: string;
  status: "draft" | "simulated" | "active" | "retired";
  created_at: number;
  created_by: string;
  runs: number;
  wallet_hint: string;
}

export type RecipeStep =
  | { op: "echo"; message?: string }
  | { op: "json_pick"; path: string }
  | { op: "template"; template: string }
  | { op: "ai_reason"; prompt: string }
  | { op: "math"; expression: string }
  | { op: "merge"; fields: string[] };

const GEN_SYSTEM = `Eres el generador de micro-herramientas de ASTON OS.
Devuelve SOLO JSON válido (sin markdown) con esta forma:
{
  "name": "slug-corto",
  "description": "qué hace en una línea",
  "input_schema": { "campo": "tipo o descripción" },
  "recipe": [
    {"op":"template","template":"Resultado: {{campo}}"},
    {"op":"ai_reason","prompt":"Analizá {{campo}}"}
  ],
  "code_preview": "// JS ilustrativo para Dynamic Worker futuro\\nexport default { async fetch(req, env) { ... } }"
}
Ops permitidos en recipe: echo, json_pick, template, ai_reason, math, merge.
No uses fetch externo, fs, eval ni process. Código solo ilustrativo.`;

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "tool";
}

function parseJsonLoose(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall */
      }
    }
    return null;
  }
}

function getPath(obj: any, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce((a: any, k) => (a == null ? undefined : a[k]), obj);
}

function safeMath(expr: string, ctx: Record<string, unknown>): number | null {
  // Only numbers, + - * / ( ) and ctx.number fields as n0,n1...
  const cleaned = expr.replace(/[^0-9+\-*/().\s]/g, "");
  if (!cleaned.trim()) return null;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${cleaned});`);
    const v = fn();
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function applyTemplate(tpl: string, input: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = getPath(input, key);
    return v == null ? "" : String(v);
  });
}

export async function generateMicroTool(
  env: Env,
  identity: Identity,
  problem: string
): Promise<MicroTool> {
  const out = await chat(
    env,
    [
      { role: "system", content: GEN_SYSTEM },
      {
        role: "user",
        content: `Problema / tarea repetitiva del negocio:\n${problem.slice(0, 4000)}`,
      },
    ],
    { max_tokens: 1200, temp: 0.3 }
  );

  const parsed = parseJsonLoose(out.response) || {};
  const name = slug(String(parsed.name || problem).slice(0, 80));
  const id = `${name}-${crypto.randomUUID().slice(0, 8)}`;
  const recipe: RecipeStep[] = Array.isArray(parsed.recipe)
    ? parsed.recipe.filter((s: any) => s && typeof s.op === "string").slice(0, 12)
    : [{ op: "ai_reason", prompt: problem }];

  const tool: MicroTool = {
    id,
    tenant: identity.tenant || "default",
    name,
    description: String(parsed.description || problem).slice(0, 500),
    problem: problem.slice(0, 2000),
    input_schema:
      parsed.input_schema && typeof parsed.input_schema === "object"
        ? parsed.input_schema
        : { input: "string" },
    recipe,
    code_preview: String(parsed.code_preview || "// pending Dynamic Worker deploy").slice(0, 8000),
    status: "draft",
    created_at: Date.now(),
    created_by: identity.actor || "public",
    runs: 0,
    wallet_hint: `wallet:agent:${identity.tenant}:${id}`,
  };

  await persistTool(env, identity, tool);
  return tool;
}

async function factoryStub(env: Env, identity: Identity) {
  const session = env.SESSION;
  if (!session) throw new Error("SESSION binding not configured");
  return session.get(session.idFromName(tenantKey(identity, "factory")));
}

async function persistTool(env: Env, identity: Identity, tool: MicroTool) {
  // Prefer D1 when available
  if (env.DB) {
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS micro_tools (
          id TEXT PRIMARY KEY,
          tenant TEXT,
          payload TEXT,
          created_at INTEGER
        )`
      ).run();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO micro_tools (id, tenant, payload, created_at) VALUES (?, ?, ?, ?)`
      )
        .bind(tool.id, tool.tenant, JSON.stringify(tool), tool.created_at)
        .run();
      return;
    } catch (e) {
      console.error("[FACTORY_D1]", String(e));
    }
  }
  // Fallback: SESSION DO key-value via append protocol + dedicated get
  try {
    const stub = await factoryStub(env, identity);
    await stub.fetch("https://do/append", {
      method: "POST",
      body: JSON.stringify({
        role: "system",
        content: JSON.stringify({ factory_tool: tool }),
      }),
    });
  } catch (e) {
    console.error("[FACTORY_DO]", String(e));
  }
}

export async function listTools(env: Env, identity: Identity): Promise<MicroTool[]> {
  if (env.DB) {
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS micro_tools (
          id TEXT PRIMARY KEY,
          tenant TEXT,
          payload TEXT,
          created_at INTEGER
        )`
      ).run();
      const rows = await env.DB.prepare(
        `SELECT payload FROM micro_tools WHERE tenant = ? ORDER BY created_at DESC LIMIT 50`
      )
        .bind(identity.tenant || "default")
        .all();
      return (rows.results || [])
        .map((r: any) => {
          try {
            return JSON.parse(r.payload) as MicroTool;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as MicroTool[];
    } catch {
      /* fall through */
    }
  }
  try {
    const stub = await factoryStub(env, identity);
    const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
    const tools: MicroTool[] = [];
    for (const h of mem.history || []) {
      try {
        const o = JSON.parse(h.content);
        if (o?.factory_tool?.id) tools.push(o.factory_tool);
      } catch {
        /* skip */
      }
    }
    return tools.reverse().slice(0, 50);
  } catch {
    return [];
  }
}

export async function getTool(
  env: Env,
  identity: Identity,
  id: string
): Promise<MicroTool | null> {
  const all = await listTools(env, identity);
  return all.find((t) => t.id === id) || null;
}

export async function runRecipe(
  env: Env,
  tool: MicroTool,
  input: Record<string, unknown>
): Promise<{ ok: true; output: unknown; steps: any[] } | { ok: false; error: string }> {
  const steps: any[] = [];
  let ctx: any = { ...input };

  for (const step of tool.recipe) {
    try {
      if (step.op === "echo") {
        const msg = step.message || JSON.stringify(ctx);
        steps.push({ op: "echo", out: msg });
        ctx = { ...ctx, last: msg };
      } else if (step.op === "json_pick") {
        const v = getPath(ctx, step.path);
        steps.push({ op: "json_pick", path: step.path, out: v });
        ctx = { ...ctx, last: v };
      } else if (step.op === "template") {
        const out = applyTemplate(step.template, ctx);
        steps.push({ op: "template", out });
        ctx = { ...ctx, last: out };
      } else if (step.op === "math") {
        const n = safeMath(applyTemplate(step.expression, ctx), ctx);
        steps.push({ op: "math", out: n });
        ctx = { ...ctx, last: n };
      } else if (step.op === "merge") {
        const picked: Record<string, unknown> = {};
        for (const f of step.fields || []) picked[f] = getPath(ctx, f);
        steps.push({ op: "merge", out: picked });
        ctx = { ...ctx, last: picked };
      } else if (step.op === "ai_reason") {
        const prompt = applyTemplate(step.prompt, ctx);
        const r = await chat(
          env,
          [
            {
              role: "system",
              content:
                "Ejecutás una micro-herramienta ASTON. Respuesta breve y útil. No inventes datos de negocio.",
            },
            { role: "user", content: prompt },
          ],
          { max_tokens: 400 }
        );
        steps.push({ op: "ai_reason", out: r.response });
        ctx = { ...ctx, last: r.response };
      } else {
        steps.push({ op: (step as any).op, error: "op not allowed" });
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
  }

  return { ok: true, output: ctx.last ?? ctx, steps };
}

export async function simulateDeploy(
  env: Env,
  identity: Identity,
  tool: MicroTool
): Promise<{ ok: boolean; risk: string; notes: string[] }> {
  const notes: string[] = [
    "Recipe ops are allowlisted (no network, no eval of free code)",
    "code_preview is illustrative until Dynamic Workers binding exists",
    `Wallet placeholder: ${tool.wallet_hint}`,
  ];
  let risk = "low";
  if (tool.recipe.some((s) => s.op === "ai_reason")) {
    notes.push("Uses Workers AI — cost per run");
    risk = "medium";
  }
  if (env.SIMULATION) {
    try {
      const stub = env.SIMULATION.get(
        env.SIMULATION.idFromName(tenantKey(identity, "sim"))
      );
      const res = await stub.fetch("https://do/simulate", {
        method: "POST",
        body: JSON.stringify({
          scenario: "micro_saas_deploy",
          tool_id: tool.id,
          recipe_ops: tool.recipe.map((s) => s.op),
        }),
      });
      if (res.ok) notes.push("SimulationTwin acknowledged scenario");
    } catch {
      notes.push("SimulationTwin optional path skipped");
    }
  }
  return { ok: true, risk, notes };
}
