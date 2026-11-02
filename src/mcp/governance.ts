/**
 * MCP Governance Server — Aston OS 15.5
 * Expone las capacidades soberanas (ontología, impacto, simulación, linaje, auditoría)
 * como tools MCP para que cualquier cliente (Claude, Cursor, agentes de terceros)
 * pueda usar Aston OS como árbitro neutral de gobernanza.
 *
 * Spec: MCP 2025/2026 Streamable HTTP
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Identity } from "../types";
import { authenticate } from "../auth";
import { getLineageTree } from "../lineage";
import {
  createObject,
  createLink,
  findObjectsByProperty,
  cascadeImpact,
} from "../ontology";
import { emitLineage } from "../lineage";

export function createGovernanceServer(env: Env, identity: Identity) {
  const server = new McpServer({
    name: "aston-os-governance",
    version: "15.5.0",
  });

  // ─────────────────────────────────────────────
  // Tool: cascade_impact
  // ─────────────────────────────────────────────
  server.tool(
    "cascade_impact",
    "Calcula el impacto en cascada (bitemporal) de un objeto raíz sobre el grafo de ontología. Devuelve nodos afectados con profundidad.",
    {
      root_id: z.string().describe("ID del objeto raíz"),
      at_ts: z.number().optional().describe("Timestamp histórico (ms). Default: ahora"),
    },
    async ({ root_id, at_ts }) => {
      const impact = await cascadeImpact(
        env,
        identity.tenant,
        root_id,
        at_ts ?? Date.now()
      );
      await emitLineage(env, {
        object_id: root_id,
        transformation: "mcp.cascade_impact",
        pipeline_version: "v15.5",
        actor: identity.actor,
        metadata: { tool: "cascade_impact", depth: impact?.length ?? 0 },
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ root_id, impact, tenant: identity.tenant }, null, 2),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: get_lineage
  // ─────────────────────────────────────────────
  server.tool(
    "get_lineage",
    "Obtiene el árbol de linaje (provenance) de un objeto hasta cierta profundidad.",
    {
      object_id: z.string().describe("ID del objeto"),
      depth: z.number().min(1).max(10).optional().describe("Profundidad máxima (default 5)"),
    },
    async ({ object_id, depth }) => {
      const tree = await getLineageTree(env, object_id, depth ?? 5);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ object_id, events: tree }, null, 2),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: find_objects
  // ─────────────────────────────────────────────
  server.tool(
    "find_objects",
    "Busca objetos de un tipo por propiedad (JSON extract).",
    {
      type_id: z.string().describe("ID del object type"),
      key: z.string().describe("Clave de la propiedad"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("Valor a buscar"),
    },
    async ({ type_id, key, value }) => {
      const rows = await findObjectsByProperty(env, identity, type_id, key, value);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: rows.length, objects: rows }, null, 2),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: create_object (requiere clearance + role)
  // ─────────────────────────────────────────────
  server.tool(
    "create_object",
    "Crea un nuevo objeto en la ontología. Requiere rol executor o admin y clearance >= confidential.",
    {
      type_id: z.string(),
      properties: z.record(z.unknown()).describe("Propiedades del objeto"),
    },
    async ({ type_id, properties }) => {
      if (!identity.roles.includes("executor") && !identity.roles.includes("admin")) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "role not allowed" }) }],
          isError: true,
        };
      }
      if (identity.clearance !== "confidential" && identity.clearance !== "secret") {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "insufficient clearance" }) }],
          isError: true,
        };
      }
      const id = await createObject(env, identity, { type_id, properties });
      return {
        content: [{ type: "text", text: JSON.stringify({ created: id }) }],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: create_link
  // ─────────────────────────────────────────────
  server.tool(
    "create_link",
    "Crea un link (relación) entre dos objetos.",
    {
      from_id: z.string(),
      to_id: z.string(),
      type: z.string().describe("Tipo de relación"),
      properties: z.record(z.unknown()).optional(),
    },
    async ({ from_id, to_id, type, properties }) => {
      if (!identity.roles.includes("executor") && !identity.roles.includes("admin")) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "role not allowed" }) }],
          isError: true,
        };
      }
      const id = await createLink(env, identity, {
        from_id,
        to_id,
        type,
        properties,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ created: id }) }],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: run_simulation
  // ─────────────────────────────────────────────
  server.tool(
    "run_simulation",
    "Inicia una simulación (Decision Twin). Carga el snapshot actual del tenant y devuelve simId.",
    {
      scenario: z.record(z.unknown()).optional().describe("Descripción del escenario"),
    },
    async ({ scenario }) => {
      const simId = `sim_${crypto.randomUUID()}`;
      const rows = await env.DB.prepare(
        "SELECT id, type_id, properties FROM objects WHERE tenant = ? AND valid_to IS NULL LIMIT 200"
      )
        .bind(identity.tenant)
        .all();

      const stub = env.SIMULATION.get(env.SIMULATION.idFromName(simId));
      await stub.fetch("https://do/init", {
        method: "POST",
        body: JSON.stringify({ objects: rows.results }),
      });

      await env.DB.prepare(
        "INSERT INTO simulations (id, tenant, scenario, status, created_at, created_by) VALUES (?, ?, ?, 'active', ?, ?)"
      )
        .bind(simId, identity.tenant, JSON.stringify(scenario ?? {}), Date.now(), identity.actor)
        .run();

      await emitLineage(env, {
        object_id: simId,
        transformation: "mcp.run_simulation",
        pipeline_version: "v15.5",
        actor: identity.actor,
        metadata: { tool: "run_simulation" },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              simId,
              loaded_objects: rows.results?.length ?? 0,
              message: "Simulación iniciada. Usa apply_simulation_delta y evaluate_simulation.",
            }),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: apply_simulation_delta
  // ─────────────────────────────────────────────
  server.tool(
    "apply_simulation_delta",
    "Aplica un cambio (delta) dentro de una simulación existente.",
    {
      sim_id: z.string(),
      op: z.enum(["update_object", "delete_object"]),
      payload: z.record(z.unknown()),
    },
    async ({ sim_id, op, payload }) => {
      const stub = env.SIMULATION.get(env.SIMULATION.idFromName(sim_id));
      const res = await stub.fetch("https://do/apply", {
        method: "POST",
        body: JSON.stringify({ op, payload }),
      });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: evaluate_simulation
  // ─────────────────────────────────────────────
  server.tool(
    "evaluate_simulation",
    "Evalúa el estado actual de una simulación respondiendo a una pregunta de impacto/riesgo.",
    {
      sim_id: z.string(),
      question: z.string().describe("Pregunta sobre impacto, riesgos o recomendación"),
    },
    async ({ sim_id, question }) => {
      const stub = env.SIMULATION.get(env.SIMULATION.idFromName(sim_id));
      const res = await stub.fetch("https://do/evaluate", {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: audit_log
  // ─────────────────────────────────────────────
  server.tool(
    "audit_log",
    "Devuelve las últimas entradas del audit log del sistema.",
    {
      limit: z.number().min(1).max(100).optional().describe("Cantidad de entradas (default 30)"),
    },
    async ({ limit }) => {
      const rows = await env.DB.prepare(
        "SELECT ts, action, actor, detail FROM audit_log ORDER BY id DESC LIMIT ?"
      )
        .bind(limit ?? 30)
        .all();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ entries: rows.results }, null, 2),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // Tool: swarm_plan
  // ─────────────────────────────────────────────
  server.tool(
    "swarm_plan",
    "Lanza un plan de swarm (Supervisor) para resolver un objetivo complejo con múltiples agentes especializados.",
    {
      objective: z.string().describe("Objetivo a planificar y ejecutar"),
    },
    async ({ objective }) => {
      const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(identity.tenant));
      const res = await stub.fetch("https://do/plan", {
        method: "POST",
        body: JSON.stringify({ objective, identity }),
      });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}

/**
 * Handler principal para el endpoint /mcp
 * Autentica la request y sirve el MCP server con las tools de gobernanza.
 */
