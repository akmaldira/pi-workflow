import { runSingleAgent } from "./extensions/execution.ts";
import { discoverAgents } from "./extensions/agents.ts";

async function main() {
	const discovery = discoverAgents("/opt/workspaces/pi-workflow", "both");
	const worker = discovery.agents.find(a => a.name === "worker");
	
	try {
		const result = await runSingleAgent(
			"/tmp/weather-test",
			worker!,
			"Add a /weather route to index.js that returns 'sunny'",
			{ mode: "single", agentScope: "both" },
			undefined
		);
		console.log(JSON.stringify(result, null, 2));
	} catch (err) {
		console.error(err);
	}
}

main();
