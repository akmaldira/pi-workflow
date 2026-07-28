import { spawnSync } from "child_process";

// Simulate parent session
const parentSessionId = "fake-parent-session-" + Date.now();

// Spawn a child `pi` process that attempts to run bash with the required env vars
const result = spawnSync("pi", ["-e", "extensions/index.ts", "--mode", "json", "-c", "!ls"], {
	cwd: "/opt/workspaces/pi-workflow",
	env: {
		...process.env,
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_PARENT_SESSION: parentSessionId
	},
	encoding: "utf-8",
	timeout: 10000
});

console.log("Status:", result.status);
console.log("Stdout:", result.stdout);
console.log("Stderr:", result.stderr);
