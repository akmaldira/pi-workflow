import { spawnSync } from "child_process";

const result = spawnSync("pi", ["-e", "/opt/workspaces/pi-workflow/extensions/index.ts", "-p", "/subagent worker: Add a /weather route to index.js that returns 'sunny'", "--mode", "json"], {
	cwd: "/tmp/weather-test",
	encoding: "utf-8",
	timeout: 60000
});

console.log(result.stdout);
