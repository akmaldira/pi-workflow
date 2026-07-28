import { spawnSync } from "child_process";

const result = spawnSync("pi", ["-e", "/opt/workspaces/pi-workflow/extensions/index.ts", "-p", "/subagent worker: !env"], {
	cwd: "/opt/workspaces/pi-workflow",
	encoding: "utf-8"
});
console.log(result.stdout);
