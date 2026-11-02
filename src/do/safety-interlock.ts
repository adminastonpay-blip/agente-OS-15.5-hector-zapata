/**
 * SafetyInterlock Durable Object — Aston OS 15.5
 *
 * Capa de seguridad que:
 * 1. Evalúa cada acción propuesta (policy engine)
 * 2. Puede exigir aprobación humana (human-in-the-loop)
 * 3. Registra todo en journal + lineage
 * 4. (Opcional) Ejecuta código no confiable dentro de un Sandbox aislado
 *
 * Listo para integrar Cloudflare Containers / Sandbox SDK cuando el binding esté disponible.
 */

import type { Env, Identity } from "../types";
import { evaluatePolicy, type ProposedAction, type PolicyResult } from "../safety/policy";
import { emitLineage } from "../lineage";

export class SafetyInterlock {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        action_json TEXT,
        identity_json TEXT,
        policy_json TEXT,
        created_at INTEGER,
        expires_at INTEGER,
        status TEXT,
        decided_by TEXT,
        decided_at INTEGER
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS execution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        action_tool TEXT,
        decision TEXT,
        risk TEXT,
        score INTEGER,
        actor TEXT,
        detail TEXT
      )
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);

    if (u.pathname === "/evaluate" && req.method === "POST") {
      const body = await req.json<{ action: ProposedAction; identity: Identity }>();
      return Response.json(await this.evaluateAndGate(body.action, body.identity));
    }

    if (u.pathname === "/pending" && req.method === "GET") {
      const rows = this.sql
        .exec(
          `SELECT id, action_json, policy_json, created_at, expires_at, status
           FROM pending_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`
        )
        .toArray() as any[];
      return Response.json({
        pending: rows.map((r) => ({
          id: r.id,
          action: JSON.parse(r.action_json),
          policy: JSON.parse(r.policy_json),
          created_at: r.created_at,
          expires_at: r.expires_at,
        })),
      });
    }

    if (u.pathname === "/decide" && req.method === "POST") {
      const { approval_id, approved, operator } = await req.json<{
        approval_id: string;
        approved: boolean;
        operator: string;
      }>();
      return Response.json(await this.decide(approval_id, approved, operator));
    }

    if (u.pathname === "/sandbox/exec" && req.method === "POST") {
      const body = await req.json<{
        code: string;
        language?: "javascript" | "python" | "bash";
        identity: Identity;
        timeout_ms?: number;
      }>();
      return Response.json(await this.sandboxExec(body));
    }

    if (u.pathname === "/log" && req.method === "GET") {
      const limit = parseInt(u.searchParams.get("limit") ?? "30");
      const rows = this.sql
        .exec(
          `SELECT ts, action_tool, decision, risk, score, actor, detail
           FROM execution_log ORDER BY id DESC LIMIT ?`,
          limit
        )
        .toArray();
      return Response.json({ entries: rows });
    }

    return new Response("not found", { status: 404 });
  }

  private async evaluateAndGate(action: ProposedAction, identity: Identity) {
    const policy = evaluatePolicy(action, identity);

    this.sql.exec(
      `INSERT INTO execution_log (ts, action_tool, decision, risk, score, actor, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      action.tool,
      policy.decision,
      policy.risk,
      policy.score,
      identity.actor,
      JSON.stringify(policy.reasons)
    );

    await emitLineage(this.env, {
      object_id: `safety_${crypto.randomUUID()}`,
      transformation: `safety.${policy.decision}`,
      pipeline_version: "v15.5",
      actor: identity.actor,
      metadata: {
        tool: action.tool,
        risk: policy.risk,
        score: policy.score,
        reasons: policy.reasons,
      },
    });

    if (policy.decision === "allow") {
      return {
        status: "allowed",
        policy,
        message: "Acción permitida por política de seguridad",
      };
    }

    if (policy.decision === "deny") {
      return {
        status: "denied",
        policy,
        message: "Acción denegada por política de seguridad",
      };
    }

    const id = `apr_${crypto.randomUUID()}`;
    const now = Date.now();
    const expires = now + (policy.expires_in_ms ?? 4 * 60 * 60 * 1000);

    this.sql.exec(
      `INSERT INTO pending_approvals
       (id, action_json, identity_json, policy_json, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      id,
      JSON.stringify(action),
      JSON.stringify(identity),
      JSON.stringify(policy),
      now,
      expires
    );

    return {
      status: "pending_approval",
      approval_id: id,
      policy,
      expires_at: expires,
      message: "Acción requiere aprobación humana. Use POST /decide",
    };
  }

  private async decide(approvalId: string, approved: boolean, operator: string) {
    const row = this.sql
      .exec(`SELECT * FROM pending_approvals WHERE id = ?`, approvalId)
      .toArray()[0] as any;

    if (!row) return { error: "approval not found", status: 404 };
    if (row.status !== "pending") return { error: `already ${row.status}`, status: 409 };
    if (Date.now() > row.expires_at) {
      this.sql.exec(`UPDATE pending_approvals SET status = 'expired' WHERE id = ?`, approvalId);
      return { error: "approval expired", status: 410 };
    }

    const newStatus = approved ? "approved" : "rejected";
    this.sql.exec(
      `UPDATE pending_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      newStatus, operator, Date.now(), approvalId
    );

    this.sql.exec(
      `INSERT INTO execution_log (ts, action_tool, decision, risk, score, actor, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      JSON.parse(row.action_json).tool,
      newStatus,
      JSON.parse(row.policy_json).risk,
      JSON.parse(row.policy_json).score,
      operator,
      `Human decision by ${operator}`
    );

    await emitLineage(this.env, {
      object_id: approvalId,
      transformation: `safety.human_${newStatus}`,
      pipeline_version: "v15.5",
      actor: operator,
      metadata: { original_actor: JSON.parse(row.identity_json).actor },
    });

    return {
      status: newStatus,
      approval_id: approvalId,
      action: JSON.parse(row.action_json),
      decided_by: operator,
    };
  }

  private async sandboxExec(opts: {
    code: string;
    language?: "javascript" | "python" | "bash";
    identity: Identity;
    timeout_ms?: number;
  }) {
    const action: ProposedAction = {
      tool: "run_code",
      args: {
        language: opts.language ?? "javascript",
        code_preview: opts.code.slice(0, 200),
        length: opts.code.length,
      },
    };

    const gate = await this.evaluateAndGate(action, opts.identity);

    if (gate.status === "denied") {
      return { status: "denied", reason: gate.policy?.reasons };
    }
    if (gate.status === "pending_approval") {
      return {
        status: "pending_approval",
        approval_id: gate.approval_id,
        message: "Ejecución de código requiere aprobación humana",
      };
    }

    // Placeholder fail-closed hasta activar Containers binding
    return {
      status: "sandbox_ready",
      message:
        "SafetyInterlock listo. Active el binding de Containers en wrangler.toml para ejecución real de código no confiable.",
      policy: gate.policy,
      note: "Fail-closed: no se ejecuta código hasta que el sandbox esté configurado.",
    };
  }
}
