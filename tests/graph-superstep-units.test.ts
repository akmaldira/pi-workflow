import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agent, END, GraphBuilder } from "../extensions/graph-dsl.ts";
import {
	GraphJournal,
	graphScriptHash,
	loadGraphSuperstepResumeState,
	readGraphJournal,
} from "../extensions/graph-journal.ts";
import { buildGraphFromScript } from "../extensions/graph-validator.ts";
import { GraphDisplayBridge } from "../extensions/graph-display-bridge.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";

describe("DSL: superstep mode detection", () => {
	it("stays linear when every node has one outgoing edge", () => {
		const g = new GraphBuilder();
		g.node("a", agent("planner", () => "a"));
		g.node("b", agent("green", () => "b"));
		g.edge("a", "b");
		g.edge("b", END);
		g.run();

	});

	it("becomes superstep as soon as one node fans out", () => {
		const g = new GraphBuilder();
		g.node("a", agent("planner", () => "a"));
		g.node("b", agent("green", () => "b"));
		g.node("c", agent("red", () => "c"));
		g.edge("a", "b");
		g.edge("a", "c");
		g.edge("b", END);
		g.edge("c", END);
		g.run();

		const built = g.build();
		expect(built.edges.get("a")).toHaveLength(2);
	});

	it("a cycle alone does not make a graph superstep", () => {
		// Each node still has exactly one outgoing edge; the conditional just
		// picks between targets. This must keep using the linear walk.
		const g = new GraphBuilder();
		g.node("a", agent("planner", () => "a"));
		g.node("b", agent("green", () => "b"));
		g.edge("a", "b");
		g.edge("b", (_s, r) => ((r as { ok?: boolean }).ok ? END : "a"));
		g.run();

	});

	it("validates a fan-out graph's reachability across all edges", () => {
		const g = new GraphBuilder();
		g.node("a", agent("planner", () => "a"));
		g.node("b", agent("green", () => "b"));
		g.node("orphan", agent("red", () => "x"));
		g.edge("a", "b");
		g.edge("a", "b"); // duplicate fan-out edge, still never reaches orphan
		g.edge("b", END);
		g.edge("orphan", END);
		g.run();

		expect(g.validate().some((e) => e.includes("orphan"))).toBe(true);
	});
});

describe("validator: parallel scripts build in the sandbox", () => {
	it("evaluates a fan-out script and reports superstep mode", () => {
		const script = `export const meta = { name: "par", description: "fan out" };
const g = graph();
g.node("scout", agent("scout", () => "s"));
g.node("a", agent("researcher", (s) => "A " + s.scout));
g.node("b", agent("researcher", (s) => "B " + s.scout));
g.node("sum", agent("worker", (s) => s.a + s.b));
g.edge("scout", "a");
g.edge("scout", "b");
g.edge("a", "sum");
g.edge("b", "sum");
g.edge("sum", END);
g.run();`;

		const { graph } = buildGraphFromScript(script);

		expect(graph.edges.get("scout")).toHaveLength(2);
		// Both fan-in edges are recorded, one per source.
		expect(graph.edges.get("a")).toHaveLength(1);
		expect(graph.edges.get("b")).toHaveLength(1);
	});
});

