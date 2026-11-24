const PUBLIC_OR_READ_PATHS = new Set([
  "/",
  "/health",
  "/v1/capabilities",
  "/v1/models",
  "/v1/voice/profiles",
]);

async function verifyWorkerPopIfPresent(
  req: Request,
  identity: Identity,
  path: string
): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  const sig = req.headers.get("x-aston-pop-signature")?.trim();
  const pubB64Url = req.headers.get("x-aston-pop-public-key")?.trim();
  const claimedTenant = req.headers.get("x-aston-tenant")?.trim();
  const claimedActor = req.headers.get("x-aston-actor")?.trim();

  if (claimedTenant && identity.tenant && claimedTenant !== identity.tenant) {
    return { ok: false, status: 403, error: "tenant_header_mismatch" };
  }
  if (claimedActor && identity.actor && claimedActor !== identity.actor) {
    return { ok: false, status: 403, error: "actor_header_mismatch" };
  }

  const isMutatingOrProtected =
    !PUBLIC_OR_READ_PATHS.has(path) &&
    (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE");

  if (!sig && !pubB64Url) {
    if (isMutatingOrProtected && identity.method !== "public") {
      return { ok: false, status: 401, error: "pop_signature_required" };
    }
    return { ok: true };
  }
  if (!sig || !pubB64Url) {
    return { ok: false, status: 401, error: "incomplete_pop_headers" };
  }
  if (identity.method === "public" || !identity.tenant || !identity.actor) {
    return { ok: false, status: 403, error: "verified_identity_required_for_pop" };
  }

  try {
    const pubKey = await importEd25519PublicKey(fromBase64Url(pubB64Url));
    const rawBody =
      req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text().catch(() => "");
    const statement = canonicalizeJson({
      method: req.method,
      path,
      tenant: identity.tenant,
      actor: identity.actor,
      body: rawBody,
    });
    const valid = await verifyEd25519ProofOfPossession(pubKey, statement, sig);
    if (!valid) {
      return { ok: false, status: 401, error: "invalid_ed25519_pop_signature" };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 401, error: "malformed_ed25519_pop" };
  }
}

async function createWorkerInternalAssertion(
  env: GateWorkerEnv,
  aud: string,
  identity: Identity
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
  const secret = env.INTERNAL_ASSERTION_SECRET;
  const kid = env.INTERNAL_ASSERTION_KEY_ID;
  if (!secret || !kid) {
    return { ok: false, error: "internal_assertion_secret_or_kid_missing" };
  }
  if (!identity.tenant || !identity.actor) {
    return { ok: false, error: "verified_identity_required" };
  }
  try {
    const token = await signInternalAssertion(
      {
        iss: "worker-router",
        aud,
        sub_tenant: identity.tenant,
        sub_actor: identity.actor,
        jti: crypto.randomUUID(),
        ttlMs: MAX_INTERNAL_ASSERTION_TTL_MS,
      },
      secret,
      kid
    );
    return { ok: true, headers: { "x-aston-internal-assertion": token } };
  } catch {
    return { ok: false, error: "internal_assertion_sign_failed" };
  }
}

