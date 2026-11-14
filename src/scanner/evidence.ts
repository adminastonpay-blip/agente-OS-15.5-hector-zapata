/**
 * Enterprise diagnostic evidence package — HMAC attestation (ATI-aligned).
 * Findings are stored server-side only; never echo score to public /v1/audit clients.
 */
import type { Env } from "../types";
import type { ScannerVulnerability } from "./index";

export type DiagnosticEvidence = {
  schema_version: "diagnostic-evidence/1.0.0";
  request_id: string;
  issuer: string;
  target_domain: string;
  target_url: string;
  recipient_email_domain?: string;
  issued_at: number;
  worker_version: string;
  scan_mode: "passive";
  claims: Array<{ id: string; severity: string; title: string; description?: string }>;
  digests: { claims_sha256: string; package_sha256?: string };
  score_orientative?: number;
  signature: { alg: "HMAC-SHA256"; value: string; kid: string };
  ots_status: "none" | "pending" | "submitted" | "confirmed";
  attestation_status: "unverified" | "verified" | "failed" | "not_applicable";
  disclaimer: string;
};

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function kidFromSecret(secret: string): string {
  let h = 0;
  for (let i = 0; i < secret.length; i++) h = (h * 31 + secret.charCodeAt(i)) >>> 0;
  return `hmac-${h.toString(16).slice(0, 8)}`;
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function emailDomain(email: string): string {
  const parts = email.trim().toLowerCase().split("@");
  return parts.length === 2 ? parts[1] : "";
}

export function emailMatchesTarget(email: string, targetUrl: string): boolean {
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./, "").toLowerCase();
    const domain = emailDomain(email);
    if (!host || !domain) return false;
    return domain === host || domain.endsWith("." + host);
  } catch {
    return false;
  }
}

export async function buildEvidencePackage(input: {
  env: Env;
  request_id: string;
  target: URL;
  email: string;
  score: number;
  vulnerabilities: ScannerVulnerability[];
  worker_version: string;
}): Promise<{ package: DiagnosticEvidence; signed: boolean }> {
  const claims = input.vulnerabilities.map((v) => ({
    id: v.id,
    severity: v.severity,
    title: v.title,
    description: v.description.slice(0, 1000),
  }));
  const claims_sha256 = await sha256Hex(canonicalJson(claims));
  const secret = input.env.PII_HMAC_SECRET || input.env.API_KEY || "";
  const unsignedCore = {
    schema_version: "diagnostic-evidence/1.0.0" as const,
    request_id: input.request_id,
    issuer: "aston-os-worker",
    target_domain: input.target.hostname.toLowerCase(),
    target_url: input.target.origin,
    recipient_email_domain: emailDomain(input.email) || undefined,
    issued_at: Date.now(),
    worker_version: input.worker_version,
    scan_mode: "passive" as const,
    claims,
    digests: { claims_sha256 },
    score_orientative: input.score,
    ots_status: "none" as const,
    attestation_status: "unverified" as const,
    disclaimer:
      "Passive public HTTP review only. Not a pentest, certification, or proof of exploitability. Attestation status remains unverified until independent verification policy succeeds.",
  };

  let signature: DiagnosticEvidence["signature"] = {
    alg: "HMAC-SHA256",
    value: "unsigned",
    kid: "none",
  };
  let signed = false;
  if (secret.length >= 16) {
    const payload = canonicalJson({
      request_id: unsignedCore.request_id,
      target_domain: unsignedCore.target_domain,
      issued_at: unsignedCore.issued_at,
      claims_sha256,
      score_orientative: unsignedCore.score_orientative,
    });
    signature = {
      alg: "HMAC-SHA256",
      value: await hmacSign(secret, payload),
      kid: kidFromSecret(secret),
    };
    signed = true;
  }

  const full: DiagnosticEvidence = { ...unsignedCore, signature };
  full.digests.package_sha256 = await sha256Hex(canonicalJson({ ...full, digests: { claims_sha256 } }));
  return { package: full, signed };
}

export async function persistEvidence(env: Env, pkg: DiagnosticEvidence): Promise<boolean> {
  const bucket = env.AUDIT_ARCHIVE || env.JOURNAL;
  if (!bucket) return false;
  const key = `diagnostic/${pkg.target_domain}/${pkg.request_id}.json`;
  try {
    await bucket.put(key, JSON.stringify(pkg, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        request_id: pkg.request_id,
        target_domain: pkg.target_domain,
        attestation_status: pkg.attestation_status,
      },
    });
    return true;
  } catch (e) {
    console.error("[DIAGNOSTIC_R2]", String(e));
    return false;
  }
}
