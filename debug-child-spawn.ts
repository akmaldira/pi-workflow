/**
 * Debug: log every stdout event line from the child, plus exit code, to see
 * exactly what the child emits when it fails with "require is not defined".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSingleAgent } from "/opt/workspaces/pi-workflow/extensions/execution.ts";
import { discoverAgents } from "/opt/workspaces/pi-workflow/extensions/agents.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ns-debug5-"));
const { agents } = discoverAgents(cwd, "both");
const scout = agents.find((a) => a.name === "scout")!;

const result = await runSingleAgent(cwd, scout, "reply with exactly: done", {
	runId: "debug-5",
	index: 1,
	sessionFile: path.join(cwd, ".pi-workflow", "sessions", "debug-5", "scout.jsonl"),
	extraEnv: {
		PI_WORKFLOW_NODE_ID: "extractor",
		PI_WORKFLOW_CHANNEL_DIR: "/tmp/ns-debug5-channel",
		PI_WORKFLOW_RUN_ID: "debug-5",
	},
	onEvent: (event) => {
		const t = (event as { type?: string }).type;
		if (t === "error" || t === "agent_end" || t === "turn_end") {
			console.log("[event]", JSON.stringify(event).slice(0, 500));
		}
	},
});

console.log("[debug] exitCode:", result.exitCode);
console.log("[debug] stopReason:", result.stopReason);
console.log("[debug] error:", result.error);
console.log("[debug] errorMessage:", result.errorMessage);
console.log("[debug] messages:", JSON.stringify(result.messages ?? []).slice(0, 500));
process.exit(0);
