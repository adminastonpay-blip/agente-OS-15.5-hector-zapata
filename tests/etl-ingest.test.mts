import test from "node:test";
import assert from "node:assert/strict";
import { handleETLIngest } from "../src/etl-ingest.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const request = (body: unknown) => new Request("https://aston.test/v1/etl/ingest", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const accessIdentity = (tenant = "tenant-alpha") => ({
  actor: "verified-user@example.test",
  method: "access" as const,
  tenant,
  roles: ["executor"],
  clearance: "confidential" as const,
});

test("ETL ingest rejects API-key and public identities", async () => {
  const sent: unknown[] = [];
  const queue = { async send(message: unknown) { sent.push(message); } };
  for (const method of ["apikey", "public"] as const) {
    const response = await handleETLIngest(
      request({ text: "sensitive document" }),
      { ETL_QUEUE: queue } as any,
      { ...accessIdentity(), method } as any,
      json,
    );
    assert.equal(response.status, 403);
  }
  assert.equal(sent.length, 0);
});

test("ETL ingest derives tenant and actor from verified Access identity", async () => {
  const sent: any[] = [];
  const queue = { async send(message: unknown) { sent.push(message); } };
  const response = await handleETLIngest(
    request({ text: "  document text  ", source: "customer-docs", kind: "ingest" }),
    { ETL_QUEUE: queue } as any,
    accessIdentity("tenant-alpha"),
    json,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(sent, [{
    tenant: "tenant-alpha",
    actor: "verified-user@example.test",
    text: "document text",
    source: "customer-docs",
    kind: "ingest",
  }]);
});

test("ETL ingest rejects caller-supplied tenant or actor", async () => {
  const sent: unknown[] = [];
  const queue = { async send(message: unknown) { sent.push(message); } };
  const response = await handleETLIngest(
    request({ text: "document", tenant: "tenant-victim", actor: "forged" }),
    { ETL_QUEUE: queue } as any,
    accessIdentity(),
    json,
  );
  assert.equal(response.status, 400);
  assert.equal(sent.length, 0);
});

test("ETL ingest fails closed for invalid tenant, missing queue, and oversized text", async () => {
  const queue = { async send() { throw new Error("must not send"); } };
  const invalidTenant = await handleETLIngest(
    request({ text: "document" }),
    { ETL_QUEUE: queue } as any,
    accessIdentity("bad tenant"),
    json,
  );
  assert.equal(invalidTenant.status, 403);

  const missingQueue = await handleETLIngest(
    request({ text: "document" }),
    {} as any,
    accessIdentity(),
    json,
  );
  assert.equal(missingQueue.status, 503);

  const oversized = await handleETLIngest(
    request({ text: "x".repeat(64_001) }),
    { ETL_QUEUE: queue } as any,
    accessIdentity(),
    json,
  );
  assert.equal(oversized.status, 400);
});
