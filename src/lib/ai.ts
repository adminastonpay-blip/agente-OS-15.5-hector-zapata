import type { Env } from "../types";

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

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const ai = env.AI;
  if (!ai) throw new Error("Workers AI binding not configured");
  try {
    const res = (await ai.run(
      env.EMBED_MODEL as any,
      { text: texts } as any,
      env.AI_GATEWAY_ID ? ({ gateway: { id: env.AI_GATEWAY_ID } } as any) : undefined
    )) as any;
    return res?.data ?? [];
  } catch {
    const res = (await ai.run(env.EMBED_MODEL as any, { text: texts } as any)) as any;
    return res?.data ?? [];
  }
}

export async function chat(
  env: Env,
  messages: any[],
  opts?: { max_tokens?: number; temp?: number }
): Promise<{ response: string; model: string }> {
  const ai = env.AI;
  if (!ai) throw new Error("Workers AI binding not configured");
  const preferred = (env.CHAT_MODEL || FALLBACK_MODELS[0]) as string;
  const models = [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)];
  let lastErr = "";

  for (const model of models) {
    const input = {
      messages,
      max_tokens: opts?.max_tokens ?? 512,
      temperature: opts?.temp ?? 0.2,
    } as any;

    if (env.AI_GATEWAY_ID) {
      try {
        const out = (await ai.run(model as any, input, {
          gateway: { id: env.AI_GATEWAY_ID },
        } as any)) as any;
        const text = extractText(out);
        if (text) return { response: text, model };
      } catch (e: any) {
        lastErr = String(e?.message || e);
      }
    }

    try {
      const out = (await ai.run(model as any, input)) as any;
      const text = extractText(out);
      if (text) return { response: text, model };
    } catch (e: any) {
      lastErr = String(e?.message || e);
    }
  }

  throw new Error(lastErr || "AI unavailable");
}

/**
 * Prefer native Workers AI stream; fall back to progressive SSE of full answer.
 */
export async function chatStream(
  env: Env,
  messages: any[],
  opts?: { max_tokens?: number; temp?: number }
): Promise<{ stream: ReadableStream; model: string; mode: "native" | "chunked" }> {
  const ai = env.AI;
  if (!ai) throw new Error("Workers AI binding not configured");
  const preferred = (env.CHAT_MODEL || FALLBACK_MODELS[0]) as string;
  const models = [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)];
  const inputBase = {
    messages,
    max_tokens: opts?.max_tokens ?? 512,
    temperature: opts?.temp ?? 0.2,
    stream: true,
  } as any;

  for (const model of models) {
    try {
      let out: any;
      if (env.AI_GATEWAY_ID) {
        try {
          out = await ai.run(model as any, inputBase, {
            gateway: { id: env.AI_GATEWAY_ID },
          } as any);
        } catch {
          out = await ai.run(model as any, inputBase);
        }
      } else {
        out = await ai.run(model as any, inputBase);
      }

      if (out && typeof out.getReader === "function") {
        return { stream: out as ReadableStream, model, mode: "native" };
      }
      if (out?.body && typeof out.body.getReader === "function") {
        return { stream: out.body as ReadableStream, model, mode: "native" };
      }
    } catch {
      /* try next model or fallback */
    }
  }

  // Fallback: full completion, then emit as SSE-friendly text chunks
  const full = await chat(env, messages, opts);
  const text = full.response || "";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const size = 24;
      for (let i = 0; i < text.length; i += size) {
        controller.enqueue(encoder.encode(text.slice(i, i + size)));
        await new Promise((r) => setTimeout(r, 12));
      }
      controller.close();
    },
  });
  return { stream, model: full.model, mode: "chunked" };
}

export function chunk(text: string, size = 800, overlap = 100): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}
