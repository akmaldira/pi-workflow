import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent, END, GraphBuilder } from "../extensions/graph-dsl.ts";
import type { NodeExecution } from "../extensions/graph-executor.ts";
import { runSuperstepGraph } from "../extensions/graph-executor.ts";
import {
	GraphJournal,
	graphScriptHash,
	hashString,
	listGraphRuns,
	loadGraphResumeState,
	readGraphJournal,
} from "../extensions/graph-journal.ts";

function execution(overrides: Partial<NodeExecution> = {}): NodeExecution {
	return {
		step: 1,
		nodeId: "a",
		nodeType: "agent",
		agentName: "planner",
		status: "ok",
		result: "PLAN",
		routedTo: "b",
		startedAt: Date.now(),
		durationMs: 10,
		...overrides,
	};
}

describe("graphScriptHash", () => {
	it("is stable for identical scripts", () => {
		expect(graphScriptHash("const g = graph();")).toBe(graphScriptHash("const g = graph();"));
	});

	it("differs when the script changes", () => {
		expect(graphScriptHash("a")).not.toBe(graphScriptHash("b"));
	});
});

describe("hashString", () => {
	it("produces consistent hashes for the same input", () => {
		expect(hashString("hello world")).toBe(hashString("hello world"));
	});

	it("produces different hashes for different inputs", () => {
		expect(hashString("script 1")).not.toBe(hashString("script 2"));
	});

	it("produces an 8-character hex string", () => {
		expect(hashString("test")).toMatch(/^[a-f0-9]{8}$/);
	});
});

describe("GraphJournal", () => {
	let journalDir: string;

	beforeEach(() => {
		journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-graph-journal-"));
	});

	afterEach(() => {
		fs.rmSync(journalDir, { recursive: true, force: true });
	});

	function create(runId = "run1"): GraphJournal {
		return GraphJournal.create({
			journalDir,
			runId,
			scriptHash: "hash1",
			name: "tdd",
			entry: "a",
			nodeIds: ["a", "b"],
			initialState: { task: "ship" },
		});
	}

	it("writes a run header on creation", () => {
		const journal = create();
		const records = readGraphJournal(journal.filePath);

		expect(records[0]).toMatchObject({
			type: "graph_run",
			runId: "run1",
			scriptHash: "hash1",
			name: "tdd",
			entry: "a",
			initialState: { task: "ship" },
		});
	});

	it("appends one record per node execution", () => {
		const journal = create();
		journal.recordNode(execution({ step: 1, nodeId: "a" }));
		journal.recordNode(execution({ step: 2, nodeId: "b", routedTo: "END" }));

		const nodes = readGraphJournal(journal.filePath).filter((r) => r.type === "node");
		expect(nodes).toHaveLength(2);
		expect(nodes.map((n) => (n as { nodeId: string }).nodeId)).toEqual(["a", "b"]);
	});

	it("records a revisited node once per visit", () => {
		// History is the audit trail; collapsing repeats would hide the loop
		// that escalation depends on.
		const journal = create();
		journal.recordNode(execution({ step: 1, nodeId: "architect", routedTo: "green" }));
		journal.recordNode(execution({ step: 2, nodeId: "green", routedTo: "architect" }));
		journal.recordNode(execution({ step: 3, nodeId: "architect", routedTo: "green" }));

		const nodes = readGraphJournal(journal.filePath).filter((r) => r.type === "node");
		expect(nodes).toHaveLength(3);
	});

	it("accumulates tokens and node count", () => {
		const journal = create();
		journal.recordNode(execution({ tokens: 100 }));
		journal.recordNode(execution({ step: 2, tokens: 250 }));

		expect(journal.tokens).toBe(350);
		expect(journal.nodes).toBe(2);
	});

	it("writes a final result record", () => {
		const journal = create();
		journal.recordNode(execution({ tokens: 50 }));
		journal.recordResult({ status: "completed", iterations: 1, durationMs: 123 });

		const result = readGraphJournal(journal.filePath).find((r) => r.type === "graph_result");
		expect(result).toMatchObject({
			type: "graph_result",
			status: "completed",
			iterations: 1,
			totalTokens: 50,
		});
	});

	it("records an aborted run with its reason", () => {
		const journal = create();
		journal.recordResult({
			status: "aborted",
			iterations: 2,
			durationMs: 10,
			error: "technical failure",
		});

		const result = readGraphJournal(journal.filePath).find((r) => r.type === "graph_result");
		expect(result).toMatchObject({ status: "aborted", error: "technical failure" });
	});

	it("creates the journal directory when missing", () => {
		const nested = path.join(journalDir, "deep", "nested");
		const journal = GraphJournal.create({
			journalDir: nested,
			runId: "run1",
			scriptHash: "h",
			name: "n",
			entry: "a",
			nodeIds: ["a"],
			initialState: {},
		});

		expect(fs.existsSync(journal.filePath)).toBe(true);
	});

	it("collects write failures instead of throwing", () => {
		// Journaling makes a run inspectable; losing that is strictly better
		// than killing a run that is otherwise working. Provoked with a real
		// unwritable path rather than a mock, since the module holds its own
		// binding to fs and would not see a spy installed here.
		const journal = create();
		fs.rmSync(journal.filePath, { force: true });
		fs.mkdirSync(journal.filePath, { recursive: true });

		expect(() => journal.recordNode(execution())).not.toThrow();
		expect(journal.writeErrors.length).toBeGreaterThan(0);
	});

	it("keeps running when the journal directory cannot be created", () => {
		const blocker = path.join(journalDir, "blocked");
		fs.writeFileSync(blocker, "not a directory");

		const journal = GraphJournal.create({
			journalDir: blocker,
			runId: "run1",
			scriptHash: "h",
			name: "n",
			entry: "a",
			nodeIds: ["a"],
			initialState: {},
		});

		expect(journal.writeErrors.length).toBeGreaterThan(0);
		expect(() => journal.recordNode(execution())).not.toThrow();
	});
});

