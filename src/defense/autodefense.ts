/**
 * ASTON OS — Autonomous defense orchestration
 * Flow: deterministic collect → light triage → specialized investigate → SafetyInterlock mitigate
 * Human-in-the-loop for high/critical actions (never silent global blocks).
 */
import type { Env, Identity } from "../types";
import { chat } from "../lib/ai";
import { tenantKey } from "../lib/sovereign";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface Evidence {
  source: string;
  kind: string;
  value: string;
  ts?: number;
}

export interface Incident {
  id: string;
  tenant: string;
  title: string;
  severity: Severity;
  status: "open" | "triaged" | "investigating" | "mitigating" | "pending_approval" | "closed" | "false_positive";
  evidence: Evidence[];
  triage?: TriageResult;
  investigation?: string;
  mitigation?: MitigationProposal;
  created_at: number;
  updated_at: number;
}

export interface TriageResult {
  label: "benign" | "suspicious" | "malicious" | "unknown";
  confidence: number;
  reasons: string[];
  severity: Severity;
  auto_close: boolean;
}

export interface MitigationProposal {
  action: string;
  target?: string;
  mode: "observe" | "rate_limit" | "block_ip" | "block_pattern" | "challenge";
  auto_applicable: boolean;
  requires_human: boolean;
  rationale: string;
}

/** Deterministic scoring — no LLM (avoids hallucinated attacks). */
export function deterministicTriage(evidence: Evidence[]): TriageResult {
  const reasons: string[] = [];
  let score = 0;
  const blob = evidence.map((e) => `${e.kind}:${e.value}`.toLowerCase()).join(" | ");

  const rules: { re: RegExp; w: number; why: string }[] = [
    { re: /sql\s*injection|union\s+select|or\s+1=1/i, w: 40, why: "SQLi pattern" },
    { re: /<script|javascript:|onerror=/i, w: 35, why: "XSS pattern" },
    { re: /\.\.\/|%2e%2e/i, w: 30, why: "Path traversal" },
    { re: /prompt\s*injection|ignore\s+previous|jailbreak/i, w: 45, why: "LLM prompt-injection markers" },
    { re: /exfil|exfiltration|data\s*leak/i, w: 40, why: "Exfiltration language" },
    { re: /ddos|flood|amplification/i, w: 25, why: "Flood / DDoS language" },
    { re: /bot|scanner|nikto|sqlmap|masscan/i, w: 20, why: "Scanner / bot markers" },
    { re: /rate.?limit|429|too many requests/i, w: 10, why: "Rate pressure" },
    { re: /401|403|unauthorized|forbidden/i, w: 5, why: "Auth failures" },
  ];

  for (const r of rules) {
    if (r.re.test(blob)) {
      score += r.w;
      reasons.push(r.why);
    }
  }

  // Volume heuristic
  if (evidence.length >= 20) {
    score += 15;
    reasons.push("High evidence volume");
  } else if (evidence.length >= 8) {
    score += 8;
    reasons.push("Elevated evidence volume");
  }

  let severity: Severity = "info";
  let label: TriageResult["label"] = "benign";
  if (score >= 70) {
    severity = "critical";
    label = "malicious";
  } else if (score >= 45) {
    severity = "high";
    label = "malicious";
  } else if (score >= 25) {
    severity = "medium";
    label = "suspicious";
  } else if (score >= 10) {
    severity = "low";
    label = "suspicious";
  }

  if (!reasons.length) reasons.push("No known threat signatures matched");

  return {
    label,
    confidence: Math.min(0.95, 0.35 + score / 100),
    reasons: reasons.slice(0, 8),
    severity,
    auto_close: label === "benign" && score < 8,
  };
}

export function proposeMitigation(triage: TriageResult, evidence: Evidence[]): MitigationProposal {
  const ipEv = evidence.find((e) => /ip|client|src/i.test(e.kind));
  const target = ipEv?.value?.slice(0, 64);

  if (triage.label === "benign") {
    return {
      action: "none",
      mode: "observe",
      auto_applicable: true,
      requires_human: false,
      rationale: "Benign — observe only",
    };
  }

  if (triage.severity === "critical" || triage.severity === "high") {
    return {
      action: target ? `challenge_or_block ${target}` : "challenge_suspicious_pattern",
      target,
      mode: triage.severity === "critical" ? "block_ip" : "challenge",
      auto_applicable: false,
      requires_human: true,
      rationale:
        "High/critical severity — human approval required before edge block (Cloudflare Managed Defense pattern)",
    };
  }

  if (triage.severity === "medium") {
    return {
      action: target ? `rate_limit ${target}` : "rate_limit_pattern",
      target,
      mode: "rate_limit",
      auto_applicable: true,
      requires_human: false,
      rationale: "Medium — auto rate-limit recommendation (soft); escalate if persists",
    };
  }

  return {
    action: "observe",
    mode: "observe",
    auto_applicable: true,
    requires_human: false,
    rationale: "Low — continue monitoring",
  };
}

