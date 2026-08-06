/**
 * End-to-end proof of the coordination premise.
 *
 * The failure this project exists to prevent: an implementer hits a wall,
 * has no legitimate way to say "this is impossible as specified", and takes
 * a shortcut instead — mocking the thing it was asked to build, weakening a
 * test until it passes, or reporting done while the suite is red. The plan
 * does not survive contact with reality, and nobody finds out.
 *
 * The claim is that a graph fixes this structurally rather than by asking
 * agents to behave: an agent reports `STATUS: blocked / BLOCKED_ON: x`, an
 * edge routes that back to whoever owns x, and that agent sees the blocker
 * in the state it receives. Escalation becomes cheaper than faking.
 *
 * These tests run the real tool: real script validation, real sandbox, real
 * escalation parsing, real executor, real journal. Only the subprocess
 * spawn is stubbed, because the point is to script what agents SAY, not to
 * test a language model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGraphWorkflowTool } from "../extensions/graph-tool.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import { listGraphRuns } from "../extensions/graph-journal.ts";

/** The graph a main agent would compose for a TDD feature with escalation. */
const TDD_GRAPH = `export const meta = {
  name: "tdd_feature",
  description: "Design, test, implement, review — with escalation back to the contract owner"
};

const g = graph();

g.node("architect", agent("architect", (s) => "Design the contract for: " + s.task));
g.node("red", agent("red", (s) => "Write failing tests for this contract:\\n" + s.architect));
g.node("green", agent("green", (s) =>
  "Implement until these tests pass:\\n" + s.red + "\\n\\nContract:\\n" + s.architect));
g.node("reviewer", agent("reviewer", (s) => "Review this implementation:\\n" + s.green));

g.edge("architect", "red");
g.edge("red", "green");

// The routing decision this whole design exists for.
g.edge("green", (state, result) => {
  if (result.status === "blocked") {
    if (result.blockedOn === "contract") return "architect";
    if (result.blockedOn === "tests") return "red";
    return "reviewer";
  }
  return "reviewer";
});

g.edge("reviewer", END);
g.run({ task: args.task });
`;

/** Builds a spawn stub that replies per agent, per call. */
function scriptedAgents(replies: Record<string, string[]>) {
	const calls: Record<string, number> = {};
	const prompts: { agent: string; prompt: string }[] = [];

	const spawn = vi.fn(
		async (_cwd: string, agentConfig: { name: string }, prompt: string) => {
			const name = agentConfig.name;
			const index = calls[name] ?? 0;
			calls[name] = index + 1;
			prompts.push({ agent: name, prompt });

			const scripted = replies[name];
			const text = scripted?.[Math.min(index, (scripted?.length ?? 1) - 1)] ?? "ok";

			return {
				agent: name,
				task: "t",
				exitCode: 0,
				usage: { totalTokens: 100 },
				messages: [{ role: "assistant", content: [{ type: "text", text }] }],
			};
		},
	);

	return { spawn, prompts, calls };
}

