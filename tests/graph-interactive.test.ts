import { describe, expect, it, vi } from "vitest";
import {
	createHumanHandler,
	createInteractiveHandlers,
	createMainAgentHandler,
	formatStateForReview,
} from "../extensions/graph-interactive.ts";
import { agent, END, GraphBuilder, human, mainAgent } from "../extensions/graph-dsl.ts";
import { runGraph } from "../extensions/graph-executor.ts";
import { createNodeRunner } from "../extensions/graph-node-runner.ts";

function uiCtx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: true,
		ui: {
			select: vi.fn(),
			input: vi.fn(),
			confirm: vi.fn(),
			notify: vi.fn(),
			...overrides,
		},
	} as never;
}

const HEADLESS = { hasUI: false, ui: undefined } as never;

describe("formatStateForReview", () => {
	it("reports empty state plainly", () => {
		expect(formatStateForReview({})).toBe("(no state yet)");
	});

	it("renders each node's result under its id", () => {
		const text = formatStateForReview({ task: "ship", planner: "step 1" });

		expect(text).toContain("task:");
		expect(text).toContain("ship");
		expect(text).toContain("planner:");
	});

	it("renders an agent result as its text, not as a JSON envelope", () => {
		// The reader wants what the agent said, not its wrapper.
		const result = { status: "ok", text: "Contract v2", agent: "architect" };
		Object.defineProperty(result, "toString", { value: () => "Contract v2", enumerable: false });

		expect(formatStateForReview({ architect: result })).toContain("Contract v2");
	});

	it("truncates so a long run stays readable", () => {
		const text = formatStateForReview({ big: "x".repeat(10000) }, 500);

		expect(text.length).toBeLessThan(1200);
		expect(text).toContain("…");
	});
});

describe("createHumanHandler", () => {
	describe("with a UI", () => {
		it("asks with a select dialog when the node has options", async () => {
			const select = vi.fn().mockResolvedValue("yes");
			const ctx = uiCtx({ select });
			const handler = createHumanHandler({ ctx });

			const answer = await handler!({ prompt: "Ship it?", options: ["yes", "no"] }, {});

			expect(select).toHaveBeenCalledWith("Ship it?", ["yes", "no"]);
			expect(answer).toMatchObject({ answer: "yes", source: "human" });
		});

		it("asks with an input dialog when the node has no options", async () => {
			const input = vi.fn().mockResolvedValue("because of X");
			const ctx = uiCtx({ input });
			const handler = createHumanHandler({ ctx });

			const answer = await handler!({ prompt: "Why?" }, {});

			expect(input).toHaveBeenCalled();
			expect(answer).toMatchObject({ answer: "because of X", source: "human" });
		});

		it("falls back to the default when the dialog is dismissed", async () => {
			// Dismissing is deliberate; re-prompting would trap the user in a
			// loop they cannot exit.
			const ctx = uiCtx({ select: vi.fn().mockResolvedValue(undefined) });
			const handler = createHumanHandler({ ctx });

			const answer = await handler!({ prompt: "Ship it?", options: ["yes", "no"], default: "no" }, {});

			expect(answer).toMatchObject({ answer: "no", source: "default" });
		});

		it("returns empty when dismissed with no default", async () => {
			const ctx = uiCtx({ input: vi.fn().mockResolvedValue(undefined) });
			const handler = createHumanHandler({ ctx });

			expect(await handler!({ prompt: "Why?" }, {})).toMatchObject({ answer: "", source: "none" });
		});

		it("survives a dialog that throws", async () => {
			// A UI fault must not take down a run that is otherwise fine.
			const ctx = uiCtx({ select: vi.fn().mockRejectedValue(new Error("tui gone")) });
			const handler = createHumanHandler({ ctx });

			const answer = await handler!({ prompt: "Ship?", options: ["y"], default: "y" }, {});

			expect(answer).toMatchObject({ answer: "y", source: "default" });
		});

		it("logs what happened", async () => {
			const events: string[] = [];
			const ctx = uiCtx({ select: vi.fn().mockResolvedValue("yes") });
			const handler = createHumanHandler({ ctx, onEvent: (m) => events.push(m) });

			await handler!({ prompt: "Ship?", options: ["yes"] }, {});

			expect(events.join("\n")).toContain('answered "yes"');
		});
	});

	describe("headless", () => {
		it("uses the declared default rather than hanging", async () => {
			// The property that matters most: a run nobody is watching must
			// finish, not block forever on an answer no one can give.
			const handler = createHumanHandler({ ctx: HEADLESS });

			const answer = await handler!(
				{ prompt: "Ship it?", options: ["yes", "no"], default: "no" },
				{},
			);

			expect(answer).toMatchObject({ answer: "no", source: "default" });
		});

		it("returns empty when there is no default", async () => {
			const handler = createHumanHandler({ ctx: HEADLESS });

			expect(await handler!({ prompt: "Ship it?" }, {})).toMatchObject({ answer: "", source: "none" });
		});

		it("records why the default was used", async () => {
			const events: string[] = [];
			const handler = createHumanHandler({ ctx: HEADLESS, onEvent: (m) => events.push(m) });

			await handler!({ prompt: "Ship?", default: "no" }, {});

			expect(events.join("\n")).toContain("No interactive session");
		});

		it("treats a missing ctx as headless", async () => {
			const handler = createHumanHandler({});

			expect(await handler!({ prompt: "Ship?", default: "no" }, {})).toMatchObject({ answer: "no", source: "default" });
		});
	});
});

