/**
 * Tests for runSubagentForWorkflow() (extensions/index.ts) \u2014 verifies it
 * throws TechnicalFailureError when runSingleAgent()'s result is classified
 * as a technical failure, and otherwise returns the normal output string
 * (agent-level failures included) exactly as before.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SingleResult } from "../extensions/types.ts";

const mockRunSingleAgent = vi.fn<(...args: any[]) => Promise<SingleResult>>();

vi.mock("../extensions/execution.ts", () => ({
	runSingleAgent: (...args: any[]) => mockRunSingleAgent(...args),
}));

import { runSubagentForWorkflow } from "../extensions/index.ts";
import { TechnicalFailureError } from "../extensions/failure-classifier.ts";
import type { AgentConfig } from "../extensions/agents.ts";

function makeAgent(): AgentConfig {
	return { name: "worker", description: "test", systemPrompt: "", source: "user", filePath: "/tmp/worker.md" };
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		task: "do something",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		...overrides,
	};
}

describe("runSubagentForWorkflow", () => {
	beforeEach(() => {
		mockRunSingleAgent.mockReset();
	});

	it("returns the final output string on success", async () => {
		mockRunSingleAgent.mockResolvedValue(
			makeResult({ exitCode: 0, finalOutput: "all good", failureClass: "none" }),
		);

		const output = await runSubagentForWorkflow("/tmp", makeAgent(), "do it", { label: "worker-1" });
		expect(output).toBe("all good");
	});

	it("throws TechnicalFailureError when failureClass is technical", async () => {
		mockRunSingleAgent.mockResolvedValue(
			makeResult({
				exitCode: 1,
				error: "rate limit exceeded",
				failureClass: "technical",
				failureCode: "provider-error",
				failureReason: "rate limit exceeded",
			}),
		);

		await expect(runSubagentForWorkflow("/tmp", makeAgent(), "do it", { label: "worker-1" }))
			.rejects.toThrow(TechnicalFailureError);
	});

	it("includes the agent label and failure reason in the thrown error", async () => {
		mockRunSingleAgent.mockResolvedValue(
			makeResult({
				exitCode: 1,
				failureClass: "technical",
				failureCode: "process-killed",
				failureReason: "killed by SIGKILL",
			}),
		);

		try {
			await runSubagentForWorkflow("/tmp", makeAgent(), "do it", { label: "architect-step" });
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(TechnicalFailureError);
			const techErr = err as TechnicalFailureError;
			expect(techErr.agentLabel).toBe("architect-step");
			expect(techErr.failureCode).toBe("process-killed");
			expect(techErr.message).toContain("killed by SIGKILL");
		}
	});

	it("does NOT throw for an agent-level failure (returns error text as string instead)", async () => {
		mockRunSingleAgent.mockResolvedValue(
			makeResult({
				exitCode: 1,
				error: "bash failed (exit 1): command not found",
				failureClass: "agent",
				failureCode: "agent-error",
				failureReason: "bash failed (exit 1): command not found",
			}),
		);

		const output = await runSubagentForWorkflow("/tmp", makeAgent(), "do it", { label: "worker-1" });
		expect(output).toContain("bash failed");
	});

	it("falls back to the agent's name when no label is provided", async () => {
		mockRunSingleAgent.mockResolvedValue(
			makeResult({ exitCode: 1, failureClass: "technical", failureCode: "no-model-available", failureReason: "no models" }),
		);

		try {
			await runSubagentForWorkflow("/tmp", makeAgent(), "do it", {});
			expect.fail("should have thrown");
		} catch (err) {
			const techErr = err as TechnicalFailureError;
			expect(techErr.agentLabel).toBe("worker");
		}
	});
});
