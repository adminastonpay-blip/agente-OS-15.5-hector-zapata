import type { D1Database } from "@cloudflare/workers-types";

type AccessPrincipal = { kind: "access"; verified: true; principalId: string; issuer: string; subject: string };
type CredentialPrincipal = { kind: "api_key" | "sensor"; verified: true; principalId: string; credentialId: string };
export type VerifiedPrincipal = AccessPrincipal | CredentialPrincipal;

export interface TenantIdentityAuthorityRecord {
  tenant: { tenantId: string; status: string; notBefore?: number; expiresAt?: number };
  membership: {
    tenantId: string; principalId: string; status: string;
    capabilities: string[]; audiences: string[];
    notBefore?: number; expiresAt?: number;
  };
  authMethod: "access" | "apikey" | "sensor";
}

function parseStringArray(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.length > 0)
      ? parsed : null;
  } catch { return null; }
}
function safeTenant(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
    && value !== "default" && value !== "ops" && !value.startsWith("unassigned-");
}

/**
 * Read-only D1 authority provider. It does not provision or mutate credentials.
 * Inputs must come from authenticateWithContext(), never request fields.
 */
export function createD1TenantIdentityAuthority(db: D1Database) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("D1 database binding required");

  return Object.freeze({
    async resolve(principal: VerifiedPrincipal): Promise<TenantIdentityAuthorityRecord | null> {
      if (!principal || principal.verified !== true) return null;
      let row: Record<string, unknown> | null;
      if (principal.kind === "access") {
        if (!principal.issuer || !principal.subject) return null;
        row = await db.prepare(`
          SELECT b.tenant_id, b.auth_method, b.status AS membership_status,
                 b.capabilities_json, b.audiences_json, b.not_before AS membership_not_before,
                 b.expires_at AS membership_expires_at,
                 t.status AS tenant_status
          FROM aston_tenant_identity_bindings b
          JOIN aston_tenants t ON t.tenant_id = b.tenant_id
          WHERE b.auth_method = 'access' AND b.issuer = ? AND b.subject = ?
          LIMIT 2
        `).bind(principal.issuer, principal.subject).first<Record<string, unknown>>();
      } else {
        if (!/^sha256:[a-f0-9]{64}$/.test(principal.credentialId)) return null;
        const method = principal.kind === "api_key" ? "apikey" : "sensor";
        row = await db.prepare(`
          SELECT b.tenant_id, b.auth_method, b.status AS membership_status,
                 b.capabilities_json, b.audiences_json, b.not_before AS membership_not_before,
                 b.expires_at AS membership_expires_at,
                 t.status AS tenant_status
          FROM aston_tenant_identity_bindings b
          JOIN aston_tenants t ON t.tenant_id = b.tenant_id
          WHERE b.auth_method = ? AND b.credential_id = ?
          LIMIT 2
        `).bind(method, principal.credentialId).first<Record<string, unknown>>();
      }
      if (!row || !safeTenant(row.tenant_id) || typeof row.auth_method !== "string" ||
          typeof row.tenant_status !== "string" || typeof row.membership_status !== "string") return null;
      const capabilities = parseStringArray(row.capabilities_json);
      const audiences = parseStringArray(row.audiences_json);
      if (!capabilities || !audiences) return null;
      const membership: TenantIdentityAuthorityRecord["membership"] = {
        tenantId: row.tenant_id, principalId: principal.principalId,
        status: row.membership_status, capabilities, audiences,
      };
      if (typeof row.membership_not_before === "number") membership.notBefore = row.membership_not_before;
      if (typeof row.membership_expires_at === "number") membership.expiresAt = row.membership_expires_at;
      const tenant: TenantIdentityAuthorityRecord["tenant"] = {
        tenantId: row.tenant_id, status: row.tenant_status,
      };
      return { tenant, membership, authMethod: row.auth_method as TenantIdentityAuthorityRecord["authMethod"] };
    }
  });
}
