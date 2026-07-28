/**
 * Long-running guard — tracks mutating tool failures and escalates to
 * needs_attention when thresholds are exceeded.
 */

export interface MutatingFailureState {
	consecutiveFailures: number;
	lastFailureTool: string | undefined;
	lastFailureTime: number;
}

export function createMutatingFailureState(): MutatingFailureState {
	return {
		consecutiveFailures: 0,
		lastFailureTool: undefined,
		lastFailureTime: 0,
	};
}

export function isMutatingTool(toolName: string): boolean {
	const mutatingTools = ["write", "edit", "bash", "create", "delete", "update", "install"];
	return mutatingTools.some((t) => toolName.toLowerCase().includes(t));
}

export function didMutatingToolFail(toolName: string, error?: string): boolean {
	return isMutatingTool(toolName) && Boolean(error);
}

export function recordMutatingFailure(state: MutatingFailureState, toolName: string): void {
	state.consecutiveFailures++;
	state.lastFailureTool = toolName;
	state.lastFailureTime = Date.now();
}

export function resetMutatingFailureState(state: MutatingFailureState): void {
	state.consecutiveFailures = 0;
	state.lastFailureTool = undefined;
	state.lastFailureTime = 0;
}

export function shouldEscalateMutatingFailures(state: MutatingFailureState, threshold: number): boolean {
	return state.consecutiveFailures >= threshold;
}

export function summarizeRecentMutatingFailures(state: MutatingFailureState): string | undefined {
	if (state.consecutiveFailures === 0) return undefined;
	return `${state.consecutiveFailures} consecutive mutating tool failures (last: ${state.lastFailureTool})`;
}

export function resolveCurrentPath(cwd: string): string {
	return cwd;
}

export function nextLongRunningTrigger(): "idle" | "completion_guard" | undefined {
	return undefined;
}
