import { describe, it, expect } from "vitest";
import { parseWorkflowScript, runWorkflow, type WorkflowAgentRunner } from "../extensions/workflow.ts";

describe("Budget & Safety Controls", () => {
	const mockAgentRunner: WorkflowAgentRunner = {
		async resolveAgent() {
			return {
				name: "default",
				description: "Mock agent",
				systemPrompt: "",
				source: "test",
				filePath: "",
			};
		},
		async run() {
			// Simulate a response with ~100 tokens
			return JSON.stringify({ result: "test output", usage: { output_tokens: 100 } });
		},
	};

	it("tracks total agents spawned", async () => {
		const script = `
export const meta = { name: "agent_count_test", description: "Track agent count" };
const result1 = await agent("Task 1");
const result2 = await agent("Task 2");
return { results: [result1, result2] };
`;
		const result = await runWorkflow(script, {
			agentRunner: mockAgentRunner,
		});

		expect(result.agentCount).toBe(2);
	});

	it("accepts token budget option without error", async () => {
		const script = `
export const meta = { name: "budget_accepted_test", description: "Token budget accepted" };
const result = await agent("Task 1");
return result;
`;

		const result = await runWorkflow(script, {
			agentRunner: mockAgentRunner,
			tokenBudget: 150,
		});

		expect(result.agentCount).toBe(1);
	});

	it("enforces max agents limit", async () => {
		const script = `
export const meta = { name: "max_agents_test", description: "Test max agents limit" };
await agent("Task 1");
await agent("Task 2");
await agent("Task 3");
return "should not reach here";
`;

		let error: Error | undefined;
		try {
			await runWorkflow(script, {
				agentRunner: mockAgentRunner,
				maxAgents: 2,
			});
		} catch (e) {
			error = e as Error;
		}

		expect(error).toBeDefined();
		expect(error?.message?.toLowerCase()).toContain("max agents");
	});

	it("accepts script timeout option", async () => {
		const script = `
export const meta = { name: "timeout_test", description: "Test timeout" };
await agent("Task 1");
return "done";
`;

		// Should not error just by providing timeout (enforcement is tricky to unit test)
		const result = await runWorkflow(script, {
			agentRunner: mockAgentRunner,
			scriptTimeoutMs: 5000,
		});

		expect(result.agentCount).toBe(1);
	});

	it("does not enforce token budget (just accepts and tracks)", async () => {
		// Token budget should track but not prevent agents from running
		const script = `
export const meta = { name: "no_enforce_test", description: "Token budget is not enforced" };
const r1 = await agent("Task 1");
const r2 = await agent("Task 2");
const r3 = await agent("Task 3");
return { results: [r1, r2, r3] };
`;

		const result = await runWorkflow(script, {
			agentRunner: mockAgentRunner,
			tokenBudget: 50, // Very low budget (agents use ~100 tokens each)
		});

		// All agents should complete despite low budget (no hard enforcement)
		expect(result.agentCount).toBe(3);
	});

	it("handles concurrent agent execution", async () => {
		const script = `
export const meta = { name: "concurrency_test", description: "Test concurrency limiting" };
const results = await parallel([
	() => agent("Task 1"),
	() => agent("Task 2"),
	() => agent("Task 3"),
	() => agent("Task 4"),
]);
return results;
`;

		const result = await runWorkflow(script, {
			agentRunner: mockAgentRunner,
			concurrency: 2, // Max 2 concurrent
		});

		// All agents should complete
		expect(result.agentCount).toBe(4);
	});

	it("tracks agent count across multiple phases", async () => {
		const script = `
export const meta = {
	name: "multi_phase_test",
	description: "Test agent tracking across phases",
	phases: [{ title: "Phase 1" }, { title: "Phase 2" }]
};

phase("Phase 1");
const r1 = await agent("Task in phase 1");

phase("Phase 2");
const r2 = await agent("Task in phase 2");

return { phase1: r1, phase2: r2 };
`;

		const result = await runWorkflow(script, {
			agentRunner: mockAgentRunner,
			tokenBudget: 300,
		});

		expect(result.agentCount).toBe(2);
		expect(result.phases).toEqual(["Phase 1", "Phase 2"]);
	});

	it("captures parallel errors gracefully", async () => {
		const failingAgentRunner: WorkflowAgentRunner = {
			async resolveAgent() {
				return {
					name: "default",
					description: "Mock agent",
					systemPrompt: "",
					source: "test",
					filePath: "",
				};
			},
			async run(prompt) {
				if (prompt.includes("fail")) {
					throw new Error("Task failed as intended");
				}
				return "success";
			},
		};

		const script = `
export const meta = { name: "error_test", description: "Test error handling" };
const results = await parallel([
	() => agent("success task"),
	() => agent("fail task"),
	() => agent("success task 2"),
]);
return results;
`;

		const result = await runWorkflow(script, {
			agentRunner: failingAgentRunner,
		});

		// Parallel should return 3 items, some may be errors
		expect(Array.isArray(result.result)).toBe(true);
		const resultArray = result.result as unknown[];
		expect(resultArray.length).toBe(3);
	});

	it("accepts maxConcurrent option", async () => {
		const script = `
export const meta = { name: "concurrency_limit_test", description: "Test concurrency option" };
const r = await parallel([
	() => agent("T1"),
	() => agent("T2"),
	() => agent("T3"),
]);
return r;
`;

		const result = await runWorkflow(script, {
			agentRunner: mockAgentRunner,
			maxConcurrent: 2,
		});

		expect(result.agentCount).toBe(3);
	});
});
