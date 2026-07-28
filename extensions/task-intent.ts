/**
 * Task intent classification — determines whether a task is likely to mutate
 * files or is read-only.
 */

export type TaskMutationIntent = "implementation" | "read-only" | "unknown";

export function classifyTaskMutationIntent(agentName: string, task: string): { kind: TaskMutationIntent; confidence: "low" | "medium" | "high" } {
	const lowerTask = task.toLowerCase();
	const lowerAgent = agentName.toLowerCase();

	// Read-only indicators
	const readOnlyPatterns = [
		"review", "analyze", "inspect", "read", "summariz", "explain", "document",
		"research", "investigate", "audit", "check", "verify", "test",
		"what", "how", "why", "list", "find", "search",
	];
	const isReadOnly = readOnlyPatterns.some((p) => lowerTask.includes(p));

	// Mutation indicators
	const mutationPatterns = [
		"implement", "create", "build", "write", "edit", "fix", "update",
		"modify", "change", "add", "remove", "delete", "refactor", "generate",
		"configure", "setup", "install", "deploy", "publish",
	];
	const isMutation = mutationPatterns.some((p) => lowerTask.includes(p));

	if (isReadOnly && !isMutation) return { kind: "read-only", confidence: "medium" };
	if (isMutation && !isReadOnly) return { kind: "implementation", confidence: "medium" };
	return { kind: "unknown", confidence: "low" };
}

export function taskMayMutate(task: string): boolean {
	const { kind } = classifyTaskMutationIntent("worker", task);
	return kind === "implementation";
}
