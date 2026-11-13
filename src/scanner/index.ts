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

async function fetchPublicPage(start: URL): Promise<{ response: Response; html: string } | null> {
  let current = start;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("scan_timeout"), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "User-Agent": "ASTON-AI-Surface-Scanner/1.0 (+passive-security-review)",
        },
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location || redirects === MAX_REDIRECTS) return null;
      const next = validateTarget(new URL(location, current).toString());
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
    disclaimer: "Resultado orientativo basado únicamente en una respuesta HTTP pública. No es pentest, auditoría integral ni certificación.",
  });
}
