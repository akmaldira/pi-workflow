/**
 * Post-exit stdio guard — handles process cleanup after exit.
 */

import type { ChildProcess } from "node:child_process";

export function attachPostExitStdioGuard(proc: ChildProcess): void {
	// No-op in this simplified version
}

export function trySignalChild(proc: ChildProcess, signal: string): boolean {
	try {
		proc.kill(signal as any);
		return true;
	} catch {
		return false;
	}
}
