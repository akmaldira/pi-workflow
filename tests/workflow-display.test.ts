import { describe, it, expect } from "vitest";
import {
	createWorkflowSnapshot,
	recordAgent,
	updatePhaseStatus,
	finalizeSnapshot,
	getSnapshotStats,
	renderWorkflowText,
	renderWorkflowLines,
	previewValue,
} from "../extensions/workflow-display.ts";
import type { WorkflowAgentSnapshot } from "../extensions/workflow-display-types.ts";

describe("Workflow Display & Real-Time Monitoring", () => {
	it("creates a new snapshot", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test_workflow",
			description: "A test workflow",
			phases: [{ title: "Phase 1" }, { title: "Phase 2" }],
		});

		expect(snapshot.meta.name).toBe("test_workflow");
		expect(snapshot.status).toBe("running");
		expect(snapshot.phases.length).toBe(2);
		expect(snapshot.totalAgents).toBe(0);
		expect(snapshot.totalTokens).toBe(0);
	});

	it("records agents in phases", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
			phases: [{ title: "Phase 1" }],
		});

		const agent: WorkflowAgentSnapshot = {
			id: 1,
			label: "Agent 1",
			phase: "Phase 1",
			prompt: "do task",
			status: "done",
			outputTokens: 100,
		};

		recordAgent(snapshot, 0, agent);

		expect(snapshot.totalAgents).toBe(1);
		expect(snapshot.totalTokens).toBe(100);
		expect(snapshot.phases[0].agents.length).toBe(1);
	});

	it("accumulates tokens across multiple agents", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
			phases: [{ title: "Phase 1" }],
		});

		const agent1: WorkflowAgentSnapshot = {
			id: 1,
			label: "A1",
			prompt: "task",
			status: "done",
			outputTokens: 50,
		};

		const agent2: WorkflowAgentSnapshot = {
			id: 2,
			label: "A2",
			prompt: "task",
			status: "done",
			outputTokens: 75,
		};

		recordAgent(snapshot, 0, agent1);
		recordAgent(snapshot, 0, agent2);

		expect(snapshot.totalAgents).toBe(2);
		expect(snapshot.totalTokens).toBe(125);
	});

	it("updates phase status", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
			phases: [{ title: "Phase 1" }],
		});

		expect(snapshot.phases[0].status).toBe("pending");

		updatePhaseStatus(snapshot, 0, "active");
		expect(snapshot.phases[0].status).toBe("active");

		updatePhaseStatus(snapshot, 0, "completed");
		expect(snapshot.phases[0].status).toBe("completed");
	});

	it("finalizes snapshot with result", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
		});

		finalizeSnapshot(snapshot, { output: "done" }, undefined, 1000);

		expect(snapshot.status).toBe("completed");
		expect(snapshot.result).toEqual({ output: "done" });
		expect(snapshot.durationMs).toBe(1000);
	});

	it("finalizes snapshot with error", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
		});

		finalizeSnapshot(snapshot, undefined, "Something failed", 500);

		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toBe("Something failed");
		expect(snapshot.durationMs).toBe(500);
	});

	it("calculates statistics", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
			phases: [{ title: "Phase 1" }],
		});

		const agent1: WorkflowAgentSnapshot = {
			id: 1,
			label: "A1",
			prompt: "task",
			status: "done",
			outputTokens: 100,
		};

		const agent2: WorkflowAgentSnapshot = {
			id: 2,
			label: "A2",
			prompt: "task",
			status: "error",
			outputTokens: 50,
		};

		recordAgent(snapshot, 0, agent1);
		recordAgent(snapshot, 0, agent2);

		snapshot.durationMs = 2000;

		const stats = getSnapshotStats(snapshot);

		expect(stats.totalAgents).toBe(2);
		expect(stats.completedAgents).toBe(1);
		expect(stats.failedAgents).toBe(1);
		expect(stats.totalTokens).toBe(150);
		expect(stats.totalDurationMs).toBe(2000);
		expect(stats.averageTokensPerAgent).toBe(75);
		expect(stats.averageDurationPerAgent).toBe(1000);
	});

	it("renders workflow text", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test_workflow",
			description: "A test",
			phases: [{ title: "Phase 1" }],
		});

		const agent: WorkflowAgentSnapshot = {
			id: 1,
			label: "Test Agent",
			prompt: "do work",
			status: "done",
			outputTokens: 100,
		};

		recordAgent(snapshot, 0, agent);

		const text = renderWorkflowText(snapshot);

		expect(text).toContain("test_workflow");
		expect(text).toContain("A test");
		expect(text).toContain("Phase 1");
		expect(text).toContain("Test Agent");
	});

	it("renders with compact mode", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
			phases: [{ title: "Phase 1" }],
		});

		const agent: WorkflowAgentSnapshot = {
			id: 1,
			label: "Agent",
			prompt: "task",
			status: "done",
		};

		recordAgent(snapshot, 0, agent);

		const text = renderWorkflowText(snapshot, { compact: true });

		expect(text).toContain("Phase 1");
		expect(text).toContain("1/1");
	});

	it("renders with tokens hidden", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
			phases: [{ title: "Phase 1" }],
		});

		const agent: WorkflowAgentSnapshot = {
			id: 1,
			label: "Agent",
			prompt: "task",
			status: "done",
			outputTokens: 100,
		};

		recordAgent(snapshot, 0, agent);

		const text = renderWorkflowText(snapshot, { showTokens: false });

		expect(text).not.toContain("100t");
	});

	it("renders with model info", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
			phases: [{ title: "Phase 1" }],
		});

		const agent: WorkflowAgentSnapshot = {
			id: 1,
			label: "Agent",
			prompt: "task",
			status: "done",
			model: "gpt-4",
		};

		recordAgent(snapshot, 0, agent);

		const text = renderWorkflowText(snapshot, { showModel: true });

		expect(text).toContain("gpt-4");
	});

	it("renders workflow lines", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
		});

		const lines = renderWorkflowLines(snapshot);

		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toContain("test");
	});

	it("previews values", () => {
		const short = previewValue("hello", 10);
		expect(short).toBe("hello");

		const long = previewValue("this is a very long string that exceeds the limit", 20);
		expect(long).toContain("…");
		expect(long.length).toBeLessThanOrEqual(21);
	});

	it("shows running status correctly", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
		});

		const text = renderWorkflowText(snapshot);
		expect(text).toContain("▶"); // Running indicator
	});

	it("shows completed status correctly", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
		});

		finalizeSnapshot(snapshot, { result: "done" }, undefined, 1000);

		const text = renderWorkflowText(snapshot);
		expect(text).toContain("✓"); // Completed indicator
		expect(text).toContain("Completed");
	});

	it("shows error status correctly", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
		});

		finalizeSnapshot(snapshot, undefined, "Task failed", 500);

		const text = renderWorkflowText(snapshot);
		expect(text).toContain("✗"); // Error indicator
		expect(text).toContain("Task failed");
	});

	it("handles phases with no agents", () => {
		const snapshot = createWorkflowSnapshot({
			name: "test",
			description: "Test",
			phases: [{ title: "Empty Phase" }],
		});

		const text = renderWorkflowText(snapshot);
		expect(text).toContain("Empty Phase");
	});

	it("shows multiple phases", () => {
		const snapshot = createWorkflowSnapshot({
			name: "multi",
			description: "Multi phase",
			phases: [{ title: "Phase 1" }, { title: "Phase 2" }, { title: "Phase 3" }],
		});

		const text = renderWorkflowText(snapshot);
		expect(text).toContain("Phase 1");
		expect(text).toContain("Phase 2");
		expect(text).toContain("Phase 3");
	});
});