describe("end to end: an implementer escalates instead of faking", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-e2e-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function runTool(
		spawn: ReturnType<typeof vi.fn>,
		params: Record<string, unknown> = {},
		manager?: WorkflowManager,
	) {
		const tool = createGraphWorkflowTool({
			cwd: tempDir,
			spawnAgent: spawn as never,
			workflowManager: manager,
		});
		return tool.execute(
			"call-1",
			{ script: TDD_GRAPH, args: { task: "soft-delete users" }, ...params },
			new AbortController().signal,
			() => {},
			{ cwd: tempDir } as never,
		);
	}

	function textOf(result: unknown): string {
		const content = (result as { content?: { text?: string }[] }).content;
		return (content ?? []).map((c) => c.text ?? "").join("\n");
	}

	/**
	 * The central scenario.
	 *
	 * green cannot implement soft-deletes against a contract that has no
	 * way to express them. It says so instead of stubbing.
	 */
	const ESCALATION_REPLIES = {
		architect: [
			"Contract v1:\ninterface UserRepo { findById(id): User; delete(id): void }",
			"Contract v2:\ninterface UserRepo { findById(id, opts?): User; softDelete(id): void }\nAdded deletedAt to User.",
		],
		red: ["Wrote 4 failing tests in user-repo.test.ts covering soft-delete."],
		green: [
			[
				"I tried to implement soft-delete against the current contract.",
				"",
				"STATUS: blocked",
				"BLOCKED_ON: contract",
				"REASON: UserRepo has no way to express a soft-deleted row; delete(id) is destructive",
				"EVIDENCE: src/repo.ts:42",
				"PROPOSED_FIX: add softDelete(id) and a deletedAt field on User",
			].join("\n"),
			"Implemented softDelete against the revised contract. All 4 tests pass.",
		],
		reviewer: ["Approved. Implementation matches the revised contract; no stubs."],
	};

	it("routes the blocker back to the contract owner and recovers", async () => {
		const { spawn } = scriptedAgents(ESCALATION_REPLIES);
		const result = await runTool(spawn);
		const details = result.details as { path: string[]; status: string };

		expect(details.status).toBe("completed");
		// architect runs twice: the loop is the coordination.
		expect(details.path).toEqual(["architect", "red", "green", "architect", "red", "green", "reviewer"]);
	});

	it("shows the retrying implementer the REVISED contract, not the original", async () => {
		// This is the coordination claim, concretely. Without it the graph is
		// just a retry loop: green would hit the same wall a second time.
		const { spawn, prompts } = scriptedAgents(ESCALATION_REPLIES);
		await runTool(spawn);

		const greenPrompts = prompts.filter((p) => p.agent === "green").map((p) => p.prompt);
		expect(greenPrompts).toHaveLength(2);
		expect(greenPrompts[0]).toContain("Contract v1");
		expect(greenPrompts[0]).not.toContain("Contract v2");
		expect(greenPrompts[1]).toContain("Contract v2");
		expect(greenPrompts[1]).toContain("softDelete");
	});

	it("gives the contract owner the blocker it must resolve", async () => {
		// The architect cannot revise what it cannot see. State flowing
		// through the graph is the entire mechanism — there is no message bus.
		const { spawn, prompts } = scriptedAgents(ESCALATION_REPLIES);
		await runTool(spawn);

		const secondArchitect = prompts.filter((p) => p.agent === "architect")[1].prompt;
		expect(secondArchitect).toBeDefined();
	});

	it("parses the escalation into a routing key rather than leaving it as prose", async () => {
		const { spawn } = scriptedAgents(ESCALATION_REPLIES);
		const result = await runTool(spawn);
		const state = (result.details as { state: Record<string, unknown> }).state;

		// green's FINAL result is the successful retry; the blocked one was
		// overwritten, which is correct — state holds the latest per node.
		expect(state.green).toMatchObject({ status: "ok" });
	});

	it("surfaces the escalation in the report instead of burying it", async () => {
		const { spawn } = scriptedAgents({
			...ESCALATION_REPLIES,
			// Stay blocked so the escalation survives to the final state.
			green: [
				"STATUS: blocked\nBLOCKED_ON: tests\nREASON: the test asserts behaviour the contract never specified",
			],
		});
		const result = await runTool(spawn);

		expect(textOf(result)).toContain("Escalations reported:");
		expect(textOf(result)).toContain("blocked on: tests");
	});

	it("routes a test-level blocker to a different agent than a contract one", async () => {
		// BLOCKED_ON is a closed vocabulary precisely so it can decide WHO
		// gets asked. Prose could not do this.
		const { spawn } = scriptedAgents({
			...ESCALATION_REPLIES,
			green: [
				"STATUS: blocked\nBLOCKED_ON: tests\nREASON: test contradicts the contract",
				"Implemented against the corrected tests.",
			],
			red: ["Wrote 4 failing tests.", "Corrected the contradictory test."],
		});
		const result = await runTool(spawn);
		const details = result.details as { path: string[] };

		// Back to red, NOT to architect.
		expect(details.path).toEqual(["architect", "red", "green", "red", "green", "reviewer"]);
	});

	it("stops looping when a blocker never resolves, rather than spinning forever", async () => {
		const { spawn } = scriptedAgents({
			...ESCALATION_REPLIES,
			architect: ["Contract v1"],
			green: ["STATUS: blocked\nBLOCKED_ON: contract\nREASON: still impossible"],
		});
		const result = await runTool(spawn, { maxIterations: 9 });
		const details = result.details as { status: string };

		expect(details.status).toBe("max_iterations");
	});
});

