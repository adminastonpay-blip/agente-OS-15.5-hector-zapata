/**
 * Cloudflare product surface for Aston OS — status only, no hard deps.
 */
import type { Env } from "../types";

export type InfraItem = {
  id: string;
  cloudflare: string;
  role: string;
  bound: boolean;
  aston_route?: string;
  phase: "live" | "soft" | "planned";
};

export function infraInventory(env: Env): InfraItem[] {
  return [
    {
      id: "workers_ai",
      cloudflare: "Workers AI",
      role: "inference",
      bound: !!env.AI,
      aston_route: "/v1/chat",
      phase: "live",
    },
    {
      id: "ai_gateway",
      cloudflare: "AI Gateway",
      role: "routing / cache / fallback",
      bound: !!env.AI_GATEWAY_ID,
      aston_route: "/v1/ai/routes",
      phase: env.AI_GATEWAY_ID ? "live" : "planned",
    },
    {
      id: "durable_objects",
      cloudflare: "Durable Objects (+ SQLite)",
      role: "hot state / facets pattern",
      bound: !!(env.SESSION && env.GRAPH && env.SAFETY),
      phase: "live",
    },
    {
      id: "d1",
      cloudflare: "D1",
      role: "SSOT / ontology / ledger",
      bound: !!env.DB,
      phase: env.DB ? "live" : "planned",
    },
    {
      id: "vectorize",
      cloudflare: "Vectorize",
      role: "semantic memory",
      bound: !!env.VECTORIZE,
      aston_route: "/v1/rag/query",
      phase: env.VECTORIZE ? "live" : "planned",
    },
    {
      id: "r2_journal",
      cloudflare: "R2 (+ Data Catalog / SQL later)",
      role: "artifacts + decision lakehouse",
      bound: !!env.JOURNAL,
      aston_route: "/v1/audit",
      phase: env.JOURNAL ? "live" : "planned",
    },
    {
      id: "queues",
      cloudflare: "Queues",
      role: "async ETL / recovery",
      bound: !!env.ETL_QUEUE,
      aston_route: "/v1/etl/enqueue",
      phase: env.ETL_QUEUE ? "live" : "planned",
    },
    {
      id: "hyperdrive",
      cloudflare: "Hyperdrive",
      role: "cold Postgres SSOT",
      bound: !!env.HYPERDRIVE,
      phase: env.HYPERDRIVE ? "live" : "planned",
    },
    {
      id: "x402",
      cloudflare: "Wallets / x402 / Monetization Gateway",
      role: "agent budget + micropayments",
      bound: true, // protocol implemented at edge
      aston_route: "/v1/economy/quote",
      phase: "soft",
    },
    {
      id: "dynamic_workers",
      cloudflare: "Dynamic Workers",
      role: "deploy generated micro-tools",
      bound: false,
      aston_route: "/v1/factory/generate",
      phase: "planned",
    },
    {
      id: "workers_for_platforms",
      cloudflare: "Workers for Platforms",
      role: "per-tenant isolate",
      bound: false,
      phase: "planned",
    },
    {
      id: "pipelines_r2sql",
      cloudflare: "Pipelines + R2 Data Catalog + R2 SQL",
      role: "decision lakehouse analytics",
      bound: !!env.JOURNAL,
      phase: env.JOURNAL ? "soft" : "planned",
    },
    {
      id: "data_localization",
      cloudflare: "Data Localization Suite",
      role: "residency / jurisdiction",
      bound: false,
      phase: "planned",
    },
    {
      id: "airgap",
      cloudflare: "—",
      role: "offline / DORA-class",
      bound: false,
      phase: "planned",
    },
  ];
}

/** Artifact key layout for future R2 Data Catalog. */
export function artifactKey(parts: {
  tenant: string;
  kind: "decision" | "tool" | "cert" | "incident" | "passport";
  id: string;
}): string {
  const t = parts.tenant.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `catalog/${t}/${parts.kind}/${parts.id}.json`;
}

export async function putArtifact(
  env: Env,
  meta: { tenant: string; kind: "decision" | "tool" | "cert" | "incident" | "passport"; id: string },
  body: unknown
): Promise<{ stored: boolean; key: string }> {
  const key = artifactKey(meta);
  if (!env.JOURNAL) return { stored: false, key };
  try {
    await env.JOURNAL.put(key, JSON.stringify({ ...meta, body, ts: Date.now() }), {
      httpMetadata: { contentType: "application/json" },
    });
    return { stored: true, key };
  } catch {
    return { stored: false, key };
  }
}
