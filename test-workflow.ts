import { spawnSync } from "child_process";

const result = spawnSync("pi", ["-e", "extensions/index.ts", "-p", "/workflow .pi/workflows/example.js", "--mode", "json"], {
	cwd: "/opt/workspaces/pi-workflow",
	encoding: "utf-8",
	timeout: 60000
});

console.log("Status:", result.status);
console.log("Stdout:", result.stdout);
console.log("Stderr:", result.stderr);
