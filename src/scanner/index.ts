import type { Env } from "../types";

export interface ScannerVulnerability {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
  evidence: string;
}

const MAX_HTML_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 2;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".test") || host.endsWith(".invalid")) return true;

  // Reject IP literals entirely. This avoids direct access to RFC1918, loopback,
  // link-local, multicast and other non-public address ranges.
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return true;
  if (!host.includes(".") || host.length > 253) return true;
  return false;
}

function validateTarget(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (url.port && url.port !== "80" && url.port !== "443") return null;
    if (isBlockedHostname(url.hostname)) return null;
    // Avoid non-standard ports and ambiguous host encodings.
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 203 && b === 0 && parts[2] === 113));
}

function isPublicIp(ip: string): boolean {
  if (ip.includes(":")) {
    const value = ip.toLowerCase();
    // Only global-unicast 2000::/3 is accepted; mapped, loopback, ULA,
    // link-local, multicast and documentation ranges are rejected.
    if (value.startsWith("::ffff:") || !/^[23]/.test(value)) return false;
    if (value.startsWith("2001:db8:")) return false;
    return true;
  }
  return isPublicIpv4(ip);
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<string[] | null> {
  const answers: string[] = [];
  for (const type of ["A", "AAAA"]) {
    try {
      const endpoint = new URL("https://cloudflare-dns.com/dns-query");
      endpoint.searchParams.set("name", hostname);
      endpoint.searchParams.set("type", type);
      const response = await fetch(endpoint, {
        headers: { "Accept": "application/dns-json" },
        signal,
      });
      if (!response.ok) return null;
      const data = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      if (data.Status !== 0) {
        // NOERROR with no answers is valid for one address family.
        if (data.Status === 3) continue;
        return null;
      }
      for (const answer of data.Answer || []) {
        if ((type === "A" && answer.type === 1) || (type === "AAAA" && answer.type === 28)) {
          if (!answer.data || !isPublicIp(answer.data)) return null;
          answers.push(answer.data.toLowerCase());
        }
      }
    } catch { return null; }
  }
  return answers.length ? [...new Set(answers)].sort() : null;
}

async function assertStablePublicDns(hostname: string, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  const first = await resolvePublicAddresses(hostname, AbortSignal.timeout(remaining));
  if (!first) return false;
  const secondRemaining = deadline - Date.now();
  if (secondRemaining <= 0) return false;
  const second = await resolvePublicAddresses(hostname, AbortSignal.timeout(secondRemaining));
  if (!second) return false;
  return first.length === second.length && first.every((ip, index) => ip === second[index]);
}

async function fetchPublicPage(start: URL): Promise<{ response: Response; html: string } | null> {
  let current = start;
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    if (!await assertStablePublicDns(current.hostname, deadline)) return null;
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(remainingMs),
        headers: {
          "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": "ASTON-AI-Surface-Scanner/1.0 (+passive-security-review)",
        },
      });
    } catch {
      return null;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location || redirects === MAX_REDIRECTS) return null;
      let next: URL | null = null;
      try { next = validateTarget(new URL(location, current).toString()); } catch { return null; }
      if (!next) return null;
      current = next;
      continue;
    }

    const contentType = response.headers.get("Content-Type") || "";
    if (!response.ok || (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml"))) {
      return { response, html: "" };
    }

    const reader = response.body?.getReader();
    if (!reader) return { response, html: "" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_HTML_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(Math.min(total, MAX_HTML_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const slice = chunk.subarray(0, Math.min(chunk.length, bytes.length - offset));
      bytes.set(slice, offset);
      offset += slice.length;
      if (offset >= bytes.length) break;
    }
    return { response, html: new TextDecoder().decode(bytes) };
  }
  return null;
}

function inspect(response: Response, html: string): { score: number; vulnerabilities: ScannerVulnerability[] } {
  const vulnerabilities: ScannerVulnerability[] = [];
  const headers = response.headers;
  const cors = headers.get("Access-Control-Allow-Origin");
  if (cors?.trim() === "*") vulnerabilities.push({
    id: "cors_wildcard", severity: "medium", title: "CORS permite cualquier origen",
    description: "La respuesta anuncia acceso desde cualquier origen. El impacto depende de los endpoints, credenciales y datos expuestos; no demuestra por sí solo que una API sea explotable.",
    evidence: "Access-Control-Allow-Origin: *",
  });
  if (!headers.has("Strict-Transport-Security")) vulnerabilities.push({
    id: "missing_hsts", severity: "medium", title: "Falta Strict-Transport-Security",
    description: "El navegador no recibe una política HSTS desde esta respuesta HTTPS para exigir conexiones seguras futuras.",
    evidence: "Cabecera Strict-Transport-Security ausente",
  });
  if (!headers.has("Content-Security-Policy")) vulnerabilities.push({
    id: "missing_csp", severity: "low", title: "Falta Content-Security-Policy",
    description: "No se observó una política CSP en la respuesta inicial. Esto reduce una capa de defensa del navegador frente a ciertos ataques de inyección.",
    evidence: "Cabecera Content-Security-Policy ausente",
  });

  const patterns: Array<{ id: string; title: string; pattern: RegExp }> = [
    { id: "openai_key_pattern", title: "Posible clave de API de OpenAI expuesta", pattern: /\bsk-(?:proj-|live_|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
    { id: "google_key_pattern", title: "Posible clave de API de Google expuesta", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
    { id: "anthropic_key_pattern", title: "Posible clave de API de Anthropic expuesta", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    { id: "github_token_pattern", title: "Posible token de GitHub expuesto", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  ];
  for (const item of patterns) {
    if (item.pattern.test(html)) vulnerabilities.push({
      id: item.id, severity: "high", title: item.title,
      description: "Se encontró una cadena con formato compatible con un secreto en el HTML público. Puede ser un falso positivo; debe validarse y revocarse si es una credencial real.",
      evidence: "Patrón compatible detectado; el valor fue ocultado y no se almacena ni devuelve.",
    });
    item.pattern.lastIndex = 0;
  }

  const deductions = vulnerabilities.reduce((sum, v) =>
    sum + (v.severity === "high" ? 30 : v.severity === "medium" ? 15 : 7), 0);
  return { score: Math.max(0, 100 - deductions), vulnerabilities };
}

function fallbackReport(score: number, vulnerabilities: ScannerVulnerability[]): string {
  if (!vulnerabilities.length) return "En esta respuesta pública no se detectaron los patrones y cabeceras revisados. Esto no equivale a una auditoría completa ni descarta riesgos en APIs, autenticación, infraestructura o rutas no examinadas.";
  const high = vulnerabilities.filter(v => v.severity === "high").length;
  const medium = vulnerabilities.filter(v => v.severity === "medium").length;
  return `La revisión pasiva detectó ${vulnerabilities.length} hallazgo(s): ${high} de severidad alta y ${medium} media. Las posibles credenciales expuestas deben tratarse como comprometidas hasta verificar lo contrario y, si son reales, revocarse y rotarse. Las cabeceras observadas indican oportunidades de endurecimiento del navegador. Puntaje orientativo: ${score}/100. Se recomienda validar los hallazgos en una evaluación autorizada antes de tomar decisiones.`;
}

async function createAiReport(env: Env, score: number, vulnerabilities: ScannerVulnerability[]): Promise<string> {
  const fallback = fallbackReport(score, vulnerabilities);
  if (!env.AI) return fallback;
  try {
    const model = env.CHAT_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast";
    const result: any = await env.AI.run(model as any, {
      messages: [
        { role: "system", content: "Redactá en español un párrafo ejecutivo, prudente y claro para un responsable de negocio. Explicá impacto potencial y siguiente paso. No afirmes explotación, pérdida económica ni compromiso confirmado. No inventes hallazgos. Aclarà que es una revisión pasiva y limitada." },
        { role: "user", content: JSON.stringify({ score, findings: vulnerabilities.map(v => ({ severity: v.severity, title: v.title, description: v.description })) }) },
      ],
      max_tokens: 180,
    });
    const text = typeof result?.response === "string" ? result.response.trim() : "";
    return text ? text.slice(0, 1400) : fallback;
  } catch {
    return fallback;
  }
}

export async function handleSurfaceScan(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await req.json<{ url?: unknown }>().catch(() => null);
  if (!body || typeof body.url !== "string" || body.url.length > 2048) {
    return json({ error: "invalid_request", message: "Se requiere una URL válida." }, 400);
  }
  const target = validateTarget(body.url.trim());
  if (!target) return json({ error: "invalid_target", message: "Solo se permiten dominios HTTP/HTTPS públicos, sin credenciales ni puertos no estándar." }, 400);

  const fetched = await fetchPublicPage(target);
  if (!fetched) return json({ error: "scan_unavailable", message: "No se pudo obtener una respuesta pública dentro del límite de tiempo o redirecciones." }, 502);

  const { score, vulnerabilities } = inspect(fetched.response, fetched.html);
  const ai_report = await createAiReport(env, score, vulnerabilities);
  const recommendation = vulnerabilities.some(v => v.severity === "high")
    ? "Priorizar la validación y rotación de cualquier credencial real detectada; después revisar cabeceras y repetir la evaluación."
    : vulnerabilities.length
      ? "Planificar el endurecimiento de cabeceras y revisar los endpoints sensibles en una evaluación autorizada."
      : "Mantener controles actualizados y realizar una evaluación autenticada del alcance completo.";
  return json({
    score,
    vulnerabilities,
    ai_report,
    recommendation,
    scan: { mode: "passive", fetched_url: target.origin, http_status: fetched.response.status, html_inspected: fetched.html.length > 0, html_limit_bytes: MAX_HTML_BYTES },
    deep_assessment: {
      available: false,
      requirement: "La evaluación profunda de 7 días requiere verificar la propiedad del dominio mediante un registro DNS TXT único. La verificación todavía no está habilitada en este endpoint.",
      suggested_record: "_aston-verify.<dominio> TXT <token-único-entregado-por-ASTON>",
      status: "ownership_verification_not_implemented",
    },
    disclaimer: "Resultado orientativo basado únicamente en una respuesta HTTP pública. No es pentest, auditoría integral ni certificación. La comprobación DNS reduce el riesgo de respuestas privadas, pero Workers fetch no permite fijar la IP validada a la conexión: no elimina por completo la ventana de DNS rebinding."
  });
}
