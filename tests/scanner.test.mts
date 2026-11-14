import test from "node:test";
import assert from "node:assert/strict";
import { handleSurfaceScan } from "../src/scanner/index.ts";
import { handleEnterpriseAudit } from "../src/scanner/enterprise-audit.ts";

test("rejects private, local and non-http targets without fetching", async () => {
  for (const url of ["http://127.0.0.1", "http://localhost", "http://192.168.1.10", "file:///etc/passwd", "https://example.com:8443"]) {
    const response = await handleSurfaceScan(new Request("https://worker.test/api/scan", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }),
    }), {} as any);
    assert.equal(response.status, 400, url);
  }
});

test("rejects malformed payloads", async () => {
  const response = await handleSurfaceScan(new Request("https://worker.test/api/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: 123 }),
  }), {} as any);
  assert.equal(response.status, 400);
});

test("returns findings and redacts detected key values", async () => {
  const originalFetch = globalThis.fetch;
  const fakeKey = "sk-proj-" + "A".repeat(32);
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const requestUrl = String(input);
    if (requestUrl.startsWith("https://cloudflare-dns.com/")) {
      const type = new URL(requestUrl).searchParams.get("type");
      return Response.json({ Status: 0, Answer: type === "A"
        ? [{ type: 1, data: "93.184.216.34" }]
        : [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }] });
    }
    return new Response("<html><script>const key='" + fakeKey + "'</script></html>", {
      status: 200, headers: { "content-type": "text/html", "Access-Control-Allow-Origin": "*",
        "Strict-Transport-Security": "max-age=31536000" },
    });
  };
  try {
    const response = await handleSurfaceScan(new Request("https://worker.test/api/scan", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }),
    }), {} as any);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.ok(body.vulnerabilities.some((v: any) => v.id === "openai_key_pattern"));
    assert.ok(!JSON.stringify(body).includes(fakeKey));
    assert.ok(body.score >= 0 && body.score <= 100);
  } finally { globalThis.fetch = originalFetch; }
});

test("follows no redirect to an internal target", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const requestUrl = String(input);
    if (requestUrl.startsWith("https://cloudflare-dns.com/")) {
      const type = new URL(requestUrl).searchParams.get("type");
      return Response.json({ Status: 0, Answer: type === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] });
    }
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  };
  try {
    const response = await handleSurfaceScan(new Request("https://worker.test/api/scan", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }),
    }), {} as any);
    assert.equal(response.status, 502);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects DNS answers containing private addresses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const requestUrl = String(input);
    if (requestUrl.startsWith("https://cloudflare-dns.com/")) {
      const type = new URL(requestUrl).searchParams.get("type");
      return Response.json({ Status: 0, Answer: type === "A"
        ? [{ type: 1, data: "10.0.0.8" }]
        : [] });
    }
    throw new Error("target fetch must not occur");
  };
  try {
    const response = await handleSurfaceScan(new Request("https://worker.test/api/scan", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }),
    }), {} as any);
    assert.equal(response.status, 502);
  } finally { globalThis.fetch = originalFetch; }
});

test("enterprise /v1/audit never returns score or vulnerabilities", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const requestUrl = String(input);
    if (requestUrl.startsWith("https://cloudflare-dns.com/")) {
      const type = new URL(requestUrl).searchParams.get("type");
      return Response.json({
        Status: 0,
        Answer: type === "A" ? [{ type: 1, data: "93.184.216.34" }] : [],
      });
    }
    return new Response("<html><body>ok</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  try {
    const response = await handleEnterpriseAudit(
      new Request("https://worker.test/v1/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "https://example.com",
          email: "security@example.com",
        }),
      }),
      {} as any
    );
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.request_id === "string" && body.request_id.startsWith("req_"));
    assert.equal(body.attestation_status, "unverified");
    assert.equal(body.score, undefined);
    assert.equal(body.vulnerabilities, undefined);
    assert.ok(!JSON.stringify(body).includes("vulnerabilities"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enterprise /v1/audit rejects email domain mismatch", async () => {
  const response = await handleEnterpriseAudit(
    new Request("https://worker.test/v1/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "https://example.com",
        email: "user@other-domain.org",
      }),
    }),
    {} as any
  );
  const body = await response.json() as any;
  assert.equal(response.status, 400);
  assert.equal(body.code, "EMAIL_DOMAIN_MISMATCH");
});
