import type { Env, Identity } from "../types";
import { ControlGate } from "../core/control-gate";
import { ModelRunner } from "../core/model-runner";

const FALLBACK_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/openai/gpt-oss-20b",
];

function extractText(out: any): string {
  if (!out) return "";
  if (typeof out === "string") return out.trim();
  if (typeof out.response === "string") return out.response.trim();
  if (typeof out.text === "string") return out.text.trim();
  const c = out.choices?.[0]?.message?.content;
  return typeof c === "string" ? c.trim() : "";
}

/** Every embedding call requires the caller's independently verified identity. */
export async function embed(env: Env, identity: Identity, texts: string[]): Promise<number[][]> {
  if (!identity || identity.method === "public" || !identity.actor?.trim() || !identity.tenant?.trim()) {
    throw new Error("verified_inference_identity_required");
  }
  const model = env.EMBED_MODEL;
  if (!model || !model.startsWith("@cf/")) throw new Error("embedding_model_not_configured");
  const payload = { text: texts };
  const attempts = env.AI_GATEWAY_ID ? [true, false] : [false];
  let lastError: unknown;
  for (const useGateway of attempts) {
    const gate = await new ControlGate(env).authorizeInference(identity, "embeddings", payload, model);
    if (!gate.ok) throw new Error(gate.reason);
    try {
      const result = await new ModelRunner(env).execute<any>(gate.permit, "embeddings", model, payload, useGateway);
      return result?.data ?? [];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("embedding_inference_failed");
}

/** Each fallback model receives a new model-bound, one-use permit. */
export async function chat(
  env: Env,
  identity: Identity,
  messages: any[],
  opts?: { max_tokens?: number; temp?: number }
): Promise<{ response: string; model: string }> {
  if (!identity || identity.method === "public" || !identity.actor?.trim() || !identity.tenant?.trim()) {
    throw new Error("verified_inference_identity_required");
  }
  const preferred = (env.CHAT_MODEL || FALLBACK_MODELS[0]) as string;
  const models = [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)];
  let lastErr = "";
  for (const model of models) {
    const attempts = env.AI_GATEWAY_ID ? [true, false] : [false];
    for (const useGateway of attempts) {
      const gate = await new ControlGate(env).authorizeChat(identity, messages, model);
      if (!gate.ok) throw new Error(gate.reason);
      try {
        const out = await new ModelRunner(env).runChat(gate.permit, messages, {
          maxTokens: opts?.max_tokens ?? 512,
          temperature: opts?.temp ?? 0.2,
        }, model, useGateway);
        const response = extractText(out);
        if (response) return { response, model };
        lastErr = "model_runner_empty_response";
      } catch (error: any) {
        lastErr = String(error?.message || error);
      }
    }
  }

  throw new Error(lastErr || "AI unavailable");
}

/** Streaming stays fail-closed until buffered output safety is implemented. */
export async function chatStream(
  _env: Env,
  _identity: Identity,
  _messages: any[],
  _opts?: { max_tokens?: number; temp?: number }
): Promise<never> {
  throw new Error("chat_stream_disabled_until_buffered_safety_guard_is_implemented");
}
