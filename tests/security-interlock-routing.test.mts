import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const v21 = await readFile(new URL("../src/routes/v21.ts", import.meta.url), "utf8");
const supervisor = await readFile(new URL("../src/do/supervisor.ts", import.meta.url), "utf8");
const agent = await readFile(new URL("../src/do/agent-node.ts", import.meta.url), "utf8");
const simulation = await readFile(new URL("../src/do/simulation.ts", import.meta.url), "utf8");

test("chat route uses the Control Gate and one-use Model Runner permit", () => {
  const start = source.indexOf('if (path === "/v1/chat" && req.method === "POST")');
  const end = source.indexOf('if (path.startsWith("/v21/")', start);
  assert.ok(start >= 0 && end > start, "inline chat route must exist");
  const handler = source.slice(start, end);
  assert.match(handler, /new ControlGate\\(env\\)\\.authorizeChat\\(identity, messages\\)/);
  assert.match(handler, /runner\\.runChat\\(decision\\.permit, messages/);
  assert.match(handler, /if \\(!decision\\.ok\\)/);
  assert.match(handler, /isOutputSafeForCredentialLeak\\(answer\\)/);
});

test("streaming has no unguarded execution route", () => {
  assert.doesNotMatch(source, /path === ["']\\/v1\\/chat\\/stream["']/);
  assert.doesNotMatch(source, /\\bchatStream\\s*\\(/);
  assert.match(source, /error: "not_found", path \\}, 404/);
});

test("decision inference is gated and Supervisor fails closed without the interlock", () => {
  assert.match(v21, /decision_inference/);
  assert.match(supervisor, /SafetyInterlock missing — fail-closed/);
  assert.doesNotMatch(supervisor, /if \(!this\.env\.SAFETY\) return \{ status: "allowed"/);
});

test("AgentNode gates planning, each tool, and synthesis", () => {
  assert.match(agent, /agent_model_plan/);
  assert.match(agent, /agent_model_synthesis/);
  assert.match(agent, /SAFETY DO missing — fail-closed/);
});

test("SimulationTwin gates reads and mutations, with critical changes requiring approval", () => {
  assert.match(simulation, /this\.safetyCheck\(body\.identity, \{ tool: "simulation_evaluate"/);
  assert.match(simulation, /this\.safetyCheck\(d\.identity, \{ tool: "commit_simulation"/);
  assert.match(simulation, /this\.safetyCheck\(identity, \{ tool: "commit_simulation"/);
});

test("SimulationTwin fails closed on missing or failed interlock", () => {
  assert.match(simulation, /SafetyInterlock or verified identity missing — fail-closed/);
  assert.match(simulation, /SafetyInterlock request failed — fail-closed/);
});

test("chat output credential guard is unconditional", () => {
  assert.match(source, /if \(!isOutputSafeForCredentialLeak\(answer\)\)/);
});