describe("readGraphJournal", () => {
	let journalDir: string;

	beforeEach(() => {
		journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-graph-read-"));
	});

	afterEach(() => {
		fs.rmSync(journalDir, { recursive: true, force: true });
	});

	it("returns nothing for a missing file", () => {
		expect(readGraphJournal(path.join(journalDir, "nope.jsonl"))).toEqual([]);
	});

	it("skips a truncated final line", () => {
		// Expected when a process dies mid-write; everything before it is
		// still usable.
		const filePath = path.join(journalDir, "run.jsonl");
		fs.writeFileSync(
			filePath,
			`{"type":"graph_run","runId":"r","scriptHash":"h","name":"n","entry":"a","nodeIds":[],"initialState":{},"startedAt":1}\n{"type":"node","step":1,"nodeId":"a"\n`,
		);

		const records = readGraphJournal(filePath);
		expect(records).toHaveLength(1);
		expect(records[0].type).toBe("graph_run");
	});

	it("ignores blank lines", () => {
		const filePath = path.join(journalDir, "run.jsonl");
		fs.writeFileSync(filePath, `{"type":"graph_result","status":"completed"}\n\n\n`);

		expect(readGraphJournal(filePath)).toHaveLength(1);
	});
});

describe("loadGraphResumeState", () => {
	let journalDir: string;

	beforeEach(() => {
		journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-graph-resume-"));
	});

	afterEach(() => {
		fs.rmSync(journalDir, { recursive: true, force: true });
	});

	function journalWith(records: unknown[], runId = "run1"): void {
		fs.writeFileSync(
			path.join(journalDir, `${runId}.jsonl`),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
	}

	const header = {
		type: "graph_run",
		runId: "run1",
		scriptHash: "hash1",
		name: "tdd",
		entry: "architect",
		nodeIds: ["architect", "green", "reviewer"],
		initialState: { task: "ship" },
		startedAt: 1,
	};

	it("reports a missing journal", () => {
		const state = loadGraphResumeState({ journalDir, runId: "nope", scriptHash: "hash1" });

		expect(state.isValid).toBe(false);
		expect(state.invalidReason).toMatch(/No journal found/);
	});

	it("refuses to resume when the script changed", () => {
		// A changed script may have renamed nodes or rerouted edges, so
		// replaying old results into it would describe a run that never
		// happened.
		journalWith([header]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "different" });

		expect(state.isValid).toBe(false);
		expect(state.invalidReason).toMatch(/script changed/);
	});

	it("resumes from the entry node when nothing ran yet", () => {
		journalWith([header]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "hash1" });

		expect(state.isValid).toBe(true);
		expect(state.resumeFrom).toBe("architect");
		expect(state.state).toEqual({ task: "ship" });
	});

	it("rebuilds state by replaying recorded results", () => {
		journalWith([
			header,
			{ type: "node", step: 1, nodeId: "architect", result: "contract v1", routedTo: "green" },
			{ type: "node", step: 2, nodeId: "green", result: "impl", routedTo: "reviewer" },
		]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "hash1" });

		expect(state.state).toEqual({ task: "ship", architect: "contract v1", green: "impl" });
		expect(state.resumeFrom).toBe("reviewer");
		expect(state.completedSteps).toBe(2);
	});

	it("keeps the newest result for a revisited node", () => {
		journalWith([
			header,
			{ type: "node", step: 1, nodeId: "architect", result: "v1", routedTo: "green" },
			{ type: "node", step: 2, nodeId: "green", result: "blocked", routedTo: "architect" },
			{ type: "node", step: 3, nodeId: "architect", result: "v2", routedTo: "green" },
		]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "hash1" });

		// Replay mirrors a live run: the later visit overwrites the earlier.
		expect(state.state.architect).toBe("v2");
		expect(state.resumeFrom).toBe("green");
	});

	it("reports nothing to resume for a completed run", () => {
		journalWith([
			header,
			{ type: "node", step: 1, nodeId: "architect", result: "v1", routedTo: "END" },
			{ type: "graph_result", status: "completed", iterations: 1, totalTokens: 0, durationMs: 5 },
		]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "hash1" });

		expect(state.isValid).toBe(true);
		expect(state.resumeFrom).toBeNull();
	});

	it("resumes at the failed node when routing never happened", () => {
		// An empty routedTo means the node ran but the run stopped there, so
		// that node is the one to retry.
		journalWith([
			header,
			{ type: "node", step: 1, nodeId: "architect", result: "v1", routedTo: "green" },
			{ type: "node", step: 2, nodeId: "green", result: null, routedTo: "", error: "spawn failed" },
			{ type: "graph_result", status: "aborted", iterations: 2, totalTokens: 0, durationMs: 5 },
		]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "hash1" });

		expect(state.resumeFrom).toBe("green");
	});

	it("restores result interpolation after JSON round-tripping", () => {
		// Replayed results come back from JSON.parse as plain objects, losing
		// the toString() that makes `${state.architect}` render the agent's
		// text. Without re-attaching it, a resumed run silently interpolates
		// "[object Object]" into every prompt built from an earlier node — the
		// prompt still looks well-formed, so nothing errors.
		journalWith([
			header,
			{
				type: "node",
				step: 1,
				nodeId: "architect",
				result: { status: "ok", text: "Contract v2", agent: "architect" },
				routedTo: "green",
			},
		]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "hash1" });

		expect(`Implement:\n${state.state.architect}`).toBe("Implement:\nContract v2");
	});

	it("leaves non-result state values alone", () => {
		journalWith([
			header,
			{ type: "node", step: 1, nodeId: "architect", result: "plain string", routedTo: "green" },
		]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "hash1" });

		expect(state.state.architect).toBe("plain string");
		expect(state.state.task).toBe("ship");
	});

	it("rejects a journal with no header", () => {
		journalWith([{ type: "node", step: 1, nodeId: "a", result: "x", routedTo: "END" }]);

		const state = loadGraphResumeState({ journalDir, runId: "run1", scriptHash: "hash1" });

		expect(state.isValid).toBe(false);
		expect(state.invalidReason).toMatch(/missing its run header/);
	});
});

