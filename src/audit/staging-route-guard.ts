const STAGING_ALLOWED_PATHS = new Set(["/", "/health", "/v1/audit-target", "/v1/audit/anchor/verify", "/v1/etl/ingest"]);

/**
 * Restrict the isolated audit Worker to its health and authenticated audit
 * surfaces. Production routing is unchanged.
 */
export function isStagingRouteAllowed(profile: string | undefined, path: string): boolean {
  if (!String(profile || "").toLowerCase().includes("staging")) return true;
  const normalized = path.replace(/\/+$/, "") || "/";
  return STAGING_ALLOWED_PATHS.has(normalized);
}
