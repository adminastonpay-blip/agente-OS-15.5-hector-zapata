import type { Env } from "../types";
import {
  consumeInferencePermit,
  type ChatMessage,
  type InferencePermit,
  type InferenceScope,
} from "./control-gate";

export interface ChatInferenceResult {
  response: string;
  model: string;
}

/**
 * The only new ASTON AI Control Gate component allowed to access env.AI.
 * It consumes a one-use permit bound to the exact serialized messages/model.
 */
export class ModelRunner {
  constructor(private readonly env: Env) {}


  /**
   * Executes a one-use capability for embeddings or TTS.
   * Streaming is intentionally not represented by InferenceScope.
   */
  async execute<T = unknown>(
    permit: InferencePermit,
    operation: Exclude<InferenceScope, "chat" | "recovery_diagnosis">,
    model: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    const ai = this.env.AI;
    if (!ai || !model.startsWith("@cf/")) {
      throw new Error("model_runner_not_configured");
    }
    const serialized = JSON.stringify(payload);
    if (!consumeInferencePermit(permit, operation, serialized, model)) {
      throw new Error("invalid_or_replayed_inference_permit");
    }
    return await ai.run(model as any, payload as any,
      this.env.AI_GATEWAY_ID
        ? ({ gateway: { id: this.env.AI_GATEWAY_ID } } as any)
        : undefined
    ) as T;
  }

  async runInference(
    permit: InferencePermit,
    action: "recovery_diagnosis",
    content: string,
    options: { maxTokens?: number; temperature?: number } = {},
    modelOverride?: string
  ): Promise<ChatInferenceResult> {
    const ai = this.env.AI;
    const model = modelOverride || this.env.CHAT_MODEL;
    if (!ai || !model || !model.startsWith("@cf/")) {
      throw new Error("model_runner_not_configured");
    }
    if (action !== "recovery_diagnosis" ||
        !consumeInferencePermit(permit, action, content, model)) {
      throw new Error("invalid_or_replayed_inference_permit");
    }

    const output = await ai.run(model as any, {
      messages: [{ role: "user", content }],
      max_tokens: options.maxTokens ?? 512,
      temperature: options.temperature ?? 0.1,
    } as any, this.env.AI_GATEWAY_ID
      ? ({ gateway: { id: this.env.AI_GATEWAY_ID } } as any)
      : undefined
    ) as any;
    const response =
      typeof output === "string" ? output :
      typeof output?.response === "string" ? output.response :
      typeof output?.text === "string" ? output.text :
      typeof output?.choices?.[0]?.message?.content === "string"
        ? output.choices[0].message.content
        : "";
    if (!response.trim()) throw new Error("model_runner_empty_response");
    return { response: response.trim(), model };
  }

  async runChat(
    permit: InferencePermit,
    messages: ChatMessage[],
    options: { maxTokens?: number; temperature?: number } = {}
  ): Promise<ChatInferenceResult> {
    const ai = this.env.AI;
    const model = this.env.CHAT_MODEL;
    if (!ai || !model || !model.startsWith("@cf/")) {
      throw new Error("model_runner_not_configured");
    }

    const payload = JSON.stringify(messages);
    if (!consumeInferencePermit(permit, "chat", payload, model)) {
      throw new Error("invalid_or_replayed_inference_permit");
    }

    const input = {
      messages,
      max_tokens: options.maxTokens ?? 512,
      temperature: options.temperature ?? 0.2,
    };

    // No fallback model and no unguarded retry: one permit authorizes one call.
    const output = await ai.run(model as any, input as any,
      this.env.AI_GATEWAY_ID
        ? ({ gateway: { id: this.env.AI_GATEWAY_ID } } as any)
        : undefined
    ) as any;

    const response =
      typeof output === "string" ? output :
      typeof output?.response === "string" ? output.response :
      typeof output?.text === "string" ? output.text :
      typeof output?.choices?.[0]?.message?.content === "string"
        ? output.choices[0].message.content
        : "";

    if (!response.trim()) throw new Error("model_runner_empty_response");
    return { response: response.trim(), model };
  }
}
