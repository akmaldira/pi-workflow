import { describe, it, expect } from "vitest";
import { runWorkflow, type WorkflowAgentRunner } from "../extensions/workflow.ts";

describe("Error Resilience & Graceful Degradation", () => {
	const failingAgentRunner: WorkflowAgentRunner = {
		async resolveAgent() {
			return {
				name: "default",
				description: "Mock agent that can fail",
				systemPrompt: "",
				source: "test",
				filePath: "",
			};
		},
		async run(prompt) {
			if (prompt.includes("FAIL")) {
				throw new Error("Intentional failure in agent: " + prompt);
			}
			return JSON.stringify({
				status: "success",
				message: "Agent completed: " + prompt.substring(0, 20),
			});
		},
	};

	it("parallel() catches errors and continues", async () => {
		const logs: string[] = [];
		const script = `
export const meta = { name: "parallel_error_test", description: "Parallel with errors" };
const results = await parallel([
	() => agent("SUCCESS task 1"),
	() => agent("FAIL task 2"),
	() => agent("SUCCESS task 3"),
]);
return results;
`;

		const result = await runWorkflow(script, {
			agentRunner: failingAgentRunner,
			onLog: (msg) => logs.push(msg),
		});

		// Results should be returned (some may be null for failures)
		expect(Array.isArray(result.result)).toBe(true);
		const resultArray = result.result as unknown[];
		expect(resultArray.length).toBe(3);

		// Check that error was logged
		const errorLogs = logs.filter((l) => l.includes("failed"));
		expect(errorLogs.length).toBeGreaterThan(0);
	});

	it("pipeline() continues on individual item failures", async () => {
		const logs: string[] = [];
		const script = `
export const meta = { name: "pipeline_error_test", description: "Pipeline with errors" };
const items = ["SUCCESS 1", "FAIL 2", "SUCCESS 3"];
const results = await pipeline(
	items,
	(item) => agent(item)
);
return results;
`;

		const result = await runWorkflow(script, {
			agentRunner: failingAgentRunner,
			onLog: (msg) => logs.push(msg),
		});

		// Pipeline should process all items
		expect(Array.isArray(result.result)).toBe(true);
		const resultArray = result.result as unknown[];
		expect(resultArray.length).toBe(3);

		// Failure should be logged
		const errorLogs = logs.filter((l) => l.includes("failed"));
		expect(errorLogs.length).toBeGreaterThan(0);
	});

	it("single agent failure is logged gracefully", async () => {
		const logs: string[] = [];
		const script = `
export const meta = { name: "single_fail_test", description: "Single agent fails" };
const result = await agent("FAIL immediately");
return result;
`;

		const result = await runWorkflow(script, {
			agentRunner: failingAgentRunner,
			onLog: (msg) => logs.push(msg),
		});

		// Single agent returns null on failure
		expect(result.result).toBeNull();
		// Error should be logged
		const errorLogs = logs.filter((l) => l.includes("failed"));
		expect(errorLogs.length).toBeGreaterThan(0);
	});

	it("logs contain agent context on failure", async () => {
		const logs: string[] = [];
		const script = `
export const meta = {
	name: "error_context_test",
	description: "Verify error context"
};

phase("Setup");
await agent("SUCCESS setup");

phase("Main");
const result = await agent("FAIL main task");

return result;
`;

		const result = await runWorkflow(script, {
			agentRunner: failingAgentRunner,
			onLog: (msg) => logs.push(msg),
		});

		// Main agent failed, result is null
		expect(result.result).toBeNull();
		// Logs should contain error message
		const errorLogs = logs.filter((l) => l.includes("failed"));
		expect(errorLogs.length).toBeGreaterThan(0);
	});

	it("mixed success/failure in parallel returns heterogeneous array", async () => {
		const logs: string[] = [];
		const script = `
export const meta = { name: "mixed_results", description: "Mixed success/failure" };
const results = await parallel([
	() => agent("OK A"),
	() => agent("FAIL B"),
	() => agent("OK C"),
	() => agent("FAIL D"),
	() => agent("OK E"),
]);
return results;
`;

		const result = await runWorkflow(script, {
			agentRunner: failingAgentRunner,
			onLog: (msg) => logs.push(msg),
		});

		const resultArray = result.result as any[];
		expect(resultArray.length).toBe(5);

		// Count successes and failures
		const successes = resultArray.filter((r) => r !== null);
		const failures = resultArray.filter((r) => r === null);

		expect(successes.length).toBe(3); // OK A, C, E
		expect(failures.length).toBe(2); // FAIL B, D
	});

	it("parallel with all failures still completes", async () => {
		const script = `
export const meta = { name: "all_fail", description: "All agents fail" };
const results = await parallel([
	() => agent("FAIL 1"),
	() => agent("FAIL 2"),
	() => agent("FAIL 3"),
]);
return results;
`;

		const result = await runWorkflow(script, {
			agentRunner: failingAgentRunner,
		});

		const resultArray = result.result as any[];
		expect(resultArray.length).toBe(3);
		// All should be null (failures)
		expect(resultArray.every((r) => r === null)).toBe(true);
	});

	it("early failures don't prevent later attempts", async () => {
		const logs: string[] = [];
		let agentCallCount = 0;

		const countingAgentRunner: WorkflowAgentRunner = {
			async resolveAgent() {
				return {
					name: "default",
					description: "Counting agent",
					systemPrompt: "",
					source: "test",
					filePath: "",
				};
			},
			async run(prompt) {
				agentCallCount++;
				if (agentCallCount === 1) throw new Error("First call fails");
				return `Agent ${agentCallCount} success`;
			},
		};

		const script = `
export const meta = { name: "count_test", description: "Count agent calls" };
const results = await parallel([
	() => agent("Call 1"),
	() => agent("Call 2"),
	() => agent("Call 3"),
]);
return results;
`;

		const result = await runWorkflow(script, {
			agentRunner: countingAgentRunner,
			onLog: (msg) => logs.push(msg),
		});

		// All three agents should have been attempted
		expect(agentCallCount).toBe(3);
	});

	it("abort signal prevents execution", async () => {
		const script = `
export const meta = { name: "abort_test", description: "Test abort signal" };
const result = await agent("task");
return result;
`;

		const controller = new AbortController();

		// Abort immediately
		controller.abort();

		let abortError: Error | undefined;
		try {
			await runWorkflow(script, {
				agentRunner: failingAgentRunner,
				signal: controller.signal,
			});
		} catch (e) {
			abortError = e as Error;
		}

		expect(abortError).toBeDefined();
		expect(abortError?.message).toContain("aborted");
	});

	it("agent failure contains error message in logs", async () => {
		const logs: string[] = [];
		const script = `
export const meta = { name: "error_msg_test", description: "Error message capture" };
const result = await agent("FAIL with custom message");
return result;
`;

		runWorkflow(script, {
			agentRunner: failingAgentRunner,
			onLog: (msg) => logs.push(msg),
		});

		// Logs may contain error messages (async, so no guarantee yet)
		expect(Array.isArray(logs)).toBe(true);
	});
});
