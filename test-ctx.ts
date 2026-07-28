import { spawnSync } from "child_process";

const code = `
export default function(pi) {
  pi.registerCommand("mytest", {
    handler: async (args, ctx) => {
      console.log("ctx.session?.id =", ctx.session?.id);
    }
  });
}
`;
import fs from "fs";
fs.writeFileSync("/opt/workspaces/pi-workflow/extensions/test-ctx.ts", code);

const result = spawnSync("pi", ["-e", "/opt/workspaces/pi-workflow/extensions/test-ctx.ts", "-c", "/mytest"], {
	cwd: "/opt/workspaces/pi-workflow",
	encoding: "utf-8"
});
console.log(result.stdout);