describe("createMainAgentHandler", () => {
	it("asks for a decision and returns it", async () => {
		const input = vi.fn().mockResolvedValue("Revise the contract.");
		const ctx = uiCtx({ input });
		const handler = createMainAgentHandler({ ctx });

		const answer = await handler!("Green is blocked. What now?", { green: "blocked" });

		expect(input).toHaveBeenCalled();
		expect(answer).toBe("Revise the contract.");
	});

	it("returns empty when skipped", async () => {
		const ctx = uiCtx({ input: vi.fn().mockResolvedValue("") });
		const handler = createMainAgentHandler({ ctx });

		expect(await handler!("Decide", {})).toBe("");
	});

	it("skips rather than inventing a decision when headless", async () => {
		// Fabricating an answer would let downstream edges treat silence as
		// considered judgement.
		const handler = createMainAgentHandler({ ctx: HEADLESS });

		expect(await handler!("Decide", {})).toBe("");
	});

	it("survives a dialog that throws", async () => {
		const ctx = uiCtx({ input: vi.fn().mockRejectedValue(new Error("boom")) });
		const handler = createMainAgentHandler({ ctx });

		expect(await handler!("Decide", {})).toBe("");
	});
});

describe("createInteractiveHandlers", () => {
	it("builds both handlers", () => {
		const handlers = createInteractiveHandlers({ ctx: uiCtx() });

		expect(handlers.onHuman).toBeTypeOf("function");
		expect(handlers.onMainAgent).toBeTypeOf("function");
	});
});

