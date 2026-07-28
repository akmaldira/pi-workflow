import fs from "fs";
import path from "path";

const root = path.join(process.env.HOME || "", ".pi/agent/extensions/pi-permission-system/sessions");
console.log(fs.existsSync(root));
if (fs.existsSync(root)) {
	console.log(fs.readdirSync(root));
}
