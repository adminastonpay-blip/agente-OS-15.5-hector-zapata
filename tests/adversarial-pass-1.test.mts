import test from "node:test";
import assert from "node:assert/strict";
import { AgentNode } from "../src/do/agent-node.ts";

type TraceEvent = {
  phase: string;
  tenant?: string;
  tool?: string;
  policy_id?: string;
  policy_version?: string;
  effect?: string;
  status?: string;
  branch?: string;
};

function makeAgent(safety: any) {
  const trace: TraceEvent[] = [];
  const counters = { plan: 0, tool: 0, synthesis: 0 };
  const node = new AgentNode({} as any, { SAFETY: safety } as any);
  // Replace only model/tool adapters. AgentNode.fetch() and its real route,
  // safetyCheck(), state transitions and gate routing remain the code under test.
  (node as any).planTools = async () => {
    counters.plan++;
    trace.push({ phase: "model-plan", branch: "plan-tools-returned-synthetic-call" });
    return [{ tool: "search", args: { query: "synthetic-fixture" } }];
  };
  (node as any).runTool = async (_identity: any, call: any) => {
    counters.tool++;
    trace.push({ phase: "tool-invoked", tool: call.tool, branch: "runTool" });
    return "synthetic-result";
  };
  (node as any).synthesize = async () => {
    counters.synthesis++;
    trace.push({ phase: "synthesis", branch: "synthesize" });
    return "synthetic-answer";
  };
  return { node, trace, counters };
}

function safetyBinding(fetcher: (request: Request) => Promise<Response>) {
  return {
    idFromName: (tenant: string) => `synthetic-do:${tenant}`,
    get: (id: string) => ({
      fetch: async (_url: string, init?: RequestInit) => {
        const request = new Request("https://synthetic-safety/evaluate", init);
        return fetcher(request);
      },
    }),
  };
}

const identity = {
  actor: "synthetic-actor",
  method: "access",
  tenant: "tenant-alpha",
  roles: ["executor"],
  clearance: "internal",
};

async function execute(node: AgentNode) {
  return node.fetch(new Request("https://agent-node/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      role: "synthetic-role",
      goal: "synthetic goal",
      context: "synthetic context",
      identity,
      tools: ["search"],
    }),
  }));
}

function allowedResponse(policyId = "fixture-allow") {
  return Response.json({
    status: "allowed",
    contract_version: "1",
    policy: { id: policyId, version: "fixture-v1", effect: "allow", reasons: [] },
  });
}

test("INTERLOCK-UNAVAILABLE-001 / missing DO binding denies before model planning", async (t) => {
  const { node, trace, counters } = makeAgent(undefined);
  const response = await execute(node);
  trace.push({ phase: "route-response", status: String(response.status), branch: "plan-gate-denied" });
  t.diagnostic(JSON.stringify({ policy: "no DO binding; policy evaluation not reached", context: { tenant: identity.tenant, actor: identity.actor }, trace, counters }));
  assert.equal(response.status, 503);
  assert.equal(counters.plan, 0);
  assert.equal(counters.tool, 0);
});

test("INTERLOCK-UNAVAILABLE-001 / thrown fetch (simulated timeout or DO exception) denies the real route", async (t) => {
  const trace: TraceEvent[] = [];
  let calls = 0;
  const safety = safetyBinding(async (request) => {
    const body = await request.json() as any;
    trace.push({ phase: "interlock-request", tenant: body.identity.tenant, tool: body.action.tool, branch: "evaluate" });
    calls++;
    if (calls === 1) return allowedResponse("fixture-plan-allow");
    throw new Error("synthetic DO timeout");
  });
  const { node, counters } = makeAgent(safety);
  const response = await execute(node);
  trace.push({ phase: "route-response", status: String(response.status), branch: "tool-gate-denied-after-fetch-throw" });
  t.diagnostic(JSON.stringify({ policy: "fixture-plan-allow; tool policy not evaluated because fetch threw", context: { tenant: identity.tenant, actor: identity.actor, tool: "search" }, trace, counters }));
  assert.equal(counters.tool, 0);
  assert.equal(response.status, 503);
  const body = await response.json() as any;
  assert.equal(body.status, "denied");
});

