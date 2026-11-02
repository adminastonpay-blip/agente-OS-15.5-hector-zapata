import type { Env } from "../types";

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = (await env.AI.run(env.EMBED_MODEL as any, { text: texts } as any,
    { gateway: { id: env.AI_GATEWAY_ID } } as any)) as any;
  return res.data;
}

export async function chat(env: Env, messages: any[], opts?: { max_tokens?: number; temp?: number }) {
  return env.AI.run(env.CHAT_MODEL as any, {
    messages, max_tokens: opts?.max_tokens ?? 512, temperature: opts?.temp ?? 0.2,
  } as any, { gateway: { id: env.AI_GATEWAY_ID } } as any) as Promise<{ response: string }>;
}

export function chunk(text: string, size = 800, overlap = 100): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}
