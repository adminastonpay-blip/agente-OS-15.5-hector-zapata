const STAGING_ALLOWED_PATHS = new Set([
  "/", "/health", "/v1/audit-target", "/v1/audit/anchor/verify", "/v1/vbc/runs",
]);

/**
 * Restrict the isolated audit Worker to its health and authenticated audit
 * surfaces. VBC run subroutes are allowed only in a staging deployment; the
 * VBC handler independently enforces staging profile and shared-secret auth.
 */
export function isStagingRouteAllowed(profile: string | undefined, path: string): boolean {
  if (!String(profile || "").toLowerCase().includes("staging")) return true;
  const normalized = path.replace(/\/+$/, "") || "/";
  return STAGING_ALLOWED_PATHS.has(normalized) ||
    /^\/v1\/vbc\/runs\/[a-f0-9-]{36}\/(?:results|finalize)$/.test(normalized);
}
