import { spawn } from "node-pty";

const ptyProcess = spawn("pi", ["-e", "extensions/index.ts"], {
  name: "xterm-color",
  cols: 80,
  rows: 30,
  cwd: "/opt/workspaces/pi-workflow",
  env: process.env as any
});

ptyProcess.onData((data) => {
  process.stdout.write(data);
});

setTimeout(() => {
  ptyProcess.write("/subagent worker: !ls\r");
}, 2000);

setTimeout(() => {
  ptyProcess.write("\r"); // press enter to approve local agents
}, 4000);

setInterval(() => {
  ptyProcess.write("y"); // spam 'y' to approve bash/read/write
}, 1000);

setTimeout(() => {
  ptyProcess.write("\x03"); // Ctrl+C
  process.exit(0);
}, 30000);
