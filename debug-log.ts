import * as fs from "fs";
// ...
export function appendDebugLog(message: string): void {
	fs.appendFileSync("/tmp/subagent-debug.log", message + "\n");
}
