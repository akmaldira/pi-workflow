import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agent, END } from "../extensions/graph-dsl.ts";
import { createNodeRunner } from "../extensions/graph-node-runner.ts";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";
import type { ForkContextOptions } from "../extensions/types.ts";

/**
 * Spawns are faked, but the fake mimics pi's real session side effect: it
 * touches the session file so a subsequent revisit sees it as existing.
 * Each spawn records what it was told to do, so a test can assert whether a
 * revisit re-injected the fork summary or resumed an existing transcript.
 */
function makeFake(cwd: string, log: { file: string | undefined; forkContext?: unknown }[]) {
	return async (_cwd: string, a: { name?: string }, _p: string, args: any) => {
		const sessionFile: string | undefined = args.sessionFile;
		log.push({ file: sessionFile, forkContext: args.forkContext });
		if (sessionFile) {
			// Mimic pi creating the transcript under --session.
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			fs.appendFileSync(sessionFile, JSON.stringify({}) + "\n");
		}
		return {
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: `${a?.name ?? "anon"}:turn${log.length}` }] }],
			durationMs: 1,
		};
	};
}

describe("agent node persistence (Decision 1)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pw-sess-"));
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	const forkContext: ForkContextOptions = {
		sessionManager: {
			getCwd: () => cwd,
			getSessionDir: () => path.join(cwd, "parent"),
			getSessionId: () => "parent-1",
			getSessionFile: () => path.join(cwd, "parent", "parent-1.jsonl"),
			getLeafId: () => "leaf-1",
			getLeafEntry: () => undefined,
		} as ForkContextOptions["sessionManager"],
		modelRegistry: { find: () => undefined, getApiKeyAndHeaders: () => Promise.resolve({ ok: true }) } as any,
		fallbackModel: { provider: "test", id: "test" } as any,
	};

	it("writes a project-local session file per (run, node)", async () => {
		const { graph } = buildGraphFromScript(
			`export const meta = { name: "t", description: "d" };
const g = graph();
g.node("a", agent("planner", () => "a"));
g.node("b", agent("worker", () => "b"));
g.edge("a", "b"); g.edge("b", END); g.run({});`,
		);

		const log: { file: string | undefined; forkContext?: unknown }[] = [];
		const runner = createNodeRunner({
			cwd,
			runId: "run-1",
			spawnAgent: makeFake(cwd, log) as any,
			forkContext,
		});

		await runner(graph.nodes.get("a")!, {} as any, { step: 1, runId: "run-1" });
		await runner(graph.nodes.get("b")!, { a: "result" } as any, { step: 2, runId: "run-1" });

		const expected = path.join(cwd, ".pi-workflow", "sessions", "run-1", "a.jsonl");
		expect(log[0].file).toBe(expected);
		expect(log[0].file).toContain(".pi-workflow");
		expect(fs.existsSync(expected)).toBe(true);

		const bFile = path.join(cwd, ".pi-workflow", "sessions", "run-1", "b.jsonl");
		expect(log[1].file).toBe(bFile);
		expect(fs.existsSync(bFile)).toBe(true);
	});

	it("first spawn injects the fork summary; revisit resumes and skips it", async () => {
		const { graph } = buildGraphFromScript(
			`export const meta = { name: "t", description: "d" };
const g = graph();
g.node("architect", agent("architect", () => "design"));
g.node("green", agent("green", () => "impl"));
g.edge("architect", "green");
g.edge("green", (s, r) => r.status === "blocked" ? "architect" : END);
g.run({});`,
		);

		const log: { file: string | undefined; forkContext?: unknown }[] = [];
		const runner = createNodeRunner({
			cwd,
			runId: "cycle",
			spawnAgent: makeFake(cwd, log) as any,
			forkContext,
		});

		await runner(graph.nodes.get("architect")!, {} as any, { step: 1, runId: "cycle" });
		await runner(graph.nodes.get("green")!, { architect: "d" } as any, { step: 2, runId: "cycle" });
		await runner(graph.nodes.get("architect")!, { green: { status: "blocked" } } as any, { step: 3, runId: "cycle" });

		const archFile = path.join(cwd, ".pi-workflow", "sessions", "cycle", "architect.jsonl");
		expect(log[0].file).toBe(archFile);
		expect(log[2].file).toBe(archFile);

		// First spawn bootstraps with the parent fork summary.
		expect(log[0].forkContext).toBeDefined();
		// Revisit resumes the existing transcript, no fresh fork injection.
		expect(log[2].forkContext).toBeUndefined();
	});
});
