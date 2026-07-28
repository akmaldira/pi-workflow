import { buildPiArgs } from "./extensions/pi-args.ts";
import { discoverAgents } from "./extensions/agents.ts";

const discovery = discoverAgents("/opt/workspaces/pi-workflow", "both");
const worker = discovery.agents.find(a => a.name === "worker");

if (!worker) throw new Error("Worker agent not found");

const args = buildPiArgs({
	baseArgs: ["--mode", "json", "-p"],
	task: "Add weather route",
	model: worker.model,
	tools: worker.tools,
	extensions: worker.extensions,
	noExtensions: worker.subagentOnlyExtensions !== undefined,
	skills: worker.skills,
	noSkills: worker.skills !== undefined,
	systemPrompt: worker.systemPrompt,
	systemPromptMode: worker.systemPromptMode,
	inheritProjectContext: worker.inheritProjectContext ?? true,
	inheritSkills: worker.inheritSkills ?? true,
	sessionEnabled: false,
});

console.log(args.args.join(" "));
