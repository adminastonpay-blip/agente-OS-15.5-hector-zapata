/**
 * POST /v1/audit — enterprise diagnostic with private evidence package.
 * Public JSON: ok, request_id, delivery, attestation_status only.
 */
import type { Env } from "../types";
import { handleSurfaceScan } from "./index";
import {
  buildEvidencePackage,
  emailMatchesTarget,
  persistEvidence,
} from "./evidence";

const WORKER_VERSION = "21.6.4-enterprise-diagnostic";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function validEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

/**
 * Runs the same passive scan as /api/scan internally, then attests + stores.
 * Never returns score or vulnerabilities to the client.
 */
export async function handleEnterpriseAudit(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const body = await req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return json({ ok: false, error: "invalid_json" }, 400);

  const targetRaw =
    (typeof body.target === "string" && body.target) ||
    (typeof body.url === "string" && body.url) ||
    "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!targetRaw || targetRaw.length > 2048) {
    return json({ ok: false, error: "invalid_target", code: "INVALID_TARGET" }, 400);
  }
  if (!validEmail(email)) {
    return json({ ok: false, error: "invalid_email", code: "INVALID_EMAIL" }, 400);
  }
  if (!emailMatchesTarget(email, targetRaw.startsWith("http") ? targetRaw : `https://${targetRaw}`)) {
    return json(
      {
        ok: false,
        error: "email_domain_must_match_target_host",
        code: "EMAIL_DOMAIN_MISMATCH",
      },
      400
    );
  }

  // Reuse passive scanner by synthesizing a /api/scan request
  const scanReq = new Request(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: targetRaw.startsWith("http") ? targetRaw : `https://${targetRaw}`,
    }),
  });
  const scanRes = await handleSurfaceScan(scanReq, env);
  const scanJson = (await scanRes.json().catch(() => null)) as any;

  if (!scanRes.ok || !scanJson) {
    return json(
      {
        ok: false,
        error: (scanJson && scanJson.message) || "scan_unavailable",
        code: (scanJson && scanJson.error) || "SCAN_FAILED",
      },
      scanRes.status >= 400 ? scanRes.status : 502
    );
  }

  const request_id = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let targetUrl: URL;
  try {
    targetUrl = new URL(targetRaw.startsWith("http") ? targetRaw : `https://${targetRaw}`);
  } catch {
    return json({ ok: false, error: "invalid_target", code: "INVALID_TARGET" }, 400);
  }

  const { package: evidence, signed } = await buildEvidencePackage({
    env,
    request_id,
    target: targetUrl,
    email,
    score: typeof scanJson.score === "number" ? scanJson.score : 0,
    vulnerabilities: Array.isArray(scanJson.vulnerabilities) ? scanJson.vulnerabilities : [],
    worker_version: WORKER_VERSION,
  });

  const stored = await persistEvidence(env, evidence);

  // Email: no provider wired in-repo — do not claim delivery if not configured
  const mailConfigured = !!(env as any).MAIL_FROM || !!(env as any).RESEND_API_KEY;
  let delivery: "email_queued" | "stored_only" | "email_skipped_no_provider" = "email_skipped_no_provider";
  if (mailConfigured) {
    delivery = "email_queued";
    // Provider-specific send left to operator integration; package is in R2 for the mailer job.
  } else if (stored) {
    delivery = "stored_only";
  }

  return json({
    ok: true,
    request_id,
    delivery,
    attestation_status: "unverified",
    signed,
    stored,
    // Explicitly omit score / vulnerabilities
  });
}
