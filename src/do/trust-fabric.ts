import type { Env, Identity } from "../types";
import { evaluateTrustAccess, type TrustRule, type TrustEffect } from "../core/trust-fabric";

const TENANT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9:_-]{1,63}$/;
const TOOL_PATTERN = /^(\*|[a-z][a-z0-9_.*:-]{1,127})$/;

export class TrustFabric {
  private sql: SqlStorage;
  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tenant_role_grants (
      actor TEXT NOT NULL, role TEXT NOT NULL, granted_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, revoked_at INTEGER,
      PRIMARY KEY(actor, role))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tenant_policy_rules (
      tool TEXT PRIMARY KEY, effect TEXT NOT NULL, required_roles_json TEXT NOT NULL,
      enabled INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const body = await req.json<any>().catch(() => null);
    if (!body || typeof body.tenant !== "string" || !TENANT_PATTERN.test(body.tenant)) {
      return Response.json({ error: "invalid_tenant" }, { status: 400 });
    }
    const boundTenant = await this.state.storage.get<string>("tenant_id");
    if (boundTenant && boundTenant !== body.tenant) return Response.json({ error: "tenant_partition_mismatch" }, { status: 403 });
    if (!boundTenant) await this.state.storage.put("tenant_id", body.tenant);

    if (url.pathname === "/authorize") {
      if (typeof body.actor !== "string" || !body.actor || body.actor.length > 128 ||
          typeof body.tool !== "string" || !TOOL_PATTERN.test(body.tool) ||
          !Array.isArray(body.roles) || body.roles.length > 32 ||
          !body.roles.every((role: unknown) => typeof role === "string" && ROLE_PATTERN.test(role))) {
        return Response.json({ error: "invalid_trust_request" }, { status: 400 });
      }
      const grants = this.sql.exec(
        "SELECT role FROM tenant_role_grants WHERE actor = ? AND revoked_at IS NULL", body.actor
      ).toArray() as Array<{ role: string }>;
      const rules = this.sql.exec(
        "SELECT tool, effect, required_roles_json, enabled FROM tenant_policy_rules WHERE enabled = 1"
      ).toArray() as Array<{ tool: string; effect: TrustEffect; required_roles_json: string; enabled: number }>;
      const identity: Identity = {
        actor: body.actor, tenant: body.tenant, method: "access",
        roles: body.roles, clearance: body.clearance ?? "public",
      };
      const evaluation = evaluateTrustAccess(identity, body.tool, grants.map((row) => row.role),
        rules.map((row) => ({ tool: row.tool, effect: row.effect, required_roles: JSON.parse(row.required_roles_json), enabled: !!row.enabled })));
      return Response.json({ ok: true, ...evaluation });
    }

    const identity = body.identity as Identity | undefined;
    if (!identity || identity.tenant !== body.tenant || !Array.isArray(identity.roles) ||
        !identity.roles.includes("admin") || typeof identity.actor !== "string" || !identity.actor) {
      return Response.json({ error: "verified_tenant_admin_required" }, { status: 403 });
    }

    if (url.pathname === "/roles/grant" || url.pathname === "/roles/revoke") {
      if (typeof body.actor !== "string" || !body.actor || body.actor.length > 128 ||
          typeof body.role !== "string" || !ROLE_PATTERN.test(body.role) ||
          ["admin", "root", "owner"].includes(body.role)) {
        return Response.json({ error: "invalid_role_grant" }, { status: 400 });
      }
      if (url.pathname === "/roles/grant") {
        this.sql.exec(`INSERT INTO tenant_role_grants (actor, role, granted_by, created_at, revoked_at)
          VALUES (?, ?, ?, ?, NULL) ON CONFLICT(actor, role) DO UPDATE SET granted_by=excluded.granted_by,
          created_at=excluded.created_at, revoked_at=NULL`, body.actor, body.role, identity.actor, Date.now());
      } else {
        this.sql.exec("UPDATE tenant_role_grants SET revoked_at = ? WHERE actor = ? AND role = ? AND revoked_at IS NULL",
          Date.now(), body.actor, body.role);
      }
      return Response.json({ ok: true, tenant: body.tenant, actor: body.actor, role: body.role });
    }

    if (url.pathname === "/policies/set") {
      const rule = body.rule as TrustRule | undefined;
      if (!rule || typeof rule.tool !== "string" || !TOOL_PATTERN.test(rule.tool) ||
          !["allow", "deny", "require_approval"].includes(rule.effect) ||
          !Array.isArray(rule.required_roles) || rule.required_roles.length > 32 ||
          !rule.required_roles.every((role: unknown) => typeof role === "string" && ROLE_PATTERN.test(role)) ||
          typeof rule.enabled !== "boolean") {
        return Response.json({ error: "invalid_policy_rule" }, { status: 400 });
      }
      this.sql.exec(`INSERT INTO tenant_policy_rules (tool, effect, required_roles_json, enabled, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tool) DO UPDATE SET effect=excluded.effect,
        required_roles_json=excluded.required_roles_json, enabled=excluded.enabled,
        updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
        rule.tool, rule.effect as TrustEffect, JSON.stringify(rule.required_roles), rule.enabled ? 1 : 0,
        identity.actor, Date.now());
      return Response.json({ ok: true, tenant: body.tenant, rule });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
