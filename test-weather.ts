import { spawnSync } from "child_process";

const start = Date.now();
const result = spawnSync("pi", ["-e", "/opt/workspaces/pi-workflow/extensions/index.ts", "-p", "/subagent worker: Add a /weather route to index.js that returns 'sunny'"], {
	cwd: "/tmp/weather-test",
	encoding: "utf-8",
	timeout: 60000
});
const end = Date.now();

console.log("Status:", result.status);
console.log("Duration:", end - start, "ms");
console.log("Stdout:", result.stdout);
