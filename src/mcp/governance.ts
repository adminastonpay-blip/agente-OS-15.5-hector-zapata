/**
 * MCP Governance — stub deploy-safe (sin @modelcontextprotocol/sdk).
 */
import type { Env } from "../types";
import { authenticate } from "../auth";

export async function handleMcpRequest(req: Request, env: Env): Promise<Response> {
  const identity = await authenticate(req, env);
  if (!identity && !(env.DEPLOY_PROFILE === "minimal" && !env.API_KEY)) {
    if (!identity) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  if (req.method === "GET") {
    return Response.json({
      name: "aston-os-governance",
      version: "15.5.0",
      status: "stub",
      message: "MCP tools se reactivan tras el primer deploy estable",
      tools: ["cascade_impact", "swarm_plan", "safety_evaluate", "extraction_certify"],
    });
  }

  if (req.method === "POST") {
    try {
      const body = await req.json<any>();
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "aston-os-governance", version: "15.5.0" },
          },
        });
      }
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "cascade_impact", description: "Impacto en cascada" },
              { name: "swarm_plan", description: "Plan de swarm" },
              { name: "safety_evaluate", description: "Evaluar acción" },
            ],
          },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: "MCP stub activo. Deploy minimal OK." }],
        },
      });
    } catch {
      return Response.json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
      });
    }
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
}