describe("journal: rounds and superstep resume", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-journal-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function journalFor(runId: string): GraphJournal {
		return GraphJournal.create({
			journalDir: dir,
			runId,
			scriptHash: "hash-1",
			name: "par",
			description: "d",
			entry: "scout",
			nodeIds: ["scout", "a", "b", "sum"],
			initialState: { task: "t" },
		});
	}

	function node(step: number, round: number, nodeId: string, routedTo: string) {
		return {
			step,
			round,
			nodeId,
			nodeType: "agent" as const,
			agentName: "x",
			status: "ok" as const,
			result: `${nodeId}-result`,
			routedTo,
			startedAt: 0,
			durationMs: 1,
		};
	}

	it("records round on node records and writes round_complete markers", () => {
		const j = journalFor("r1");
		j.recordNode(node(1, 1, "scout", "a,b"));
		j.recordRoundComplete({
			round: 1,
			nodeIds: ["scout"],
			nextFrontier: ["a", "b"],
			remainingInDegree: { scout: 0, a: 0, b: 0, sum: 2 },
		});

		const records = readGraphJournal(path.join(dir, "r1.jsonl"));
		const nodeRec = records.find((r) => r.type === "node");
		const roundRec = records.find((r) => r.type === "round_complete");

		expect(nodeRec).toMatchObject({ round: 1, nodeId: "scout", routedTo: "a,b" });
		expect(roundRec).toMatchObject({
			round: 1,
			nodeIds: ["scout"],
			nextFrontier: ["a", "b"],
			remainingInDegree: { sum: 2 },
		});
	});

	it("records and resumes remainingClaimsBySource when the executor supplies it", () => {
		const j = journalFor("r1b");
		j.recordNode(node(1, 1, "scout", "a,b"));
		j.recordRoundComplete({
			round: 1,
			nodeIds: ["scout"],
			nextFrontier: ["a", "b"],
			remainingInDegree: { scout: 0, a: 0, b: 0, sum: 2 },
			remainingClaimsBySource: { sum: { a: 1, b: 1 } },
		});

		const records = readGraphJournal(path.join(dir, "r1b.jsonl"));
		const roundRec = records.find((r) => r.type === "round_complete");
		expect(roundRec).toMatchObject({
			remainingInDegree: { sum: 2 },
			remainingClaimsBySource: { sum: { a: 1, b: 1 } },
		});

		const resume = loadGraphSuperstepResumeState({
			journalDir: dir,
			runId: "r1b",
			scriptHash: "hash-1",
		});
		expect(resume.remainingClaimsBySource).toEqual({ sum: { a: 1, b: 1 } });
	});

	it("leaves remainingClaimsBySource undefined for a legacy round record without it", () => {
		const j = journalFor("r1c");
		j.recordNode(node(1, 1, "scout", "a,b"));
		// A legacy caller omits remainingClaimsBySource entirely (pre-fix journal).
		j.recordRoundComplete({
			round: 1,
			nodeIds: ["scout"],
			nextFrontier: ["a", "b"],
			remainingInDegree: { scout: 0, a: 0, b: 0, sum: 2 },
		});

		const resume = loadGraphSuperstepResumeState({
			journalDir: dir,
			runId: "r1c",
			scriptHash: "hash-1",
		});
		expect(resume.remainingClaimsBySource).toBeUndefined();
		expect(resume.remainingInDegree).toEqual({ scout: 0, a: 0, b: 0, sum: 2 });
	});

	it("resumes from the last completed round's frontier", () => {
		const j = journalFor("r2");
		j.recordNode(node(1, 1, "scout", "a,b"));
		j.recordRoundComplete({
			round: 1,
			nodeIds: ["scout"],
			nextFrontier: ["a", "b"],
			remainingInDegree: { scout: 0, a: 0, b: 0, sum: 2 },
		});
		j.recordNode(node(2, 2, "a", "sum"));
		j.recordNode(node(3, 2, "b", "sum"));
		j.recordRoundComplete({
			round: 2,
			nodeIds: ["a", "b"],
			nextFrontier: ["sum"],
			remainingInDegree: { scout: 0, a: 0, b: 0, sum: 0 },
		});

		const resume = loadGraphSuperstepResumeState({
			journalDir: dir,
			runId: "r2",
			scriptHash: "hash-1",
		});

		expect(resume.isValid).toBe(true);
		expect(resume.frontier).toEqual(["sum"]);
		expect(resume.completedRounds).toBe(2);
		expect(resume.completedNodeExecutions).toBe(3);
		expect(resume.executedNodeIds.sort()).toEqual(["a", "b", "scout"]);
		expect(resume.state).toMatchObject({
			task: "t",
			scout: "scout-result",
			a: "a-result",
			b: "b-result",
		});
	});

	it("discards a crashed round: nodes written without a round_complete marker", () => {
		const j = journalFor("r3");
		j.recordNode(node(1, 1, "scout", "a,b"));
		j.recordRoundComplete({
			round: 1,
			nodeIds: ["scout"],
			nextFrontier: ["a", "b"],
			remainingInDegree: { scout: 0, a: 0, b: 0, sum: 2 },
		});
		// Round 2 started and one node landed, then the process died.
		j.recordNode(node(2, 2, "a", "sum"));

		const resume = loadGraphSuperstepResumeState({
			journalDir: dir,
			runId: "r3",
			scriptHash: "hash-1",
		});

		// The half-finished round is rolled back: resume re-runs both a and b.
		expect(resume.completedRounds).toBe(1);
		expect(resume.frontier).toEqual(["a", "b"]);
		expect(resume.executedNodeIds).toEqual(["scout"]);
		expect(resume.state).not.toHaveProperty("a");
	});

	it("starts at the entry when no round ever completed", () => {
		journalFor("r4");

		const resume = loadGraphSuperstepResumeState({
			journalDir: dir,
			runId: "r4",
			scriptHash: "hash-1",
		});

		expect(resume.frontier).toEqual(["scout"]);
		expect(resume.completedRounds).toBe(0);
	});

	it("refuses to resume when the script changed", () => {
		journalFor("r5");

		const resume = loadGraphSuperstepResumeState({
			journalDir: dir,
			runId: "r5",
			scriptHash: graphScriptHash("something else"),
		});

		expect(resume.isValid).toBe(false);
		expect(resume.invalidReason).toMatch(/changed/i);
	});

	it("reports nothing to resume once the run completed", () => {
		const j = journalFor("r6");
		j.recordNode(node(1, 1, "scout", "a,b"));
		j.recordRoundComplete({
			round: 1,
			nodeIds: ["scout"],
			nextFrontier: [],
			remainingInDegree: {},
		});
		j.recordResult({ status: "completed", iterations: 1, nodeExecutions: 1, durationMs: 5 });

		const resume = loadGraphSuperstepResumeState({
			journalDir: dir,
			runId: "r6",
			scriptHash: "hash-1",
		});

		expect(resume.isValid).toBe(true);
		expect(resume.frontier).toEqual([]);
	});

	it("preserves folded .data in completed rounds and discards state_action records of crashed rounds", () => {
		const j = journalFor("r7");
		// Round 1 completed: scout's result carries folded data (node runner
		// drains the buffer into result.data before journaling).
		j.recordNode({
			...node(1, 1, "scout", "a,b"),
			result: { status: "ok", text: "done", agent: "x", data: { found: "yes" } },
		});
		j.recordRoundComplete({
			round: 1,
			nodeIds: ["scout"],
			nextFrontier: ["a", "b"],
			remainingInDegree: { scout: 0, a: 0, b: 0, sum: 2 },
		});
		// Round 2 crashed: node "a" wrote a state_action, then died before its
		// node record and round marker. The action must NOT reconstruct "a".
		j.recordStateAction({ runId: "r7", nodeId: "a", action: "set", key: "invoice", value: "INV-999" });

		const resume = loadGraphSuperstepResumeState({
			journalDir: dir,
			runId: "r7",
			scriptHash: "hash-1",
		});

		expect(resume.isValid).toBe(true);
		// Completed round's data survived via the node record.
		expect((resume.state.scout as { data?: Record<string, unknown> }).data).toEqual({ found: "yes" });
		// Crashed round: a is not in state, no stale data leaked.
		expect(resume.state).not.toHaveProperty("a");
		expect(resume.executedNodeIds).toEqual(["scout"]);
		expect(resume.frontier).toEqual(["a", "b"]);
	});
});

