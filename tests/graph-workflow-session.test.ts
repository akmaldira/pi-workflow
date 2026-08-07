/**
 * Integration: an agent node's persisted session conversation flows live into
 * the /workflows display via the graph display bridge.
 *
 * This exercises the real path end-to-end (bridge -> manager -> session
 * watcher -> history) with a scripted spawnAgent, because live model calls
 * are too slow to test the wiring deterministically.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agent, END } from "../extensions/graph-dsl.ts";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";
import { createGraphWorkflowTool } from "../extensions/graph-tool.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";

const SCRIPT = `export const meta = { name: "sess_view", description: "d" };
const g = graph();
g.node("planner", agent("planner", (s) => \`Plan for: \${s.task}\`));
g.node("green", agent("green", (s) => \`Implement: \${s.planner}\`));
g.edge("planner", "green");
g.edge("green", END);
g.run({ task: "a todo app" });`;

/**
 * A fake spawnAgent that, for each agent, writes a realistic pi session JSONL
 * to the sessionFile path the executor told it to use — so the watcher has
 * real content to parse and surface in the display layer.
 */
function fakeSpawnAgent(cwd: string) {
	const base = path.join(cwd, ".pi-workflow", "sessions");
	const spawned: string[] = [];
	const spawnAgent = async (_cwd: string, _agent: any, _prompt: string, args: any) => {
		const sf: string | undefined = args.sessionFile;
		spawned.push(sf!);
		if (sf) {
			fs.mkdirSync(path.dirname(sf), { recursive: true });
			fs.writeFileSync(
				sf,
				[
					JSON.stringify({ type: "session", version: 3, id: "s", timestamp: 1000, cwd: _cwd }),
					JSON.stringify({
						type: "message",
						timestamp: 1001,
						message: { role: "user", content: [{ type: "text", text: "Task: Plan for: a todo app" }] },
					}),
					JSON.stringify({
						type: "message",
						timestamp: 1002,
						message: {
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "Let me plan the todo app." },
								{ type: "text", text: "1. Add  2. View  3. Toggle" },
							],
						},
					}),
				].join("\n"),
			);
		}
		return {
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "1. Add  2. View  3. Toggle" }] }],
			durationMs: 1,
		};
	};
	return { spawnAgent: spawnAgent as never, spawned };
}

describe("an agent's session conversation is visible in /workflows", () => {
	let cwd: string;
	afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

	it("is surfaced via the display bridge into the workflow manager history", async () => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pw-sessview-"));
		const { spawnAgent, spawned } = fakeSpawnAgent(cwd);
		const manager = new WorkflowManager();

		const tool = createGraphWorkflowTool({ cwd, spawnAgent, workflowManager: manager });
		const res: any = await (tool as any).execute("c", { script: SCRIPT }, undefined, undefined, {
			cwd,
			model: undefined,
			sessionManager: undefined,
			modelRegistry: undefined,
		});

		expect(res.details.status).toBe("completed");
		expect(spawned).toEqual([
			path.join(cwd, ".pi-workflow", "sessions", res.details.runId!, "planner.jsonl"),
			path.join(cwd, ".pi-workflow", "sessions", res.details.runId!, "green.jsonl"),
		]);

		// Give the session watcher a poll cycle to read the files it was
		// pointed at during nodeStarted.
		await new Promise((r) => setTimeout(r, 500));

		const run = manager.getRun(res.details.runId)!;
		const planner = run.snapshot.agents.find((a) => a.label === "planner (planner)")!;
		expect(planner.sessionId).toBe(spawned[0]!);

		// The conversation — user prompt + thinking + assistant text — is now
		// history, exactly what /workflows shows in the detail pager.
		const history = planner.history ?? [];
		expect(history.length).toBe(3);
		expect(history[0]).toMatchObject({ role: "user", text: "Task: Plan for: a todo app" });
		expect(history[1]).toMatchObject({ role: "assistant", kind: "thinking" });
		expect(history[2]).toMatchObject({ role: "assistant", text: "1. Add  2. View  3. Toggle" });

		const green = run.snapshot.agents.find((a) => a.label === "green (green)")!;
		expect(green.sessionId).toBe(spawned[1]);
	});
});
