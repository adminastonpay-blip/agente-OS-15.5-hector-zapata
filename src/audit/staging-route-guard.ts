const STAGING_ALLOWED_PATHS = new Set([
  "/",
  "/health",
  "/v1/audit-target",
  "/v1/audit/anchor/verify",
]);

/**
 * Restrict the audit-only staging Worker to health and explicitly approved
 * audit endpoints. ETL, RAG, chat and product routes require a separately
 * isolated integration-staging profile and are denied here by default.
 * Production routing is unchanged.
 */
export function isStagingRouteAllowed(profile: string | undefined, path: string): boolean {
  if (!String(profile || "").toLowerCase().includes("staging")) return true;
  const normalized = path.replace(/\/+$/, "") || "/";
  return STAGING_ALLOWED_PATHS.has(normalized);
}
