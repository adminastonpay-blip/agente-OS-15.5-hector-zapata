import { handleSurfaceScan } from "../../src/scanner/index";
import { tryScannerRoutes } from "../../src/scanner/routes";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Health for Miniflare readiness probe
    if (path === "/" || path === "/health") {
      return Response.json({ ok: true, service: "aston-scanner-miniflare" });
    }

    const routed = await tryScannerRoutes(path, request.method, request, {} as any);
    if (routed) return routed;

    // Fallback (should be covered by tryScannerRoutes)
    if (path === "/api/scan" && request.method === "POST") {
      return handleSurfaceScan(request, {} as any);
    }

    return new Response("not_found", { status: 404 });
  },
};
