import type { Env } from "../types";
import { handleSurfaceScan } from "./index";
import { handleEnterpriseAudit } from "./enterprise-audit";

/** Public scanner routes (before API auth). */
export async function tryScannerRoutes(
  path: string,
  method: string,
  req: Request,
  env: Env
): Promise<Response | null> {
  if (method === "OPTIONS" && (path === "/api/scan" || path === "/v1/audit")) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (path === "/v1/audit" && method === "POST") {
    return handleEnterpriseAudit(req, env);
  }
  if (path === "/api/scan" && method === "POST") {
    // If client sends email, force attestation-only response path
    const clone = req.clone();
    const body = await clone.json().catch(() => null) as { email?: unknown } | null;
    if (body && typeof body.email === "string" && body.email.trim()) {
      return handleEnterpriseAudit(req, env);
    }
    return handleSurfaceScan(req, env);
  }
  return null;
}