test("INTERLOCK-UNAVAILABLE-001 / delayed response must hit a bounded fail-closed deadline", async (t) => {
  let release!: (response: Response) => void;
  let calls = 0;
  const delayed = new Promise<Response>((resolve) => { release = resolve; });
  const trace: TraceEvent[] = [];
  const safety = safetyBinding(async (request) => {
    const body = await request.json() as any;
    calls++;
    trace.push({ phase: "interlock-request", tenant: body.identity.tenant, tool: body.action.tool, branch: "evaluate" });
    if (calls === 1) return allowedResponse("fixture-plan-allow");
    if (calls === 2) return delayed;
    return allowedResponse("fixture-synthesis-allow");
  });
  const { node, counters } = makeAgent(safety);
  const routePromise = execute(node);
  const startedAt = Date.now();
  const eventual = await routePromise;
  const elapsed = Date.now() - startedAt;
  trace.push({ phase: "application-deadline", status: String(eventual.status), branch: "bounded-fail-closed" });
  // Deliver a late allow only after the route has already failed closed.
  release(allowedResponse("late-fixture-allow"));
  await delayed;
  trace.push({ phase: "late-response", branch: "ignored-after-deadline" });
  t.diagnostic(JSON.stringify({ policy: "tool decision withheld until delayed fixture response", context: { tenant: identity.tenant, actor: identity.actor, tool: "search", deadline_ms: 2000, elapsed_ms: elapsed }, trace, counters }));
  assert.ok(elapsed >= 1900 && elapsed < 2600, "route must terminate at its application-enforced deadline");
  assert.equal(eventual.status, 200);
  const body = await eventual.json() as any;
  assert.equal(body.status, "partial_denied");
  assert.equal(counters.tool, 0, "late allow must not resurrect an expired request");
});

test("INTERLOCK-STATUS-001 / unexpected successful response must not invoke a tool", async (t) => {
  let calls = 0;
  const trace: TraceEvent[] = [];
  const safety = safetyBinding(async (request) => {
    const body = await request.json() as any;
    calls++;
    const isTool = body.action.tool === "search";
    const response = isTool
      ? Response.json({ status: "mystery", contract_version: "1", policy: { id: "fixture-unknown", version: "fixture-v1", effect: "unknown" } })
      : allowedResponse("fixture-allow");
    trace.push({ phase: "interlock-response", tenant: body.identity.tenant, tool: body.action.tool, policy_id: isTool ? "fixture-unknown" : "fixture-allow", status: isTool ? "mystery" : "allowed", branch: "HTTP-200" });
    return response;
  });
  const { node, counters } = makeAgent(safety);
  const response = await execute(node);
  trace.push({ phase: "route-response", status: String(response.status), branch: counters.tool ? "tool-executed" : "tool-blocked" });
  t.diagnostic(JSON.stringify({ policy: "fixture-unknown for search; explicit allow for plan and synthesis", context: { tenant: identity.tenant, actor: identity.actor, tool: "search" }, trace, counters }));
  assert.equal(counters.tool, 0, "unknown status must fail closed");
  const body = await response.json() as any;
  assert.equal(body.status, "partial_denied");
  assert.equal(body.blocked?.[0]?.status, "denied");
  assert.match(body.blocked?.[0]?.policy?.reasons?.join(" ") ?? "", /decision status invalid/i);
});

test("INTERLOCK-UNAVAILABLE-001 / absent or empty response denies without invoking a tool", async (t) => {
  let calls = 0;
  const trace: TraceEvent[] = [];
  const safety = safetyBinding(async (request) => {
    const body = await request.json() as any;
    calls++;
    trace.push({ phase: "interlock-request", tenant: body.identity.tenant, tool: body.action.tool, branch: "evaluate" });
    if (calls === 1 || calls === 3) return allowedResponse("fixture-allow");
    return new Response(null, { status: 204 });
  });
  const { node, counters } = makeAgent(safety);
  const response = await execute(node);
  trace.push({ phase: "route-response", status: String(response.status), branch: "empty-body-json-parse-failed-closed" });
  t.diagnostic(JSON.stringify({ policy: "fixture-plan-allow; tool response absent (204 empty)", context: { tenant: identity.tenant, actor: identity.actor, tool: "search" }, trace, counters }));
  assert.equal(counters.tool, 0);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.status, "partial_denied");
});

