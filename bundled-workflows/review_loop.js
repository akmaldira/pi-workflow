export const meta = {
	name: "review_loop",
	description: "A fast loop where a worker implements a task, a reviewer verifies it, and the worker revises if needed.",
	whenToUse: "When you want general task implementation with an independent verification and refinement loop.",
};

const g = graph();

g.node("worker", agent("worker", (s) => `Perform the following task: ${s.task}`));
g.node("reviewer", agent("reviewer", (s) => `Verify the correctness and quality of this work:\n${s.worker}`));

g.edge("worker", (state, result) => {
	if (result.status === "blocked") {
		// Environmental issues can go to human/mainAgent if available
		return "reviewer";
	}
	return "reviewer";
});

g.edge("reviewer", (state, result) => {
	if (result.status === "blocked" || (result.text && result.text.includes("REVISE"))) {
		return "worker";
	}
	return END;
});

g.run({ task: args.task });