export async function handleMcpRequest(req: Request, env: Env): Promise<Response> {
  const identity = await authenticate(req, env);
  if (!identity) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const server = createGovernanceServer(env, identity);

  if (req.method === "POST") {
    try {
      const body = await req.json<any>();

      if (body.method === "tools/list") {
        const tools = [
          { name: "cascade_impact", description: "Impacto en cascada bitemporal" },
          { name: "get_lineage", description: "Árbol de linaje / provenance" },
          { name: "find_objects", description: "Búsqueda de objetos por propiedad" },
          { name: "create_object", description: "Crear objeto (requiere clearance)" },
          { name: "create_link", description: "Crear relación entre objetos" },
          { name: "run_simulation", description: "Iniciar Decision Twin" },
          { name: "apply_simulation_delta", description: "Aplicar delta a simulación" },
          { name: "evaluate_simulation", description: "Evaluar impacto de simulación" },
          { name: "audit_log", description: "Últimas entradas de auditoría" },
          { name: "swarm_plan", description: "Planificar y ejecutar swarm de agentes" },
        ];
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools },
        });
      }

      if (body.method === "tools/call") {
        const toolName = body.params?.name;
        const args = body.params?.arguments ?? {};

        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              {
                type: "text",
                text: `Tool "${toolName}" recibida con args: ${JSON.stringify(args)}. Identity: ${identity.actor} (${identity.clearance})`,
              },
            ],
          },
        });
      }

      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: {
              name: "aston-os-governance",
              version: "15.5.0",
            },
          },
        });
      }

      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "Method not found" },
      });
    } catch (e) {
      return Response.json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
      });
    }
  }

  // GET → información del server
  return Response.json({
    name: "aston-os-governance",
    version: "15.5.0",
    description: "Sovereign Decision OS — MCP Governance Server by Hector Zapata",
    tools: [
      "cascade_impact",
      "get_lineage",
      "find_objects",
      "create_object",
      "create_link",
      "run_simulation",
      "apply_simulation_delta",
      "evaluate_simulation",
      "audit_log",
      "swarm_plan",
    ],
    identity: {
      actor: identity.actor,
      clearance: identity.clearance,
      tenant: identity.tenant,
    },
  });
}
