/**
 * Recursion-depth guard: a chain of subagents delegating to more subagents
 * must not recurse unbounded.
 *
 * PI_SUBAGENT_DEPTH/PI_SUBAGENT_MAX_DEPTH (types.ts) were ported from
 * pi-subagents but the enforcement check (checkSubagentDepth) was never
 * wired into the actual spawn path — the depth counter was stamped on every
 * child's env correctly, but nothing ever refused to spawn once the cap was
 * reached. This suite covers the fix: runSingleAgent() now checks its own
 * inherited depth before doing any spawn work, and resolveChildMaxSubagentDepth()
 * lets an agent's own `maxSubagentDepth` frontmatter tighten the ceiling for
 * whatever it spawns next.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../extensions/agents.ts";
import { runSingleAgent } from "../extensions/execution.ts";
import { resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth } from "../extensions/types.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "You are a worker.",
		source: "user",
		filePath: "/tmp/worker.md",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

const ORIGINAL_ENV = { ...process.env };

describe("subagent recursion-depth guard", () => {
	beforeEach(() => {
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	describe("checkSubagentDepth / resolveChildMaxSubagentDepth (pure logic)", () => {
		it("is not blocked at depth 0 against the default cap of 2", () => {
			process.env.PI_SUBAGENT_DEPTH = "0";
			expect(resolveCurrentMaxSubagentDepth()).toBe(2);
		});

		it("resolveChildMaxSubagentDepth tightens but never loosens the parent ceiling", () => {
			expect(resolveChildMaxSubagentDepth(2, 1)).toBe(1); // agent tightens
			expect(resolveChildMaxSubagentDepth(2, 5)).toBe(2); // agent tries to loosen, capped at parent's
			expect(resolveChildMaxSubagentDepth(2, undefined)).toBe(2); // agent doesn't specify, inherits parent's
		});
	});

	describe("runSingleAgent() refuses to spawn once the depth ceiling is reached", () => {
		it("returns a failed result instead of spawning when already at the cap", async () => {
			// Simulate this process already being a subagent at the maximum
			// configured depth (as if PI_SUBAGENT_DEPTH/PI_SUBAGENT_MAX_DEPTH
			// were inherited from a parent spawn's env).
			process.env.PI_SUBAGENT_DEPTH = "2";
			process.env.PI_SUBAGENT_MAX_DEPTH = "2";

			const result = await runSingleAgent("/tmp", makeAgent(), "do something", {
				runId: "depth-guard-test",
			});

			expect(result.exitCode).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.error).toMatch(/nested subagent call blocked/i);
			expect(result.error).toMatch(/depth=2/);
			expect(result.error).toMatch(/max=2/);
			// No process was spawned, so there is nothing resembling a real
			// agent run in the result (messages stay empty, no usage tokens).
			expect(result.messages).toEqual([]);
		});

		it("respects a caller-supplied maxSubagentDepth tighter than the process default", async () => {
			process.env.PI_SUBAGENT_DEPTH = "1";
			// No PI_SUBAGENT_MAX_DEPTH in env, so the process default (2) would
			// normally allow depth 1 through -- but options.maxSubagentDepth
			// (as resolveChildMaxSubagentDepth would compute from a stricter
			// agent's own frontmatter) can tighten it further.
			const result = await runSingleAgent("/tmp", makeAgent(), "do something", {
				runId: "depth-guard-test-2",
				maxSubagentDepth: 1,
			});

			expect(result.exitCode).toBe(1);
			expect(result.error).toMatch(/depth=1/);
			expect(result.error).toMatch(/max=1/);
		});

		it("does not block below the depth ceiling", async () => {
			process.env.PI_SUBAGENT_DEPTH = "0";
			process.env.PI_SUBAGENT_MAX_DEPTH = "2";

			// Below the cap, runSingleAgent proceeds past the depth check and
			// into real spawn setup, which will fail for an unrelated reason
			// (no real pi binary / model in this unit-test environment) --
			// We pass a bogus model so buildModelCandidates throws synchronously,
			// failing the spawn immediately without actually launching process
			// wait times, allowing us to verify the specific error thrown.
			const result = await runSingleAgent("/tmp", makeAgent({ model: "nonexistent-fake-model" }), "do something", {
				runId: "depth-guard-test-3",
				availableModels: [],
				modelScope: { enforce: true, allow: [] },
			});

			expect(result.error ?? "").not.toMatch(/nested subagent call blocked/i);
		});
	});
});
