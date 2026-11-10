/**
 * Intelligent inference routing via Workers AI + optional AI Gateway.
 * Fallback cascade keeps availability when a model or gateway path fails.
 */
import type { Env } from "../types";

export const ROUTES = {
  chat_fast: [
    "@cf/meta/llama-3.1-8b-instruct-fp8",
    "@cf/meta/llama-3.1-8b-instruct-fast",
    "@cf/google/gemma-4-26b-a4b-it",
  ],
  chat_quality: [
    "@cf/meta/llama-3.1-8b-instruct-fp8",
    "@cf/openai/gpt-oss-20b",
    "@cf/google/gemma-4-26b-a4b-it",
  ],
  embed: ["@cf/baai/bge-m3"],
} as const;

export type RouteProfile = keyof typeof ROUTES;

export function modelsFor(env: Env, profile: RouteProfile = "chat_fast"): string[] {
  const preferred = profile.startsWith("chat")
    ? env.CHAT_MODEL
    : env.EMBED_MODEL;
  const list: string[] = [...ROUTES[profile]];
  if (preferred && !list.includes(preferred as any)) list.unshift(preferred);
  return [...new Set(list)];
}

export async function runRouted(
  env: Env,
  profile: RouteProfile,
  input: Record<string, unknown>
): Promise<{ model: string; out: any; via: "gateway" | "direct" }> {
  const ai = env.AI;
  if (!ai) throw new Error("Workers AI binding not configured");
  const models = modelsFor(env, profile);
  let lastErr = "";
  for (const model of models) {
    if (env.AI_GATEWAY_ID) {
      try {
        const out = await ai.run(model as any, input as any, {
          gateway: { id: env.AI_GATEWAY_ID },
        } as any);
        return { model, out, via: "gateway" };
      } catch (e: any) {
        lastErr = String(e?.message || e);
      }
    }
    try {
      const out = await env.AI.run(model as any, input as any);
      return { model, out, via: "direct" };
    } catch (e: any) {
      lastErr = String(e?.message || e);
    }
  }
  throw new Error(lastErr || "AI router exhausted models");
}
