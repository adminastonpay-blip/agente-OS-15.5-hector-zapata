/**
 * Fail-closed validation for recovery probe targets.
 * Only HTTPS origins explicitly configured by an operator are reachable.
 */
export function isAllowedRecoveryOrigin(
  rawUrl: string,
  configuredOrigins: string | undefined
): boolean {
  if (typeof rawUrl !== "string" || !configuredOrigins?.trim()) return false;

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }

  if (target.protocol !== "https:" || target.username || target.password) {
    return false;
  }

  const allowedOrigins = configuredOrigins.split(",").map((entry) => entry.trim()).filter(Boolean);
  return allowedOrigins.some((entry) => {
    try {
      const allowed = new URL(entry);
      return allowed.protocol === "https:" &&
        !allowed.username &&
        !allowed.password &&
        allowed.pathname === "/" &&
        !allowed.search &&
        !allowed.hash &&
        allowed.origin === target.origin;
    } catch {
      return false;
    }
  });
}
