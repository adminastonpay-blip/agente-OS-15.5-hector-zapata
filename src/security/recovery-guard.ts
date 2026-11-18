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

 
export interface RecoveryProbeResult {
  reachable: boolean;
  status: number;
  latency_ms: number;
  blocked?: string;
}

/** Read-only probe. Redirects are terminal and are never followed. */
export async function probeRecoveryOrigin(
  rawUrl: string,
  configuredOrigins: string | undefined,
  fetcher: typeof fetch = fetch
): Promise<RecoveryProbeResult> {
  if (!isAllowedRecoveryOrigin(rawUrl, configuredOrigins)) {
    return { reachable: false, status: 0, latency_ms: 0, blocked: "origin_not_allowlisted" };
  }
  const started = Date.now();
  try {
    const response = await fetcher(rawUrl, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (response.status >= 300 && response.status < 400) {
      return { reachable: false, status: response.status, latency_ms: Date.now() - started,
        blocked: "redirect_blocked" };
    }
    return { reachable: response.ok, status: response.status, latency_ms: Date.now() - started };
  } catch {
    return { reachable: false, status: 0, latency_ms: Date.now() - started,
      blocked: "probe_failed_or_redirect_blocked" };
  }
}
