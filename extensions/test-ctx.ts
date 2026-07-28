import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.registerCommand("mytest", {
    description: "Test command",
    handler: async (args, ctx) => {
      console.log("PI_SUBAGENT_CHILD =", process.env.PI_SUBAGENT_CHILD);
      console.log("PI_SUBAGENT_PARENT_SESSION =", process.env.PI_SUBAGENT_PARENT_SESSION);
    }
  });
}
