import type { Env } from "./types";
import { SafetyInterlock } from "./do/safety-interlock";
import { handleStagingAudit } from "./audit/staging-endpoint";

// The isolated harness exports only the SafetyInterlock Durable Object.
// It intentionally does not import the production Worker router or bind D1.
export { SafetyInterlock };

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return json({
        ok: true,
        service: "ASTON OS 21x Audit Harness",
        profile: env.DEPLOY_PROFILE || "unknown",
        bindings: {
          ai: !!env.AI,
          safety: !!env.SAFETY,
          ots_verifier: !!env.OTS_VERIFIER,
          d1: false,
        },
        model_execution: "disabled_in_harness_entrypoint",
      });
    }

    const response = await handleStagingAudit(
      request,
      env,
      async () => json({
        ok: false,
        error: "model_execution_disabled_in_audit_harness",
      }, 503)
    );
    return response || json({ ok: false, error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
