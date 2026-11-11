/**
 * ASTON OTS verifier staging stub.
 * NOT a cryptographic verifier: production must validate the .ots receipt against
 * independently trusted Bitcoin headers / a Bitcoin node before asserting confirmation.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    if (request.method !== "POST" || url.pathname !== "/verify") {
      return Response.json({ ok: false, error: "not_found" }, { status: 404, headers });
    }
    const body = await request.json<any>().catch(() => null);
    if (!body || body.algorithm !== "opentimestamps-bitcoin" ||
        typeof body.proof_base64 !== "string" || body.proof_base64.length < 4 ||
        typeof body.checkpoint?.root_hash !== "string" || !/^[a-f0-9]{64}$/.test(body.checkpoint.root_hash)) {
      return Response.json({ ok: false, error: "invalid_verification_request" }, { status: 400, headers });
    }
    // Intentionally simulated for staging E2E contract tests only; never trust as Bitcoin proof.
    return Response.json({ ok: true, confirmed: true, block_height: 850000,
      root_hash: body.checkpoint.root_hash, status: "simulated", verification_mode: "simulated" }, { status: 200, headers });
  },
};
