/**
 * End-to-end: project settings' defaultTurnBudget (including null to
 * disable) actually reaches runSingleAgent's resolution logic, not just the
 * loadAgentSettings merge tested in agent-settings.test.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSingleAgent } from "../extensions/execution.ts";
import { PI_SUBAGENT_PI_BINARY_ENV } from "../extensions/pi-spawn.ts";
import type { AgentConfig } from "../extensions/agents.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "You are a worker.",
		source: "user",
		filePath: "/tmp/worker.md",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

function writeRunawayPiBinary(dir: string, turnCount: number): string {
	const scriptPath = path.join(dir, "fake-pi-runaway.cjs");
	const body = `#!${process.execPath}
let i = 0;
function next() {
	if (i >= ${turnCount}) return;
	process.stdout.write(JSON.stringify({ type: "turn_end", turnIndex: i, message: { role: "assistant", content: [], stopReason: "end" }, toolResults: [] }) + "\\n");
	i++;
	setTimeout(next, 5);
}
next();
`;
	fs.writeFileSync(scriptPath, body, { mode: 0o755 });
	return scriptPath;
}

function writeProjectSettings(cwd: string, settings: Record<string, unknown>): void {
	const settingsDir = path.join(cwd, ".pi-workflow");
	fs.mkdirSync(settingsDir, { recursive: true });
	fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify(settings));
}

describe("defaultTurnBudget settings resolution (end-to-end via runSingleAgent)", () => {
	let tempDir: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-turn-budget-settings-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		process.env = { ...originalEnv };
	});

	it("uses a project settings defaultTurnBudget override instead of DEFAULT_TURN_BUDGET", async () => {
		writeProjectSettings(tempDir, { defaultTurnBudget: { maxTurns: 2, graceTurns: 1 } });
		const scriptPath = writeRunawayPiBinary(tempDir, 10); // exceeds the settings override (hard limit 3), not the built-in default (52)
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "turn-budget-settings-override-1",
			// No explicit turnBudget passed — must come from settings.
		});

		expect(result.turnBudgetExceeded).toBe(true);
		expect(result.error).toContain("3"); // hard limit = maxTurns(2) + graceTurns(1)
	}, 15000);

	it("defaultTurnBudget: null in settings disables enforcement entirely (restores unbounded behavior)", async () => {
		writeProjectSettings(tempDir, { defaultTurnBudget: null });
		const scriptPath = writeRunawayPiBinary(tempDir, 5);
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		// The fake binary never exits on its own (it just stops emitting after
		// 5 turns and hangs) — with no budget active there is nothing to kill
		// it, so we bound the wait with the caller-supplied AbortSignal instead
		// of waiting for a process exit that will never come.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 300);
		const result = await runSingleAgent(tempDir, makeAgent(), "do something", {
			runId: "turn-budget-settings-disabled-1",
			signal: controller.signal,
		});
		clearTimeout(timer);

		expect(result.turnBudgetExceeded).toBeUndefined();
	}, 15000);

	it("agent frontmatter turnBudget still wins over a project settings defaultTurnBudget", async () => {
		writeProjectSettings(tempDir, { defaultTurnBudget: { maxTurns: 20, graceTurns: 5 } });
		const scriptPath = writeRunawayPiBinary(tempDir, 10);
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = scriptPath;

		const result = await runSingleAgent(
			tempDir,
			makeAgent({ turnBudget: { maxTurns: 2, graceTurns: 1 } }),
			"do something",
			{ runId: "turn-budget-frontmatter-wins-1" },
		);

		// If settings' 20+5=25 had won, this run (only 10 emitted turns) would
		// never trip the backstop. It must trip at the agent's own 2+1=3.
		expect(result.turnBudgetExceeded).toBe(true);
		expect(result.error).toContain("3");
	}, 15000);
});
