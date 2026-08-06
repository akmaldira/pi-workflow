import { describe, expect, it } from "vitest";
import { GraphDisplayBridge } from "../extensions/graph-display-bridge.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";
import type { NodeExecution } from "../extensions/graph-executor.ts";

function execution(overrides: Partial<NodeExecution> = {}): NodeExecution {
	return {
		step: 1,
		nodeId: "green",
		nodeType: "agent",
		agentName: "green",
		status: "ok",
		result: "done",
		routedTo: "reviewer",
		startedAt: Date.now(),
		durationMs: 10,
		...overrides,
	};
}

function bridgeWith(): { manager: WorkflowManager; bridge: GraphDisplayBridge } {
	const manager = new WorkflowManager();
	const bridge = new GraphDisplayBridge({
		manager,
		runId: "r1",
		name: "test_graph",
		description: "d",
	});
	return { manager, bridge };
}

function agentsOf(manager: WorkflowManager) {
	return manager.getRun("r1")!.snapshot.agents;
}

describe("GraphDisplayBridge", () => {
	it("registers the run", () => {
		const { manager } = bridgeWith();

		expect(manager.getRun("r1")?.snapshot.meta.name).toBe("test_graph");
	});

	it("labels a node with its agent", () => {
		const { manager, bridge } = bridgeWith();
		bridge.nodeStarted({ step: 1, nodeId: "green", nodeType: "agent", agentName: "green" });

		expect(agentsOf(manager)[0].label).toBe("green (green)");
	});

	it("labels a non-agent node by id alone", () => {
		const { manager, bridge } = bridgeWith();
		bridge.nodeStarted({ step: 1, nodeId: "approve", nodeType: "human" });

		expect(agentsOf(manager)[0].label).toBe("approve");
	});

	it("records one entry per visit so loops stay visible", () => {
		const { manager, bridge } = bridgeWith();
		for (const step of [1, 2, 3]) {
			bridge.nodeStarted({ step, nodeId: "green", nodeType: "agent", agentName: "green" });
			bridge.nodeCompleted(execution({ step }));
		}

		expect(agentsOf(manager)).toHaveLength(3);
	});

	describe("preview text", () => {
		it("leads with the routing target", () => {
			// Routing is what distinguishes a coordination loop from a
			// pipeline; putting it last meant long agent prose truncated it
			// away exactly when the run was most interesting.
			const { manager, bridge } = bridgeWith();
			bridge.nodeStarted({ step: 1, nodeId: "green", nodeType: "agent", agentName: "green" });
			bridge.nodeCompleted(execution({ result: "x".repeat(500), routedTo: "architect" }));

			expect(agentsOf(manager)[0].resultPreview).toMatch(/^→ architect/);
		});

		it("strips reasoning blocks", () => {
			// Agent replies routinely open with <think></think>, which would
			// otherwise fill the preview with nothing.
			const { manager, bridge } = bridgeWith();
			bridge.nodeStarted({ step: 1, nodeId: "sum", nodeType: "agent", agentName: "researcher" });
			bridge.nodeCompleted(
				execution({ result: "<think>pondering hard</think>The answer is 42.", routedTo: "END" }),
			);

			const preview = agentsOf(manager)[0].resultPreview!;
			expect(preview).not.toContain("think");
			expect(preview).not.toContain("pondering");
			expect(preview).toContain("The answer is 42.");
		});

		it("strips markdown scaffolding", () => {
			const { manager, bridge } = bridgeWith();
			bridge.nodeStarted({ step: 1, nodeId: "sum", nodeType: "agent" });
			bridge.nodeCompleted(execution({ result: "## Answer\n**bold** and `code`", routedTo: "END" }));

			const preview = agentsOf(manager)[0].resultPreview!;
			expect(preview).not.toContain("##");
			expect(preview).not.toContain("**");
			expect(preview).toContain("Answer");
		});

		it("leads with the escalation when an agent is blocked", () => {
			// A blocker is the signal this system exists to surface, so it
			// must not sit behind whatever prose preceded it.
			const { manager, bridge } = bridgeWith();
			bridge.nodeStarted({ step: 1, nodeId: "green", nodeType: "agent", agentName: "green" });
			bridge.nodeCompleted(
				execution({
					routedTo: "architect",
					result: {
						status: "blocked",
						blockedOn: "contract",
						reason: "cannot express soft-delete",
						text: "a long preamble that should not dominate the preview",
					},
				}),
			);

			const preview = agentsOf(manager)[0].resultPreview!;
			expect(preview).toContain("→ architect");
			expect(preview).toContain("blocked on contract");
			expect(preview).toContain("cannot express soft-delete");
		});

		it("shows a human node's answer", () => {
			const { manager, bridge } = bridgeWith();
			bridge.nodeStarted({ step: 1, nodeId: "approve", nodeType: "human" });
			bridge.nodeCompleted(
				execution({ nodeType: "human", agentName: undefined, result: { status: "ok", answer: "ship" } }),
			);

			expect(agentsOf(manager)[0].resultPreview).toContain('answered "ship"');
		});

		it("truncates long text", () => {
			const { manager, bridge } = bridgeWith();
			bridge.nodeStarted({ step: 1, nodeId: "a", nodeType: "agent" });
			bridge.nodeCompleted(execution({ result: "y".repeat(400) }));

			expect(agentsOf(manager)[0].resultPreview!.length).toBeLessThan(120);
		});
	});

	it("marks a failed node as an error", () => {
		const { manager, bridge } = bridgeWith();
		bridge.nodeStarted({ step: 1, nodeId: "green", nodeType: "agent" });
		bridge.nodeCompleted(execution({ status: "failed", error: "spawn failed" }));

		expect(agentsOf(manager)[0].status).toBe("error");
	});

	it("logs the path on completion", () => {
		const { manager, bridge } = bridgeWith();
		bridge.runCompleted({
			status: "completed",
			state: {},
			history: [],
			path: ["architect", "green", "architect"],
			iterations: 3,
			startedAt: Date.now(),
			durationMs: 5,
		});

		const logs = manager.getRun("r1")!.snapshot.logs.join("\n");
		expect(logs).toContain("architect → green → architect");
	});

	it("survives a manager that throws", () => {
		// Display is an observer; a rendering fault must not take down a run
		// that is otherwise working.
		const manager = new WorkflowManager();
		const bridge = new GraphDisplayBridge({ manager, runId: "r1", name: "t", description: "d" });
		manager.markAgentStart = () => {
			throw new Error("render exploded");
		};
		manager.markAgentEnd = () => {
			throw new Error("render exploded");
		};

		expect(() => {
			bridge.nodeStarted({ step: 1, nodeId: "a", nodeType: "agent" });
			bridge.nodeCompleted(execution());
		}).not.toThrow();
	});
});

describe("preview cleanup edge cases", () => {
	it("strips a heading that follows an inline reasoning block", () => {
		// "<think></think>## Answer ..." leaves the heading mid-line once
		// whitespace is collapsed, where a line-anchored strip cannot see it.
		const manager = new WorkflowManager();
		const bridge = new GraphDisplayBridge({ manager, runId: "r1", name: "t", description: "d" });
		bridge.nodeStarted({ step: 1, nodeId: "sum", nodeType: "agent" });
		bridge.nodeCompleted({
			step: 1,
			nodeId: "sum",
			nodeType: "agent",
			status: "ok",
			result: "<think></think>## Answer The report is accurate.",
			routedTo: "END",
			startedAt: Date.now(),
			durationMs: 1,
		});

		const preview = manager.getRun("r1")!.snapshot.agents[0].resultPreview!;
		expect(preview).not.toContain("#");
		expect(preview).toContain("Answer The report is accurate.");
	});
});
