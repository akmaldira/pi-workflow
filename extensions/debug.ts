import fs from "fs";
export function logDebug(msg: string) {
	try {
		fs.appendFileSync("/tmp/subagent-debug.log", msg + "\n");
	} catch (e) {}
}
