import { spawnSync } from "child_process";

const result = spawnSync("pi", ["-e", "/opt/workspaces/pi-workflow/extensions/index.ts", "-p", "/subagent worker: Execute the bash command `node -e 'console.log(process.env.PI_SUBAGENT_PARENT_SESSION)'` and print the exact result"], {
	cwd: "/opt/workspaces/pi-workflow",
	encoding: "utf-8"
});
console.log(result.stdout);
