/**
 * Governed inference routing. Every model/gateway attempt receives a fresh
 * one-use permit bound to the verified identity, exact payload and model.
 */
import type { Env, Identity } from "../types";
import { ControlGate } from "../core/control-gate";
import { ModelRunner } from "../core/model-runner";

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
  const preferred = profile.startsWith("chat") ? env.CHAT_MODEL : env.EMBED_MODEL;
  const list: string[] = [...ROUTES[profile]];
  if (preferred && !list.includes(preferred as any)) list.unshift(preferred);
  return [...new Set(list)];
}

export async function runRouted(
  env: Env,
  identity: Identity,
  profile: RouteProfile,
  input: Record<string, unknown>
): Promise<{ model: string; out: any; via: "gateway" | "direct" }> {
  if (!identity || identity.method === "public" || !identity.actor?.trim() || !identity.tenant?.trim()) {
    throw new Error("verified_inference_identity_required");
  }
  const chatRoute = profile.startsWith("chat");
  let lastErr = "";
  for (const model of modelsFor(env, profile)) {
    const operation = chatRoute ? "chat" : "embeddings";
    const messages = input.messages as any[] | undefined;
    const gate = chatRoute
      ? await new ControlGate(env).authorizeChat(identity, messages || [], model)
      : await new ControlGate(env).authorizeInference(identity, "embeddings", input, model);
    if (!gate.ok) throw new Error(gate.reason);
    try {
      if (chatRoute) {
        const out = await new ModelRunner(env).runChat(gate.permit, messages || [], {
          maxTokens: Number(input.max_tokens) || 512,
          temperature: Number(input.temperature) || 0.2,
        }, model);
        return { model, out, via: env.AI_GATEWAY_ID ? "gateway" : "direct" };
      }
      const out = await new ModelRunner(env).execute(gate.permit, operation, model, input);
      return { model, out, via: env.AI_GATEWAY_ID ? "gateway" : "direct" };
    } catch (error: any) {
      lastErr = String(error?.message || error);
      // A new permit is requested at the start of the next model attempt.
    }
  }
  throw new Error(lastErr || "AI router exhausted models");
}
