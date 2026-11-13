import test from "node:test";
import assert from "node:assert/strict";
import { handleSurfaceScan } from "../src/scanner/index.ts";

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
  globalThis.fetch = async () => new Response("<html><script>const key='" + fakeKey + "'</script></html>", {
    status: 200, headers: { "content-type": "text/html", "Access-Control-Allow-Origin": "*",
      "Strict-Transport-Security": "max-age=31536000" },
  });
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
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  try {
    const response = await handleSurfaceScan(new Request("https://worker.test/api/scan", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }),
    }), {} as any);
    assert.equal(response.status, 502);
  } finally { globalThis.fetch = originalFetch; }
});
