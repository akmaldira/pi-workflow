/**
 * Completion guard — evaluates whether a subagent's output indicates completion.
 */

export function evaluateCompletionMutationGuard(output: string): { completed: boolean; confidence: "low" | "medium" | "high" } {
	const lower = output.toLowerCase();
	const completionIndicators = [
		"done",
		"complete",
		"finished",
		"task complete",
		"all done",
		"completed successfully",
	];
	const hasCompletion = completionIndicators.some((indicator) => lower.includes(indicator));
	return {
		completed: hasCompletion,
		confidence: hasCompletion ? "medium" : "low",
	};
}
