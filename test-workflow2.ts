import { spawn } from "child_process";

const child = spawn("pi", ["-e", "extensions/index.ts", "-p", "/workflow .pi/workflows/example.js", "--mode", "json"], {
	cwd: "/opt/workspaces/pi-workflow",
	encoding: "utf-8"
});

child.stdout.on("data", (data) => process.stdout.write(`[STDOUT] ${data}`));
child.stderr.on("data", (data) => process.stderr.write(`[STDERR] ${data}`));
child.on("close", (code) => console.log(`Exited with code ${code}`));

setTimeout(() => {
	console.log("Timeout reached, killing child");
	child.kill();
}, 20000);
