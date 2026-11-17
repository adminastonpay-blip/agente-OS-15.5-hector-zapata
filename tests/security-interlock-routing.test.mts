import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("chat safety gate cannot be disabled by deployment flags", () => {
  const start = source.indexOf("async function enforceChatSafety(");
  const end = source.indexOf("async function handleChat(", start);
  assert.ok(start >= 0 && end > start, "chat safety function must exist");
  const gate = source.slice(start, end);
  assert.doesNotMatch(gate, /CHAT_SAFETY_ENFORCED|DEPLOY_PROFILE/);
  assert.match(gate, /if \(!env\.SAFETY\)/);
  assert.match(gate, /chat_safety_unavailable/);
});

test("streaming remains fail-closed until buffered output inspection exists", () => {
  const start = source.indexOf("async function handleChatStream(");
  const end = source.indexOf("async function handleTts(", start);
  assert.ok(start >= 0 && end > start, "chat stream handler must exist");
  const handler = source.slice(start, end);
  assert.match(handler, /chat_stream_disabled_until_buffered_safety_guard_is_implemented/);
  assert.doesNotMatch(handler, /chatStream\(/);
});

test("chat output credential guard is unconditional", () => {
  assert.match(source, /if \(!isOutputSafeForCredentialLeak\(answer\)\)/);
});
