import { spawnSync } from "child_process";

const child = spawnSync("pi", [
	"--mode", "json",
	"-p", "Say hello to me",
	"--no-session",
	"--append-system-prompt", "/dev/null"
], {
	cwd: "/opt/workspaces/pi-workflow",
	encoding: "utf-8"
});

console.log(child.stdout);
