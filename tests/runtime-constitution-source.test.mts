import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONSTITUTION,
  buildConstitution,
  checkConstitution,
} from "../src/provenance/constitution.ts";

const validUsage = {
  calls: 1,
  cost_usdc: 0.01,
  writes: 0,
  wall_ms: 100,
  risk_score: 10,
  tool: "search",
};

describe("runtime constitution — real source module", () => {
  it("builds a bounded profile from the production source defaults", () => {
    const constitution = buildConstitution({
      agent_id: "test-agent",
      objective: "source-module contract test",
    });

    assert.equal(constitution.agent_id, "test-agent");
    assert.deepEqual(constitution.allowed_tools, DEFAULT_CONSTITUTION.allowed_tools);
    assert.equal(constitution.budget.max_calls, 20);
    assert.equal(constitution.budget.max_cost_usdc, 1);
    assert.equal(constitution.budget.max_writes, 5);
    assert.equal(constitution.budget.max_wall_ms, 120_000);
    assert.equal(constitution.risk.max_score, 70);
  });

  it("allows a tool explicitly present in the constitution", () => {
    const constitution = buildConstitution({
      agent_id: "test-agent",
      objective: "allowlisted tool",
    });

    assert.deepEqual(checkConstitution(constitution, validUsage), {
      ok: true,
      reasons: [],
    });
  });

  it("rejects a tool outside the allowlist", () => {
    const constitution = buildConstitution({
      agent_id: "test-agent",
      objective: "tool denial",
      allowed_tools: ["search"],
    });

    const result = checkConstitution(constitution, {
      ...validUsage,
      tool: "shell",
    });

    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("tool_not_allowed:shell"));
  });

  it("preserves the explicit reason-tool exception", () => {
    const constitution = buildConstitution({
      agent_id: "test-agent",
      objective: "reason exception",
      allowed_tools: ["search"],
    });

    assert.equal(
      checkConstitution(constitution, { ...validUsage, tool: "reason" }).ok,
      true,
    );
  });

  it("rejects each exceeded budget and risk threshold", () => {
    const constitution = buildConstitution({
      agent_id: "test-agent",
      objective: "budget boundary checks",
    });

    const cases = [
      [{ ...validUsage, calls: constitution.budget.max_calls + 1 }, "budget_calls"],
      [{ ...validUsage, cost_usdc: constitution.budget.max_cost_usdc + 0.01 }, "budget_cost"],
      [{ ...validUsage, writes: constitution.budget.max_writes + 1 }, "budget_writes"],
      [{ ...validUsage, wall_ms: constitution.budget.max_wall_ms + 1 }, "budget_time"],
      [{ ...validUsage, risk_score: constitution.risk.max_score + 1 }, "risk_max"],
    ] as const;

    for (const [usage, expectedReason] of cases) {
      const result = checkConstitution(constitution, usage);
      assert.equal(result.ok, false, expectedReason);
      assert.ok(result.reasons.includes(expectedReason), expectedReason);
    }
  });

  it("allows values exactly at the configured numeric limits", () => {
    const constitution = buildConstitution({
      agent_id: "test-agent",
      objective: "inclusive boundary characterization",
    });

    const result = checkConstitution(constitution, {
      calls: constitution.budget.max_calls,
      cost_usdc: constitution.budget.max_cost_usdc,
      writes: constitution.budget.max_writes,
      wall_ms: constitution.budget.max_wall_ms,
      risk_score: constitution.risk.max_score,
      tool: "search",
    });

    assert.equal(result.ok, true);
  });
});