test("INTERLOCK-STATUS-001 / legitimate positive control: explicit allow reaches the real tool route", async (t) => {
  const trace: TraceEvent[] = [];
  const safety = safetyBinding(async (request) => {
    const body = await request.json() as any;
    trace.push({ phase: "interlock-response", tenant: body.identity.tenant, tool: body.action.tool, policy_id: "fixture-allow", policy_version: "fixture-v1", effect: "allow", status: "allowed", branch: "explicit-allow" });
    return allowedResponse();
  });
  const { node, counters } = makeAgent(safety);
  const response = await execute(node);
  trace.push({ phase: "route-response", status: String(response.status), branch: counters.tool === 1 ? "tool-executed-as-authorized" : "tool-not-executed" });
  t.diagnostic(JSON.stringify({ policy: "fixture-allow", context: { tenant: identity.tenant, actor: identity.actor, tool: "search" }, trace, counters }));
  assert.equal(response.status, 200);
  assert.equal(counters.tool, 1);
  const body = await response.json() as any;
  assert.equal(body.status, "done");
});

test("INTERLOCK-UNAVAILABLE-001 / incompatible response contract must deny", async (t) => {
  let calls = 0;
  const trace: TraceEvent[] = [];
  const safety = safetyBinding(async (request) => {
    const body = await request.json() as any;
    calls++;
    const isTool = body.action.tool === "search";
    trace.push({ phase: "interlock-response", tenant: body.identity.tenant, tool: body.action.tool, policy_id: "fixture-version-mismatch", policy_version: "contract-v99", status: "allowed", branch: "HTTP-200" });
    return isTool
      ? Response.json({ status: "allowed", contract_version: "99", policy: { id: "fixture-version-mismatch", version: "contract-v99", effect: "allow" } })
      : allowedResponse("fixture-allow");
  });
  const { node, counters } = makeAgent(safety);
  const response = await execute(node);
  trace.push({ phase: "route-response", status: String(response.status), branch: counters.tool ? "tool-executed" : "tool-blocked" });
  t.diagnostic(JSON.stringify({ policy: "fixture-version-mismatch; contract v99 unsupported by expected v1", context: { tenant: identity.tenant, actor: identity.actor, tool: "search" }, trace, counters }));
  assert.equal(counters.tool, 0, "incompatible contract must fail closed");
  const body = await response.json() as any;
  assert.equal(body.status, "partial_denied");
  assert.equal(body.blocked?.[0]?.status, "denied");
  assert.match(body.blocked?.[0]?.policy?.reasons?.join(" ") ?? "", /contract version unsupported/i);
});

test("INTERLOCK-APPROVAL-001 / pending approval without an approval reference must fail closed", async (t) => {
  const trace: TraceEvent[] = [];
  const safety = safetyBinding(async (request) => {
    const body = await request.json() as any;
    const isTool = body.action.tool === "search";
    trace.push({
      phase: "interlock-response",
      tenant: body.identity.tenant,
      tool: body.action.tool,
      status: isTool ? "pending_approval" : "allowed",
      branch: isTool ? "approval-reference-omitted" : "explicit-allow",
    });
    return isTool
      ? Response.json({
          status: "pending_approval",
          contract_version: "1",
          policy: { id: "fixture-approval-missing-id", version: "fixture-v1", effect: "require_approval" },
        })
      : allowedResponse("fixture-allow");
  });
  const { node, counters } = makeAgent(safety);
  const response = await execute(node);
  t.diagnostic(JSON.stringify({
    policy: "pending_approval without approval_id must be treated as malformed and denied",
    context: { tenant: identity.tenant, actor: identity.actor, tool: "search" },
    trace,
    counters,
  }));
  assert.equal(counters.tool, 0, "an approval state without a reference must never execute the tool");
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.status, "partial_denied");
  assert.equal(body.blocked?.[0]?.status, "denied");
  assert.match(body.blocked?.[0]?.policy?.reasons?.join(" ") ?? "", /approval reference missing/i);
});