export async function deepInvestigate(
  env: Env,
  identity: Identity,
  incident: Incident
): Promise<string> {
  const evidenceText = incident.evidence
    .slice(0, 30)
    .map((e) => `- [${e.source}] ${e.kind}: ${e.value}`.slice(0, 200))
    .join("\n");

  const r = await chat(
    env,
    identity,
    [
      {
        role: "system",
        content:
          "Sos el agente Investigador de ASTON OS Defense. Analizá evidencia REAL. " +
          "No inventes IPs ni eventos. Formato: 1) hipótesis 2) indicadores 3) impacto 4) mitigación sugerida 5) si hace falta humano. " +
          "Máximo 12 líneas. Español.",
      },
      {
        role: "user",
        content: `Incidente ${incident.id}\nSeveridad triage: ${incident.triage?.severity}\nLabel: ${incident.triage?.label}\nRazones: ${(incident.triage?.reasons || []).join("; ")}\nEvidencia:\n${evidenceText}`,
      },
    ],
    { max_tokens: 600, temp: 0.1 }
  );
  return r.response || "Sin análisis";
}

export async function persistIncident(env: Env, incident: Incident): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS defense_incidents (
          id TEXT PRIMARY KEY,
          tenant TEXT,
          payload TEXT,
          severity TEXT,
          status TEXT,
          updated_at INTEGER
        )`
      ).run();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO defense_incidents (id, tenant, payload, severity, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          incident.id,
          incident.tenant,
          JSON.stringify(incident),
          incident.severity,
          incident.status,
          incident.updated_at
        )
        .run();
      return;
    } catch (e) {
      console.error("[DEFENSE_D1]", String(e));
    }
  }
  const session = env.SESSION;
  if (!session) {
    console.error("[DEFENSE_DO] SESSION binding unavailable; incident remains unpersisted outside D1");
    return;
  }
  try {
    const stub = session.get(
      session.idFromName(tenantKey({ tenant: incident.tenant } as Identity, "defense"))
    );
    await stub.fetch("https://do/append", {
      method: "POST",
      body: JSON.stringify({
        role: "system",
        content: JSON.stringify({ defense_incident: incident }),
      }),
    });
  } catch (e) {
    console.error("[DEFENSE_DO]", String(e));
  }
}

export async function listIncidents(env: Env, identity: Identity): Promise<Incident[]> {
  if (env.DB) {
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS defense_incidents (
          id TEXT PRIMARY KEY,
          tenant TEXT,
          payload TEXT,
          severity TEXT,
          status TEXT,
          updated_at INTEGER
        )`
      ).run();
      const rows = await env.DB.prepare(
        `SELECT payload FROM defense_incidents WHERE tenant = ? ORDER BY updated_at DESC LIMIT 40`
      )
        .bind(identity.tenant || "default")
        .all();
      return (rows.results || [])
        .map((r: any) => {
          try {
            return JSON.parse(r.payload) as Incident;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Incident[];
    } catch {
      /* fall */
    }
  }
  const session = env.SESSION;
  if (!session) return [];
  try {
    const stub = session.get(
      session.idFromName(tenantKey(identity, "defense"))
    );
    const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
    const out: Incident[] = [];
    for (const h of mem.history || []) {
      try {
        const o = JSON.parse(h.content);
        if (o?.defense_incident?.id) out.push(o.defense_incident);
      } catch {
        /* skip */
      }
    }
    return out.reverse().slice(0, 40);
  } catch {
    return [];
  }
}

export async function gateMitigation(
  env: Env,
  identity: Identity,
  proposal: MitigationProposal,
  incident: Incident
): Promise<{
  status: string;
  approval_id?: string;
  message: string;
  applied_local?: boolean;
}> {
  // Soft local actions never call external CF account API without explicit operator secrets
  if (proposal.mode === "observe" || (proposal.auto_applicable && !proposal.requires_human)) {
    return {
      status: "allowed",
      message: `Mitigación local registrada: ${proposal.mode} — ${proposal.rationale}`,
      applied_local: true,
    };
  }

  if (!env.SAFETY) {
    return {
      status: "pending_approval",
      message:
        "SAFETY DO ausente — mitigación de alto impacto NO aplicada (fail-closed). Aprobación humana obligatoria.",
    };
  }

  try {
    const stub = env.SAFETY.get(env.SAFETY.idFromName(tenantKey(identity, "safety")));
    const res = await stub.fetch("https://do/evaluate", {
      method: "POST",
      body: JSON.stringify({
        action: {
          tool: "defense_mitigate",
          args: {
            mode: proposal.mode,
            target: proposal.target,
            incident_id: incident.id,
            severity: incident.severity,
          },
          context: { objective: proposal.rationale },
        },
        identity,
      }),
    });
    const gate = (await res.json()) as any;
    return {
      status: gate.status || "unknown",
      approval_id: gate.approval_id,
      message: gate.message || JSON.stringify(gate.policy?.reasons || []),
    };
  } catch (e: any) {
    return {
      status: "denied",
      message: `SafetyInterlock error: ${String(e?.message || e).slice(0, 120)}`,
    };
  }
}

export function normalizeEvidence(body: any): Evidence[] {
  if (Array.isArray(body.evidence)) {
    return body.evidence
      .filter((e: any) => e && (e.value || e.message))
      .slice(0, 50)
      .map((e: any) => ({
        source: String(e.source || "client").slice(0, 64),
        kind: String(e.kind || e.type || "event").slice(0, 64),
        value: String(e.value || e.message || "").slice(0, 500),
        ts: typeof e.ts === "number" ? e.ts : Date.now(),
      }));
  }
  // Accept flat event
  const value = String(body.message || body.log || body.event || "").slice(0, 500);
  if (!value) return [];
  return [
    {
      source: String(body.source || "ingest").slice(0, 64),
      kind: String(body.kind || "event").slice(0, 64),
      value,
      ts: Date.now(),
    },
  ];
}
