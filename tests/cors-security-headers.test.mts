import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("does not grant wildcard cross-origin access", () => {
  assert.doesNotMatch(source, /Access-Control-Allow-Origin\s*:\s*["']\*["']/);
  assert.doesNotMatch(source, /"Access-Control-Allow-Origin"\s*:\s*["']\*["']/);
});

test("preflight responses receive the common security headers", () => {
  assert.match(source, /req\.method === ["']OPTIONS["'][^\n]*SECURITY_HEADERS/);
});

test("binary TTS and voice responses receive the common security headers", () => {
  assert.match(source, /headers:\s*\{ \.\.\.CORS, \.\.\.SECURITY_HEADERS, ["']Content-Type["']: ["']audio\/mpeg["']/);
  assert.match(source, /\.\.\.SECURITY_HEADERS,\s*["']Content-Type["']: ["']audio\/mpeg["']/);
});

test("CORS varies by Origin and defaults to no cross-origin grant", () => {
  assert.match(source, /const CORS:[\s\S]*?["']Vary["']:\s*["']Origin["']/);
  assert.doesNotMatch(source, /Access-Control-Allow-(Origin|Methods|Headers)/);
});
