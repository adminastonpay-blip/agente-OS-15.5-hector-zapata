/** Additive skills for ASTON OS 15.5 — governed inference only */
import type { Env, Identity } from "../types";
import { ControlGate } from "../core/control-gate";
import { ModelRunner } from "../core/model-runner";

export const TTS_MODELS = [
  "@cf/deepgram/aura-2-es",
  "@cf/deepgram/aura-2-en",
  "@cf/deepgram/aura-1",
  "@cf/myshell-ai/melotts",
] as const;

export const VOICE_PROFILES: Record<
  string,
  { id: string; name: string; description: string; language: string; model: string; pace: string }
> = {
  aston_executive: {
    id: "aston_executive",
    name: "ASTON Executive",
    description: "Calmada, precisa, premium",
    language: "es",
    model: "@cf/deepgram/aura-2-es",
    pace: "measured",
  },
  aston_warm: {
    id: "aston_warm",
    name: "ASTON Warm",
    description: "Cercana y clara",
    language: "es",
    model: "@cf/deepgram/aura-2-es",
    pace: "natural",
  },
  aston_energy: {
    id: "aston_energy",
    name: "ASTON Energy",
    description: "Dinámica, CTAs",
    language: "es",
    model: "@cf/deepgram/aura-2-es",
    pace: "brisk",
  },
  aston_en: {
    id: "aston_en",
    name: "ASTON English",
    description: "Executive English",
    language: "en",
    model: "@cf/deepgram/aura-2-en",
    pace: "measured",
  },
};

export function applyVoicePersonality(text: string, pace: string): string {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_>~]/g, " ")
    .replace(/https?:\/\/\S+/g, " enlace ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 2200) t = t.slice(0, 2200).replace(/\s+\S*$/, "") + ".";
  if (pace === "measured") t = t.replace(/([.!?])\s+/g, "$1 … ");
  else if (pace === "brisk") t = t.replace(/\s*—\s*/g, ". ");
  return t.replace(/\s+/g, " ").trim();
}

export function inferActions(userMsg: string): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  const q = (userMsg || "").toLowerCase();
  if (/\b(buscar|search|encontr)\b/.test(q)) {
    const term = userMsg.replace(/^(buscar|search|encontr[aá]?)\s*/i, "").trim().slice(0, 80);
    if (term.length > 1) actions.push({ type: "open_search", q: term });
  }
  if (/\b(carrito|cart|checkout)\b/.test(q) && /\b(ver|abrir|open|ir)\b/.test(q)) {
    actions.push({ type: "navigate", url: "/cart" });
  }
  return actions.slice(0, 3);
}

export async function normalizeAudio(result: unknown): Promise<ArrayBuffer | null> {
  if (!result) return null;
  if (result instanceof ArrayBuffer) return result;
  if (result instanceof Uint8Array) return result.buffer as ArrayBuffer;
  if (typeof result === "string" && result.length > 64) {
    try {
      const bin = atob(result);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    } catch {
      return null;
    }
  }
  if (typeof result === "object" && result) {
    const r = result as any;
    if (r.audio) return normalizeAudio(r.audio);
    if (r.buffer) return normalizeAudio(r.buffer);
  }
  return null;
}

export async function runTts(
  env: Env,
  identity: Identity,
  text: string,
  preferred?: string
): Promise<{ binary: ArrayBuffer | null; model: string; raw?: unknown }> {
  if (!identity || identity.method === "public" || !identity.actor?.trim() || !identity.tenant?.trim()) {
    throw new Error("verified_inference_identity_required");
  }
  const models = [preferred, ...TTS_MODELS].filter(Boolean) as string[];
  const seen = new Set<string>();
  let lastErr = "";
  for (const model of models) {
    if (seen.has(model)) continue;
    seen.add(model);
    for (const payload of [{ text }, { prompt: text }]) {
      const gate = await new ControlGate(env).authorizeInference(identity, "tts", payload, model);
      if (!gate.ok) throw new Error(gate.reason);
      try {
        const result = await new ModelRunner(env).execute<any>(gate.permit, "tts", model, payload);
        const binary = await normalizeAudio(result);
        if (binary) return { binary, model };
        if (result) return { binary: null, model, raw: result };
      } catch (error: any) {
        lastErr = String(error?.message || error);
      }
    }
  }
  throw new Error(lastErr || "TTS unavailable");
}