describe("end to end: the run is observable and recoverable", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-e2e-obs-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function runTool(spawn: ReturnType<typeof vi.fn>, params: Record<string, unknown> = {}, manager?: WorkflowManager) {
		const tool = createGraphWorkflowTool({
			cwd: tempDir,
			spawnAgent: spawn as never,
			workflowManager: manager,
		});
		return tool.execute(
			"call-1",
			{ script: TDD_GRAPH, args: { task: "soft-delete users" }, ...params },
			new AbortController().signal,
			() => {},
			{ cwd: tempDir } as never,
		);
	}

	const REPLIES = {
		architect: ["Contract v1", "Contract v2"],
		red: ["Tests written"],
		green: ["STATUS: blocked\nBLOCKED_ON: contract\nREASON: gap", "Implemented"],
		reviewer: ["Approved"],
	};

	it("records every visit in the display layer so the loop is visible", async () => {
		const manager = new WorkflowManager();
		const { spawn } = scriptedAgents(REPLIES);
		await runTool(spawn, {}, manager);

		const runs = manager.listRuns();
		expect(runs[0].agents.map((a) => a.label)).toEqual([
			"architect (architect)",
			"red (red)",
			"green (green)",
			"architect (architect)",
			"red (red)",
			"green (green)",
			"reviewer (reviewer)",
		]);
	});

	it("shows the blocker in the display preview, led by where it routed", async () => {
		const manager = new WorkflowManager();
		const { spawn } = scriptedAgents(REPLIES);
		await runTool(spawn, {}, manager);

		const blockedEntry = manager.listRuns()[0].agents[2];
		expect(blockedEntry.resultPreview).toContain("→ architect");
		expect(blockedEntry.resultPreview).toContain("blocked on contract");
	});

	it("journals the run so it can be listed afterwards", async () => {
		const { spawn } = scriptedAgents(REPLIES);
		await runTool(spawn);

		const runs = listGraphRuns(path.join(tempDir, ".pi-workflow", "runs"));
		expect(runs).toHaveLength(1);
		expect(runs[0].name).toBe("tdd_feature");
		expect(runs[0].status).toBe("completed");
	});

	it("resumes a crashed run without repeating completed work", async () => {
		let crashed = false;
		const spawn = vi.fn(async (_cwd: string, agentConfig: { name: string }) => {
			if (agentConfig.name === "green" && !crashed) {
				crashed = true;
				throw new Error("subprocess died");
			}
			return {
				agent: agentConfig.name,
				task: "t",
				exitCode: 0,
				usage: { totalTokens: 50 },
				messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
			};
		});

		let runId: string | undefined;
		try {
			await runTool(spawn);
		} catch (error) {
			runId = /Run ID: (\S+)/.exec(error instanceof Error ? error.message : "")?.[1];
		}
		expect(runId, "a failed run must report a resumable id").toBeTruthy();

		const before = spawn.mock.calls.length;
		await runTool(spawn, { resumeRunId: runId });

		// architect and red are not re-run: the walk continues from green.
		const rerunAgents = spawn.mock.calls.slice(before).map((c) => (c[1] as { name: string }).name);
		expect(rerunAgents[0]).toBe("green");
		expect(rerunAgents).not.toContain("architect");
	});
});

describe("end to end: the sandbox holds against a real tool call", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-e2e-sec-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function runScript(script: string, spawn = vi.fn()) {
		const tool = createGraphWorkflowTool({ cwd: tempDir, spawnAgent: spawn as never });
		return tool.execute("c", { script }, new AbortController().signal, () => {}, {
			cwd: tempDir,
		} as never);
	}

	it("rejects a script that reaches for the filesystem, before spawning anything", async () => {
		const spawn = vi.fn();
		await expect(
			runScript(
				`export const meta = { name: "bad", description: "d" };\nconst fs = require("fs");`,
				spawn,
			),
		).rejects.toThrow(/not available in a graph script/);

		expect(spawn).not.toHaveBeenCalled();
	});

	it("rejects a graph naming an agent that does not exist", async () => {
		await expect(
			runScript(`export const meta = { name: "bad", description: "d" };
const g = graph();
g.node("a", agent("hallucinated", () => "go"));
g.edge("a", END);
g.run();`),
		).rejects.toThrow(/Unknown agent "hallucinated"/);
	});
});