describe("display bridge: concurrent nodes", () => {
	function bridge() {
		const manager = new WorkflowManager();
		const b = new GraphDisplayBridge({
			manager,
			runId: "r1",
			name: "par",
			description: "d",
		});
		return { manager, bridge: b };
	}

	const agentsOf = (m: WorkflowManager) => m.getRun("r1")!.snapshot.agents;

	it("tracks two nodes running in the same round without collision", () => {
		const { manager, bridge: b } = bridge();

		b.nodeStarted({ step: 2, nodeId: "researcherA", nodeType: "agent", agentName: "researcher", round: 2 });
		b.nodeStarted({ step: 3, nodeId: "researcherB", nodeType: "agent", agentName: "researcher", round: 2 });

		const running = agentsOf(manager);
		expect(running).toHaveLength(2);
		expect(running.every((a) => a.status === "running")).toBe(true);
		expect(running[0].label).toContain("researcherA");
		expect(running[1].label).toContain("researcherB");
	});

	it("completes each concurrent node independently", () => {
		const { manager, bridge: b } = bridge();
		b.nodeStarted({ step: 2, nodeId: "researcherA", nodeType: "agent", round: 2 });
		b.nodeStarted({ step: 3, nodeId: "researcherB", nodeType: "agent", round: 2 });

		const exec = (step: number, nodeId: string) => ({
			step,
			round: 2,
			nodeId,
			nodeType: "agent" as const,
			status: "ok" as const,
			result: `${nodeId} done`,
			routedTo: "summarizer",
			startedAt: 0,
			durationMs: 5,
		});

		b.nodeCompleted(exec(3, "researcherB"));
		b.nodeCompleted(exec(2, "researcherA"));

		const done = agentsOf(manager);
		expect(done).toHaveLength(2);
		expect(done.every((a) => a.status === "done")).toBe(true);
	});

	it("logs the barrier so the parallel shape is visible", () => {
		const { manager, bridge: b } = bridge();
		b.roundComplete({ round: 2, nodeIds: ["researcherA", "researcherB"], nextFrontier: ["summarizer"] });

		const logs = manager.getRun("r1")!.snapshot.logs.join("\n");
		expect(logs).toContain("Round 2 complete");
		expect(logs).toContain("researcherA, researcherB");
		expect(logs).toContain("summarizer");
	});

	it("labels a node with its agent", () => {
		const { manager, bridge: b } = bridge();
		b.nodeStarted({ step: 1, nodeId: "planner", nodeType: "agent", agentName: "planner" });

		expect(agentsOf(manager)[0].label).toBe("planner (planner)");
	});
});
