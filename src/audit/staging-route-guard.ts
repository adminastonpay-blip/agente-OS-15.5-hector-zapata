const STAGING_ALLOWED_PATHS = new Set([
  "/",
  "/health",
  "/v1/engineering/health",
  "/v1/audit-target",
  "/v1/audit/anchor/verify",
  "/v1/etl/ingest",
  // RAG is enabled only on the isolated staging Worker for tenant-isolation validation.
  "/v1/rag/ingest",
  "/v1/rag/query",
]);

/**
 * Restrict the isolated staging Worker to explicitly approved health, audit,
 * ETL, and tenant-isolated RAG surfaces. Production routing is unchanged.
 */
export function isStagingRouteAllowed(profile: string | undefined, path: string): boolean {
  if (!String(profile || "").toLowerCase().includes("staging")) return true;
  const normalized = path.replace(/\/+$/, "") || "/";
  return STAGING_ALLOWED_PATHS.has(normalized);
}
