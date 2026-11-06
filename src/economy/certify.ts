/**
 * Certification of AI-generated code / recipes before production use.
 */
import type { Env, Identity } from "../types";
import { chat } from "../lib/ai";

export interface CertResult {
  certificate_id: string;
  status: "certified" | "rejected" | "review";
  score: number;
  findings: string[];
  issued_at: number;
  expires_at: number;
  tool_id?: string;
}

const DANGEROUS = [
  /eval\s*\(/i,
  /Function\s*\(/i,
  /child_process/i,
  /process\.env/i,
  /fs\.\w+/i,
  /net\.Socket/i,
  /fetch\s*\(\s*['"]https?:\/\/(?!workers\.dev)/i,
  /WebSocket/i,
  /\bexec\b/i,
  /atob\s*\(\s*['"][A-Za-z0-9+/=]{80,}/i,
];

export function staticScan(code: string): { score: number; findings: string[] } {
  const findings: string[] = [];
  let score = 100;
  for (const re of DANGEROUS) {
    if (re.test(code)) {
      findings.push(`pattern:${re.source.slice(0, 40)}`);
      score -= 25;
    }
  }
  if (code.length > 20000) {
    findings.push("code_too_large");
    score -= 10;
  }
  if (!findings.length) findings.push("no_static_danger_patterns");
  return { score: Math.max(0, score), findings };
}

export async function certifyArtifact(
  env: Env,
  identity: Identity,
  opts: { code?: string; recipe?: unknown; tool_id?: string; name?: string }
): Promise<CertResult> {
  const code = String(opts.code || JSON.stringify(opts.recipe || {})).slice(0, 30000);
  const staticR = staticScan(code);

  let aiNote = "";
  try {
    const r = await chat(
      env,
      [
        {
          role: "system",
          content:
            "Sos certificador de seguridad de código generado por IA. Listá riesgos en 5 viñetas máx. Sé estricto. Español.",
        },
        {
          role: "user",
          content: `Artefacto:\n${code.slice(0, 4000)}`,
        },
      ],
      { max_tokens: 350, temp: 0.1 }
    );
    aiNote = r.response || "";
  } catch {
    aiNote = "ai_review_unavailable";
  }

  const findings = [...staticR.findings];
  if (/malware|backdoor|exfil|credential/i.test(aiNote)) {
    findings.push("ai_flagged_risk_language");
    staticR.score -= 20;
  }

  let status: CertResult["status"] = "certified";
  if (staticR.score < 40) status = "rejected";
  else if (staticR.score < 70) status = "review";

  const cert: CertResult = {
    certificate_id: `cert_${crypto.randomUUID().slice(0, 12)}`,
    status,
    score: Math.max(0, staticR.score),
    findings: findings.slice(0, 12),
    issued_at: Date.now(),
    expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
    tool_id: opts.tool_id,
  };

  // Optional SafetyInterlock log
  if (env.SAFETY) {
    try {
      const stub = env.SAFETY.get(env.SAFETY.idFromName(`${identity.tenant || "default"}::safety`));
      await stub.fetch("https://do/evaluate", {
        method: "POST",
        body: JSON.stringify({
          action: {
            tool: "code_certify",
            args: { certificate_id: cert.certificate_id, status: cert.status, score: cert.score },
          },
          identity,
        }),
      });
    } catch {
      /* ignore */
    }
  }

  if (env.DB) {
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS code_certs (
          id TEXT PRIMARY KEY,
          tenant TEXT,
          payload TEXT,
          status TEXT,
          ts INTEGER
        )`
      ).run();
      await env.DB.prepare(
        `INSERT INTO code_certs (id, tenant, payload, status, ts) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          cert.certificate_id,
          identity.tenant || "default",
          JSON.stringify({ ...cert, ai_note: aiNote.slice(0, 500) }),
          cert.status,
          cert.issued_at
        )
        .run();
    } catch (e) {
      console.error("[CERT]", String(e));
    }
  }

  return cert;
}
