/**
 * x402-style micropayment gate (HTTP 402 Payment Required).
 * Soft ledger until Cloudflare Monetization Gateway / real USDC settlement is bound.
 */
import type { Env, Identity } from "../types";

export interface PriceQuote {
  amount_usdc: string;
  asset: "USDC";
  network: "edge-ledger";
  pay_to: string;
  tool_id: string;
  nonce: string;
  expires_at: number;
}

export function quoteToolRun(toolId: string, walletHint: string, amount = "0.001"): PriceQuote {
  return {
    amount_usdc: amount,
    asset: "USDC",
    network: "edge-ledger",
    pay_to: walletHint,
    tool_id: toolId,
    nonce: crypto.randomUUID().slice(0, 12),
    expires_at: Date.now() + 15 * 60 * 1000,
  };
}

/** Accept demo proof header or API key as paid. */
export function paymentSatisfied(req: Request, env: Env): {
  paid: boolean;
  method: "x402-proof" | "api-key" | "free-tier" | "none";
} {
  const proof = req.headers.get("X-Payment") || req.headers.get("X-402-Payment");
  if (proof && proof.length >= 8) return { paid: true, method: "x402-proof" };

  const auth = req.headers.get("Authorization") || "";
  if (env.API_KEY && auth === `Bearer ${env.API_KEY}`) return { paid: true, method: "api-key" };

  // Public free tier for discovery (metering still logged)
  if (req.headers.get("X-Aston-Pay") === "skip" || req.headers.get("X-Aston-Free") === "1") {
    return { paid: true, method: "free-tier" };
  }

  return { paid: false, method: "none" };
}

export function paymentRequiredResponse(quote: PriceQuote, cors: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "Payment Required",
      code: 402,
      protocol: "x402",
      quote,
      how: {
        header: "X-Payment: <proof-or-demo-token>",
        or: "X-Aston-Free: 1 for discovery tier",
        or_api_key: "Authorization: Bearer <API_KEY>",
        note: "Edge ledger demo — wire Monetization Gateway for real USDC",
      },
    }),
    {
      status: 402,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-402-Amount": quote.amount_usdc,
        "X-402-Asset": quote.asset,
        "X-402-Pay-To": quote.pay_to,
        ...cors,
      },
    }
  );
}

export async function logPayment(
  env: Env,
  identity: Identity,
  entry: Record<string, unknown>
): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS economy_ledger (
        id TEXT PRIMARY KEY,
        tenant TEXT,
        payload TEXT,
        ts INTEGER
      )`
    ).run();
    await env.DB.prepare(
      `INSERT INTO economy_ledger (id, tenant, payload, ts) VALUES (?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        identity.tenant || "default",
        JSON.stringify(entry),
        Date.now()
      )
      .run();
  } catch (e) {
    console.error("[LEDGER]", String(e));
  }
}
