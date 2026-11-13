import { handleSurfaceScan } from "../../src/scanner/index";
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/scan" && request.method === "POST") {
      return handleSurfaceScan(request, {} as any);
    }
    return new Response("not_found", { status: 404 });
  },
};
