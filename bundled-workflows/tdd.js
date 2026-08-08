export const meta = {
	name: "tdd",
	description: "Design, test, implement, and review a feature using Test-Driven Development (TDD) with automatic contract escalation.",
	whenToUse: "When implementing a new feature or function that requires clear API design, robust tests, and strict review.",
};

const g = graph();

g.node("architect", agent("architect", (s) => `Design the contract and interfaces for: ${s.task}`));
g.node("red", agent("red", (s) => `Write failing tests that encode this contract:\n${s.architect}`));
g.node("green", agent("green", (s) => `Implement the code until these tests pass:\n${s.red}\n\nContract:\n${s.architect}`));
g.node("reviewer", agent("reviewer", (s) => `Review the implementation:\n${s.green}`));

g.edge("architect", "red");
g.edge("red", "green");

g.edge("green", (state, result) => {
	if (result.status === "blocked") {
		// Route blockers to the appropriate node based on the category
		return result.blockedOn === "contract" ? "architect" : "red";
	}
	return "reviewer";
});

g.edge("reviewer", (state, result) => {
	if (result.status === "blocked") {
		return "green";
	}
	return END;
});

g.run({ task: args.task });