describe("interactive nodes end to end", () => {
	function approvalGraph() {
		const g = new GraphBuilder();
		g.node("build", agent("green", () => "implement"));
		g.node("approve", human("Ship it?", { options: ["ship", "hold"], default: "hold" }));
		g.node("ship", agent("worker", () => "deploy"));
		g.node("stop", agent("reviewer", () => "explain"));
		g.edge("build", "approve");
		g.edge("approve", (_s, result) =>
			(result as { answer?: string }).answer === "ship" ? "ship" : "stop",
		);
		g.edge("ship", END);
		g.edge("stop", END);
		g.run();
		return g.build();
	}

	function spawnStub() {
		return vi.fn().mockResolvedValue({
			agent: "x",
			task: "t",
			exitCode: 0,
			usage: { totalTokens: 1 },
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
		});
	}

	it("routes on the human's answer", async () => {
		const ctx = uiCtx({ select: vi.fn().mockResolvedValue("ship") });

		const result = await runGraph(approvalGraph(), {
			runId: "r1",
			runNode: createNodeRunner({
				cwd: "/nonexistent",
				runId: "r1",
				spawnAgent: spawnStub() as never,
				handlers: createInteractiveHandlers({ ctx }),
			}),
		});

		expect(result.path).toEqual(["build", "approve", "ship"]);
	});

	it("routes down the default branch when headless", async () => {
		const result = await runGraph(approvalGraph(), {
			runId: "r1",
			runNode: createNodeRunner({
				cwd: "/nonexistent",
				runId: "r1",
				spawnAgent: spawnStub() as never,
				handlers: createInteractiveHandlers({ ctx: HEADLESS }),
			}),
		});

		// Completes on the declared default rather than hanging.
		expect(result.status).toBe("completed");
		expect(result.path).toEqual(["build", "approve", "stop"]);
	});

	it("marks a defaulted answer so an edge can tell it from a real one", async () => {
		// An edge that reads "default" as approval would turn absence into
		// consent, so the two must be distinguishable in the result.
		const result = await runGraph(approvalGraph(), {
			runId: "r1",
			runNode: createNodeRunner({
				cwd: "/nonexistent",
				runId: "r1",
				spawnAgent: spawnStub() as never,
				handlers: createInteractiveHandlers({ ctx: HEADLESS }),
			}),
		});

		expect(result.state.approve).toMatchObject({ status: "default", answer: "hold" });
	});

	it("marks a real answer as ok", async () => {
		const ctx = uiCtx({ select: vi.fn().mockResolvedValue("ship") });

		const result = await runGraph(approvalGraph(), {
			runId: "r1",
			runNode: createNodeRunner({
				cwd: "/nonexistent",
				runId: "r1",
				spawnAgent: spawnStub() as never,
				handlers: createInteractiveHandlers({ ctx }),
			}),
		});

		expect(result.state.approve).toMatchObject({ status: "ok", answer: "ship" });
	});

	it("runs a main-agent checkpoint mid-walk", async () => {
		const input = vi.fn().mockResolvedValue("revise the contract");
		const ctx = uiCtx({ input });

		const g = new GraphBuilder();
		g.node("green", agent("green", () => "build"));
		g.node("decide", mainAgent((s) => `Green said: ${s.green}. What now?`));
		g.node("architect", agent("architect", (s) => `revise per: ${s.decide}`));
		g.edge("green", "decide");
		g.edge("decide", "architect");
		g.edge("architect", END);
		g.run();

		const spawn = spawnStub();
		const result = await runGraph(g.build(), {
			runId: "r1",
			runNode: createNodeRunner({
				cwd: "/nonexistent",
				runId: "r1",
				spawnAgent: spawn as never,
				handlers: createInteractiveHandlers({ ctx }),
			}),
		});

		expect(result.status).toBe("completed");
		expect(result.state.decide).toMatchObject({ status: "ok" });
		// The checkpoint's decision reaches the next agent's prompt as text.
		expect(spawn.mock.calls[1][2]).toContain("revise the contract");
	});

	it("marks a skipped checkpoint rather than faking a decision", async () => {
		const g = new GraphBuilder();
		g.node("decide", mainAgent("What now?"));
		g.edge("decide", END);
		g.run();

		const result = await runGraph(g.build(), {
			runId: "r1",
			runNode: createNodeRunner({
				cwd: "/nonexistent",
				runId: "r1",
				spawnAgent: spawnStub() as never,
				handlers: createInteractiveHandlers({ ctx: HEADLESS }),
			}),
		});

		expect(result.state.decide).toMatchObject({ status: "skipped" });
	});

	it("never blocks a headless run containing several interactive nodes", async () => {
		// The whole point: a fully unattended graph terminates.
		const g = new GraphBuilder();
		g.node("a", human("First?", { default: "x" }));
		g.node("b", mainAgent("Second?"));
		g.node("c", human("Third?", { options: ["p", "q"], default: "q" }));
		g.edge("a", "b");
		g.edge("b", "c");
		g.edge("c", END);
		g.run();

		const result = await Promise.race([
			runGraph(g.build(), {
				runId: "r1",
				runNode: createNodeRunner({
					cwd: "/nonexistent",
					runId: "r1",
					spawnAgent: spawnStub() as never,
					handlers: createInteractiveHandlers({ ctx: HEADLESS }),
				}),
			}),
			new Promise((_r, reject) => setTimeout(() => reject(new Error("hung")), 2000)),
		]);

		expect((result as { status: string }).status).toBe("completed");
	});
});
