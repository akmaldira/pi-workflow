import { parse } from "acorn";
const ast = parse("export const meta = { name: 'test', description: 'test' };", { ecmaVersion: "latest", sourceType: "module" });
console.log(JSON.stringify(ast, null, 2));
