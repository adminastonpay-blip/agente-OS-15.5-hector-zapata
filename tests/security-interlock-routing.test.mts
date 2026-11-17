import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const v21 = await readFile(new URL("../src/routes/v21.ts", import.meta.url), "utf8");
const supervisor = await readFile(new URL("../src/do/supervisor.ts", import.meta.url), "utf8");
const agent = await readFile(new URL("../src/do/agent-node.ts", import.meta.url), "utf8");
const simulation = await readFile(new URL("../src/do/simulation.ts", import.meta.url), "utf8");
const recovery = await readFile(new URL("../src/workflows/recovery.ts", import.meta.url), "utf8");
const aiSafety = await readFile(new URL("../src/security/ai-safety.ts", import.meta.url), "utf8");

test("chat safety gate cannot be disabled by deployment flags", () => {
  const start = source.indexOf("async function enforceChatSafety(");
  const end = source.indexOf("async function handleChat(", start);
  assert.ok(start >= 0 && end > start, "chat safety function must exist");
  const gate = source.slice(start, end);
  assert.doesNotMatch(gate, /CHAT_SAFETY_ENFORCED|DEPLOY_PROFILE/);
  assert.match(gate, /evaluateAiSafety/);
  assert.match(aiSafety, /if \(!env\.SAFETY\)/);
  assert.match(aiSafety, /ai_safety_unavailable/);
  assert.match(aiSafety, /message_content: content, message_length: content\.length/);
});

test("streaming remains fail-closed until buffered output inspection exists", () => {
  const start = source.indexOf("async function handleChatStream(");
  const end = source.indexOf("async function handleTts(", start);
  assert.ok(start >= 0 && end > start, "chat stream handler must exist");
  const handler = source.slice(start, end);
  assert.match(handler, /chat_stream_disabled_until_buffered_safety_guard_is_implemented/);
  assert.doesNotMatch(handler, /chatStream\(/);
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

test("chat, decision, TTS, and voice pass full content through the shared AI preflight", () => {
  assert.match(source, /evaluateAiSafety\(\s*env,\s*identity,\s*"chat_completion",\s*message/s);
  assert.match(source, /"tts_synthesis", text/);
  assert.match(source, /"voice_synthesis", spoken/);
  assert.match(v21, /"decision_inference",\s*message/s);
});

test("RecoveryWorkflow requires propagated verified identity before model inference", () => {
  assert.match(recovery, /evaluateAiSafety\(this\.env, m\.identity, "recovery_hypothesis"/);
  assert.match(recovery, /if \(!gate\.ok\) throw new Error/);
  assert.match(recovery, /if \(!this\.env\.AI\) throw new Error/);
});

test("RAG ingestion and query embeddings require the shared AI preflight", () => {
  const ingest = v21.slice(v21.indexOf('path === "/v1/rag/ingest"'), v21.indexOf('path === "/v1/rag/query"'));
  const query = v21.slice(v21.indexOf('path === "/v1/rag/query"'), v21.indexOf('path === "/v1/ontology/types"'));
  assert.match(ingest, /"rag_ingest_embedding"/);
  assert.match(ingest, /Preflight every chunk before the first persistence or vector-store write/);
  assert.match(query, /"rag_query_embedding"/);
  assert.match(query, /if \(!safety\.ok\)/);
});

test("decision inference screens retrieved RAG context before sending it to the model", () => {
  const decide = v21.slice(v21.indexOf('path === "/v1/decide"'));
  assert.match(decide, /RAG retrieved context before decision inference/);
  assert.match(decide, /if \(!contextSafety\.ok\)/);
  assert.ok(decide.indexOf("contextSafety") < decide.indexOf("const out = await chat"));
});
