/**
 * Compatibility tests for @gotgenes/pi-permission-system integration.
 *
 * pi-permission-system documents a specific env-var contract for
 * subagent/permission-forwarding detection (see its
 * docs/guides/permission-frontmatter-for-subagent-extensions.md and
 * docs/subagent-integration.md) that it says nicobailon/pi-subagents (the
 * package pi-workflow's subagent core was built from) satisfies:
 *
 *   - PI_SUBAGENT_CHILD=1                 -> subagent-detection env hint
 *   - PI_SUBAGENT_RUN_ID                  -> subagent-detection env hint
 *   - PI_SUBAGENT_CHILD_AGENT             -> subagent-detection env hint
 *   - PI_SUBAGENT_DEPTH                   -> subagent-detection env hint
 *   - PI_SUBAGENT_PARENT_SESSION          -> ask-forwarding target session id
 *
 * These tests pin that contract at the two layers pi-workflow controls:
 *
 *   1. buildPiArgs() (extensions/pi-args.ts) sets the env vars correctly.
 *   2. Agent discovery (extensions/agents.ts) never consumes or corrupts an
 *      agent's `permission:` frontmatter block, which is exclusively read by
 *      pi-permission-system and must pass through untouched (two-layer
 *      model: visibility vs. policy, see the guide above).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPiArgs } from "../extensions/pi-args.ts";
import { getSubagentDepthEnv } from "../extensions/types.ts";
import { discoverAgents } from "../extensions/agents.ts";
import { createGraphWorkflowTool } from "../extensions/graph-tool.ts";
import { vi } from "vitest";

describe("pi-permission-system compatibility", () => {
	describe("subagent detection + ask-forwarding env vars at spawn time", () => {
		it("sets every env var pi-permission-system's SUBAGENT_ENV_HINT_KEYS checks, plus the parent-session forwarding target", () => {
			const { env: sharedEnv } = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
				parentSessionId: "parent-session-999",
				runId: "run-777",
				childAgentName: "worker",
				childIndex: 0,
			});

			// Simulate the full env merge execution.ts performs right before spawn().
			const spawnEnv: Record<string, string | undefined> = {
				...process.env,
				...sharedEnv,
				...getSubagentDepthEnv(undefined),
			};

			// SUBAGENT_ENV_HINT_KEYS (nicobailon/pi-subagents block) that
			// pi-permission-system's isSubagentExecutionContext() checks.
			expect(spawnEnv.PI_SUBAGENT_CHILD).toBe("1");
			expect(spawnEnv.PI_SUBAGENT_RUN_ID).toBe("run-777");
			expect(spawnEnv.PI_SUBAGENT_CHILD_AGENT).toBe("worker");
			expect(spawnEnv.PI_SUBAGENT_DEPTH).toBe("1");

			// SUBAGENT_PARENT_SESSION_ENV_CANDIDATES \u2014 the ask-forwarding target.
			expect(spawnEnv.PI_SUBAGENT_PARENT_SESSION).toBe("parent-session-999");
		});

		it("increments PI_SUBAGENT_DEPTH across nested spawns (grandchild forwarding)", () => {
			const prior = process.env.PI_SUBAGENT_DEPTH;
			process.env.PI_SUBAGENT_DEPTH = "1";
			try {
				const depthEnv = getSubagentDepthEnv(undefined);
				expect(depthEnv.PI_SUBAGENT_DEPTH).toBe("2");
			} finally {
				if (prior === undefined) delete process.env.PI_SUBAGENT_DEPTH;
				else process.env.PI_SUBAGENT_DEPTH = prior;
			}
		});
	});

	describe("agent frontmatter passthrough for permission: block", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-perm-compat-"));
			fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it("discovers an agent whose frontmatter combines a subagent tools: allowlist with a pi-permission-system permission: block, without either extension's key corrupting the other", () => {
			const agentMd = `---
name: locked_down_worker
description: Worker restricted to bash and read, with bash gated by permission-system
tools: bash,read
permission:
  "*": ask
  read: allow
  bash:
    "*": ask
    "git *": allow
---

# Locked Down Worker

Test agent for permission-system compatibility.
`;
			fs.writeFileSync(path.join(tempDir, ".pi", "agents", "locked_down_worker.md"), agentMd);

			const result = discoverAgents(tempDir, "project");
			const agent = result.agents.find((a) => a.name === "locked_down_worker");
			expect(agent).toBeDefined();

			// pi-workflow's own visibility layer: tools: allowlist parsed normally.
			expect(agent!.tools).toEqual(["bash", "read"]);

			// The permission: block is not a known field to pi-workflow, so it
			// must be preserved verbatim in extraFields (as JSON, since it's an
			// object) rather than dropped or misparsed \u2014 this is what lets
			// pi-permission-system independently re-read the same .md file's
			// frontmatter and apply its own policy layer.
			expect(agent!.extraFields).toBeDefined();
			expect(agent!.extraFields!.permission).toBeDefined();
			const parsedPermission = JSON.parse(agent!.extraFields!.permission);
			expect(parsedPermission["*"]).toBe("ask");
			expect(parsedPermission.read).toBe("allow");
			expect(parsedPermission.bash["git *"]).toBe("allow");
		});

		it("agent discovery does not choke on a permission: block using surface names that collide with pi-workflow's own known fields (e.g. 'skill')", () => {
			const agentMd = `---
name: skill_gated_worker
description: Worker with a skill permission surface
skills: some-skill
permission:
  skill:
    "*": ask
---

# Skill Gated Worker
`;
			fs.writeFileSync(path.join(tempDir, ".pi", "agents", "skill_gated_worker.md"), agentMd);

			const result = discoverAgents(tempDir, "project");
			const agent = result.agents.find((a) => a.name === "skill_gated_worker");
			expect(agent).toBeDefined();
			// pi-workflow's own `skills:` field parses independently of the
			// permission: block's nested `skill` surface key.
			expect(agent!.skills).toEqual(["some-skill"]);
			expect(agent!.extraFields?.permission).toBeDefined();
		});
	});

	describe("parent session ID propagation", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-perm-prop-"));
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it("propagates parentSessionId from the extension context to spawnAgent", async () => {
			const script = `export const meta = { name: "test_prop", description: "d" };
const g = graph();
g.node("planner", agent("planner", () => "plan"));
g.edge("planner", END);
g.run();`;

			const spawnAgent = vi.fn().mockResolvedValue({
				exitCode: 0,
				messages: [],
				durationMs: 1,
			});

			const tool = createGraphWorkflowTool({
				cwd: tempDir,
				spawnAgent: spawnAgent as never,
			});

			const sessionManager = {
				getSessionId: () => "parent-session-123456",
				getSessionFile: () => "/tmp/sess.jsonl",
			};

			await (tool as any).execute("c", { script }, undefined, undefined, {
				cwd: tempDir,
				sessionManager,
				modelRegistry: undefined,
			});

			expect(spawnAgent).toHaveBeenCalled();
			const spawnOpts = spawnAgent.mock.calls[0][3];
			expect(spawnOpts.parentSessionId).toBe("parent-session-123456");
		});
	});
});
