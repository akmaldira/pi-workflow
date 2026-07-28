import { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./extensions/index.ts";

async function test() {
    let subagentExecute;
    const mockPi = {
        registerTool: (tool) => {
            if (tool.name === "subagent") subagentExecute = tool.execute;
        },
        registerCommand: () => {},
        on: () => {},
    };
    
    extension(mockPi as any);
    
    console.log("Registered tool, executing...");
    
    let updates = 0;
    const result = await subagentExecute(
        "call_123",
        { 
            agentScope: "both",
            agent: "worker", 
            task: "Say hello and nothing else"
        },
        undefined,
        (update) => {
            updates++;
            console.log("Update:", update.content[0].text);
        },
        { cwd: process.cwd(), hasUI: false } as any
    );
    
    console.log("Updates received:", updates);
    console.log("Final result:", JSON.stringify(result, null, 2));
}

test().catch(console.error);