describe("listGraphRuns", () => {
	let journalDir: string;

	beforeEach(() => {
		journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-graph-list-"));
	});

	afterEach(() => {
		fs.rmSync(journalDir, { recursive: true, force: true });
	});

	function writeRun(runId: string, name: string, startedAt: number, status?: string): void {
		const records: unknown[] = [
			{
				type: "graph_run",
				runId,
				scriptHash: "h",
				name,
				entry: "a",
				nodeIds: ["a"],
				initialState: {},
				startedAt,
			},
		];
		if (status) {
			records.push({ type: "graph_result", status, iterations: 1, totalTokens: 42, durationMs: 5 });
		}
		fs.writeFileSync(
			path.join(journalDir, `${runId}.jsonl`),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
	}

	it("returns nothing for a missing directory", () => {
		expect(listGraphRuns(path.join(journalDir, "nope"))).toEqual([]);
	});

	it("lists runs newest first", () => {
		writeRun("old", "first", 1000, "completed");
		writeRun("new", "second", 2000, "completed");

		expect(listGraphRuns(journalDir).map((r) => r.runId)).toEqual(["new", "old"]);
	});

	it("marks a run with no result record as incomplete", () => {
		writeRun("partial", "wip", 1000);

		expect(listGraphRuns(journalDir)[0].status).toBe("incomplete");
	});

	it("includes token totals from the result record", () => {
		writeRun("done", "finished", 1000, "completed");

		expect(listGraphRuns(journalDir)[0].totalTokens).toBe(42);
	});
});

describe("resume through the executor", () => {
	let journalDir: string;

	beforeEach(() => {
		journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-graph-e2e-resume-"));
	});

	afterEach(() => {
		fs.rmSync(journalDir, { recursive: true, force: true });
	});

	function tddGraph() {
		const g = new GraphBuilder();
		g.node("architect", agent("architect", (s) => `design ${s.task}`));
		g.node("green", agent("green", (s) => `implement ${s.architect}`));
		g.node("reviewer", agent("reviewer", (s) => `review ${s.green}`));
		g.edge("architect", "green");
		g.edge("green", "reviewer");
		g.edge("reviewer", END);
		g.run({ task: "auth" });
		return g.build();
	}

	it("does not re-run nodes that already completed", async () => {
		const graph = tddGraph();
		const ran: string[] = [];

		const result = await runSuperstepGraph(graph, {
			runId: "run1",
			runNode: async (node) => {
				ran.push(node.id);
				return { result: `${node.id}-done` };
			},
			resume: {
				state: { task: "auth", architect: "contract v1" },
				resumeFromFrontier: ["green"],
				remainingInDegree: {},
				completedRounds: 1,
				completedNodeExecutions: 1,
				executedNodeIds: [],
			},
		});

		// The point of resume: the expensive architect call is not repeated.
		expect(ran).toEqual(["green", "reviewer"]);
		expect(result.status).toBe("completed");
	});

	it("gives resumed nodes the replayed state", async () => {
		const seen: unknown[] = [];

		await runSuperstepGraph(tddGraph(), {
			runId: "run1",
			runNode: async (node, state) => {
				if (node.id === "green") seen.push(state.architect);
				return { result: `${node.id}-done` };
			},
			resume: {
				state: { task: "auth", architect: "contract v1" },
				resumeFromFrontier: ["green"],
				remainingInDegree: {},
				completedRounds: 1,
				completedNodeExecutions: 1,
				executedNodeIds: [],
			},
		});

		expect(seen).toEqual(["contract v1"]);
	});

	it("counts prior steps against the iteration cap", async () => {
		// Otherwise repeated resumes could walk a cycle indefinitely.
		const result = await runSuperstepGraph(tddGraph(), {
			runId: "run1",
			maxIterations: 2,
			runNode: async (node) => ({ result: node.id }),
			resume: {
				state: { task: "auth" },
				resumeFromFrontier: ["green"],
				remainingInDegree: {},
				completedRounds: 2,
				completedNodeExecutions: 2,
				executedNodeIds: ["architect"],
			},
		});

		expect(result.status).toBe("max_iterations");
	});

	it("prepends prior history so the run reads as one walk", async () => {
		const prior = [execution({ step: 1, nodeId: "architect", routedTo: "green" })];

		const result = await runSuperstepGraph(tddGraph(), {
			runId: "run1",
			runNode: async (node) => ({ result: node.id }),
			resume: {
				state: { task: "auth", architect: "v1" },
				resumeFromFrontier: ["green"],
				remainingInDegree: {},
				completedRounds: 1,
				completedNodeExecutions: 1,
				executedNodeIds: ["architect"],
				history: prior,
			},
		});

		expect(result.path).toEqual(["architect", "green", "reviewer"]);
		expect(result.history).toHaveLength(3);
	});


	it("round-trips a real run through the journal and back", async () => {
		const graph = tddGraph();
		const scriptHash = graphScriptHash("script source");

		// First attempt: reviewer fails, so the run aborts partway.
		const journal = GraphJournal.create({
			journalDir,
			runId: "run1",
			scriptHash,
			name: "tdd",
			entry: graph.entry,
			nodeIds: [...graph.nodes.keys()],
			initialState: graph.initialState,
		});

		const first = await runSuperstepGraph(graph, {
			runId: "run1",
			runNode: async (node) => {
				if (node.id === "reviewer") throw new Error("reviewer crashed");
				return { result: `${node.id}-v1` };
			},
			onNodeComplete: (execution) => journal.recordNode(execution),
		});
		journal.recordResult({
			status: first.status,
			iterations: first.iterations,
			durationMs: first.durationMs,
			error: first.error,
		});

		expect(first.status).toBe("aborted");

		// Resume: replay what happened, continue from the failure.
		const resumeState = loadGraphResumeState({ journalDir, runId: "run1", scriptHash });
		expect(resumeState.isValid).toBe(true);
		expect(resumeState.resumeFrom).toBe("reviewer");
		expect(resumeState.state).toMatchObject({ architect: "architect-v1", green: "green-v1" });

		const reran: string[] = [];
		const second = await runSuperstepGraph(graph, {
			runId: "run1",
			runNode: async (node) => {
				reran.push(node.id);
				return { result: `${node.id}-v2` };
			},
			resume: {
				state: resumeState.state,
				resumeFromFrontier: [resumeState.resumeFrom!],
				remainingInDegree: {},
				completedRounds: resumeState.completedSteps,
				completedNodeExecutions: resumeState.completedSteps,
				executedNodeIds: resumeState.executions.map((e) => e.nodeId),
			},
		});

		expect(second.status).toBe("completed");
		// Only the node that failed is retried.
		expect(reran).toEqual(["reviewer"]);
		expect(second.state.architect).toBe("architect-v1");
	});
});
