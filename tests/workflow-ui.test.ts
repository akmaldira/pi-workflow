import { describe, it, expect, beforeEach } from "vitest";
import {
	NavigatorState,
	NavigatorModel,
	keyToAction,
	renderNavigatorText,
} from "../extensions/workflow-ui.ts";
import { WorkflowManager } from "../extensions/workflow-manager.ts";

describe("NavigatorState", () => {
	let state: NavigatorState;

	beforeEach(() => {
		state = new NavigatorState();
	});

	it("initializes at runs view", () => {
		expect(state.kind).toBe("runs");
		expect(state.cursor).toBe(0);
	});

	it("moves cursor with bounds checking", () => {
		state.move(1, 3);
		expect(state.cursor).toBe(1);

		state.move(1, 3);
		expect(state.cursor).toBe(2);

		// Clamp at max
		state.move(1, 3);
		expect(state.cursor).toBe(2);

		// Move up
		state.move(-1, 3);
		expect(state.cursor).toBe(1);

		// Clamp at 0
		state.move(-5, 3);
		expect(state.cursor).toBe(0);
	});

	it("moves page up and down", () => {
		state.movePage("down", 10, 5);
		expect(state.cursor).toBe(5);

		state.movePage("up", 10, 5);
		expect(state.cursor).toBe(0);
	});

	it("jumps to top and bottom", () => {
		state.jump("bottom", 10);
		expect(state.cursor).toBe(9);

		state.jump("top", 10);
		expect(state.cursor).toBe(0);
	});

	it("drills into runs -> phases -> agents -> detail", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-123", {
			name: "my_workflow",
			phases: [{ title: "Phase 1" }],
		});

		manager.markAgentStart("run-123", 0, {
			id: 1,
			label: "Agent 1",
			prompt: "task 1",
			status: "done",
		});

		const model = new NavigatorModel(manager);

		// Drill into runs -> phases
		expect(state.drill(model)).toBe(true);
		expect(state.kind).toBe("phases");
		expect(state.runId).toBe("run-123");

		// Drill into phases -> agents
		expect(state.drill(model)).toBe(true);
		expect(state.kind).toBe("agents");
		expect(state.phase).toBe("Phase 1");

		// Drill into agents -> detail
		expect(state.drill(model)).toBe(true);
		expect(state.kind).toBe("detail");
		expect(state.agentId).toBe(1);

		// Back to agents
		expect(state.back()).toBe(true);
		expect(state.kind).toBe("agents");

		// Back to phases
		expect(state.back()).toBe(true);
		expect(state.kind).toBe("phases");

		// Back to runs
		expect(state.back()).toBe(true);
		expect(state.kind).toBe("runs");

		// Back at top level returns false
		expect(state.back()).toBe(false);
	});
});

describe("keyToAction", () => {
	it("maps arrow keys and vim keys to actions", () => {
		expect(keyToAction("up", "runs")).toEqual({ type: "move", delta: -1 });
		expect(keyToAction("k", "runs")).toEqual({ type: "move", delta: -1 });

		expect(keyToAction("down", "runs")).toEqual({ type: "move", delta: 1 });
		expect(keyToAction("j", "runs")).toEqual({ type: "move", delta: 1 });

		expect(keyToAction("enter", "runs")).toEqual({ type: "drill" });
		expect(keyToAction("return", "runs")).toEqual({ type: "drill" });
		expect(keyToAction("right", "runs")).toEqual({ type: "drill" });

		expect(keyToAction("escape", "runs")).toEqual({ type: "back" });
		expect(keyToAction("left", "runs")).toEqual({ type: "back" });

		expect(keyToAction("q", "runs")).toEqual({ type: "close" });
		expect(keyToAction("x", "runs")).toEqual({ type: "stop" });
		expect(keyToAction("p", "runs")).toEqual({ type: "pause" });
		expect(keyToAction("r", "runs")).toEqual({ type: "resume" });
	});
});

describe("renderNavigatorText", () => {
	it("renders runs list", () => {
		const manager = new WorkflowManager();
		manager.registerRun("run-abc", { name: "test_run" });

		const state = new NavigatorState();
		const model = new NavigatorModel(manager);

		const lines = renderNavigatorText(state, model, 80);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => l.includes("test_run"))).toBe(true);
	});

	it("renders empty runs list when no runs", () => {
		const manager = new WorkflowManager();
		const state = new NavigatorState();
		const model = new NavigatorModel(manager);

		const lines = renderNavigatorText(state, model, 80);

		expect(lines.some((l) => l.includes("No active or recorded workflow runs"))).toBe(true);
	});
});
