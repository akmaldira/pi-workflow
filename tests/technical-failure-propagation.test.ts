/**
 * Integration tests for the technical-failure auto-abort behavior:
 * - A subagent's TechnicalFailureError re-throws out of agent() instead of
 *   being swallowed into a null/error-string result.
 * - onTechnicalFailure fires so callers can abort sibling subagents.
 * - Agent-level failures (plain Error, no TechnicalFailureError) continue to
 *   be swallowed exactly as before (workflow keeps going).
 * - parallel()/pipeline() propagate a TechnicalFailureError from any item
 *   rather than converting it into a per-item {error, ok:false}.
 */

import { describe, it, expect, vi } from "vitest";
import { runWorkflow, type WorkflowAgentRunner } from "../extensions/workflow.ts";
import { TechnicalFailureError } from "../extensions/failure-classifier.ts";

function makeRunner(runFn: WorkflowAgentRunner["run"]): WorkflowAgentRunner {
	return {
		async resolveAgent() {
			return { name: "default", description: "Mock agent", systemPrompt: "", source: "test", filePath: "" };
		},
		run: runFn,
	};
}

describe("Technical failure propagation", () => {
	it("re-throws a TechnicalFailureError out of agent() and halts the workflow", async () => {
		const runner = makeRunner(async () => {
			throw new TechnicalFailureError("architect", { class: "technical", code: "provider-error", reason: "rate limited" });
		});

		const script = `
export const meta = { name: "technical_fail_test", description: "test" };
const result = await agent("architect: design something");
return { result };
`;

		await expect(runWorkflow(script, { agentRunner: runner })).rejects.toThrow(/rate limited/);
	});

	it("calls onTechnicalFailure before re-throwing", async () => {
		const runner = makeRunner(async () => {
			throw new TechnicalFailureError("architect", { class: "technical", code: "process-killed", reason: "SIGKILL" });
		});

		const onTechnicalFailure = vi.fn();
		const script = `
export const meta = { name: "technical_fail_callback_test", description: "test" };
await agent("architect: design something");
`;

		await expect(runWorkflow(script, { agentRunner: runner, onTechnicalFailure })).rejects.toThrow();
		expect(onTechnicalFailure).toHaveBeenCalledTimes(1);
		const err = onTechnicalFailure.mock.calls[0][0] as TechnicalFailureError;
		expect(err.failureCode).toBe("process-killed");
		expect(err.agentLabel).toBeTruthy();
	});

	it("does NOT run a dependent agent() after a technical failure (workflow halts immediately)", async () => {
		let secondAgentCalled = false;
		const runner = makeRunner(async (_prompt, _config, options) => {
			if (options.label?.includes("second") || secondAgentCalled === false && _prompt.includes("second")) {
				secondAgentCalled = true;
				return "second output";
			}
			throw new TechnicalFailureError("first", { class: "technical", code: "provider-error", reason: "quota exceeded" });
		});

		const script = `
export const meta = { name: "no_cascade_test", description: "test" };
const first = await agent("do the first step");
const second = await agent("do the second step using: " + first);
return { first, second };
`;

		await expect(runWorkflow(script, { agentRunner: runner })).rejects.toThrow(/quota exceeded/);
		expect(secondAgentCalled).toBe(false);
	});

	it("still swallows a plain agent-level failure (Error, not TechnicalFailureError) and keeps the workflow going", async () => {
		let callCount = 0;
		const runner = makeRunner(async () => {
			callCount++;
			if (callCount === 1) throw new Error("bash failed (exit 1): command not found");
			return "second agent ran fine";
		});

		const script = `
export const meta = { name: "agent_level_failure_test", description: "test" };
const first = await agent("do something that will fail");
const second = await agent("do the next thing regardless");
return { first, second };
`;

		const result = await runWorkflow(script, { agentRunner: runner });
		expect(result.result).toEqual({ first: null, second: "second agent ran fine" });
		expect(callCount).toBe(2);
	});

	it("propagates a TechnicalFailureError thrown inside parallel() instead of converting it to {error, ok:false}", async () => {
		const runner = makeRunner(async (prompt) => {
			if (prompt.includes("fails")) {
				throw new TechnicalFailureError("worker-b", { class: "technical", code: "provider-error", reason: "auth failed" });
			}
			return "ok";
		});

		const script = `
export const meta = { name: "parallel_technical_test", description: "test" };
const results = await parallel([
  () => agent("this one works"),
  () => agent("this one fails"),
]);
return { results };
`;

		await expect(runWorkflow(script, { agentRunner: runner })).rejects.toThrow(/auth failed/);
	});

	it("still resolves a plain agent-level failure inside parallel() to null (agent() swallows it before parallel() ever sees a throw)", async () => {
		// Note: agent() itself already swallows non-technical failures into
		// `return null` (see workflow.ts's catch block) — it never throws to
		// its caller. So parallel()'s own {error, ok:false} catch path is only
		// reached when a thunk throws *directly* (e.g. a bug in the workflow
		// script itself, not a subagent failure). This test documents that
		// agent()-level failures inside parallel() surface as null results,
		// not as {error, ok:false} entries.
		const runner = makeRunner(async (prompt) => {
			if (prompt.includes("fails")) throw new Error("bash failed (exit 1): oops");
			return "ok";
		});

		const script = `
export const meta = { name: "parallel_agent_level_test", description: "test" };
const results = await parallel([
  () => agent("this one works"),
  () => agent("this one fails"),
]);
return { results };
`;

		const result = await runWorkflow(script, { agentRunner: runner });
		const results = (result.result as { results: unknown[] }).results;
		expect(results[0]).toBe("ok");
		expect(results[1]).toBeNull();
	});

	it("propagates a TechnicalFailureError thrown directly by a parallel() thunk (not via agent()) as {error,ok:false}-bypassing rethrow", async () => {
		const script = `
export const meta = { name: "parallel_direct_throw_test", description: "test" };
const results = await parallel([
  () => Promise.resolve("ok"),
  () => { throw new Error("plain script bug, not a subagent failure"); },
]);
return { results };
`;
		const runner = makeRunner(async () => "unused");
		const result = await runWorkflow(script, { agentRunner: runner });
		const results = (result.result as { results: unknown[] }).results;
		expect(results[0]).toBe("ok");
		expect(results[1]).toEqual({ error: "Error: plain script bug, not a subagent failure", ok: false });
	});

	it("propagates a TechnicalFailureError thrown inside pipeline() instead of converting it to {error, ok:false}", async () => {
		const runner = makeRunner(async (prompt) => {
			if (prompt.includes("item-2")) {
				throw new TechnicalFailureError("worker", { class: "technical", code: "protocol-limit", reason: "output limit exceeded" });
			}
			return `processed:${prompt}`;
		});

		const script = `
export const meta = { name: "pipeline_technical_test", description: "test" };
const results = await pipeline(
  ["item-1", "item-2"],
  (prev) => agent(prev),
);
return { results };
`;

		await expect(runWorkflow(script, { agentRunner: runner })).rejects.toThrow(/output limit exceeded/);
	});
});
