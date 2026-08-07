import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGraphWorkflowTool } from "../extensions/graph-tool.ts";

const SCRIPT = `export const meta = { name: "parallel_research", description: "fan out research then summarise" };
const g = graph();
g.node("scout", agent("scout", (s) => "Scout: " + s.task));
g.node("researcherA", agent("researcher", (s) => "Research A from " + s.scout));
g.node("researcherB", agent("researcher", (s) => "Research B from " + s.scout));
g.node("summarizer", agent("worker", (s) => "Summarise " + s.researcherA + " and " + s.researcherB));
g.edge("scout", "researcherA");
g.edge("scout", "researcherB");
g.edge("researcherA", "summarizer");
g.edge("researcherB", "summarizer");
g.edge("summarizer", END);
g.run({ task: args.task });
`;

describe("e2e: superstep graph through the workflow tool", () => {
  it("runs a fan-out graph in parallel rounds", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pw-e2e-"));
    const seenPrompts: Record<string, string> = {};
    const active = new Set<string>();
    let maxConcurrent = 0;

    // Real signature: spawnAgent(cwd, agent, prompt, options)
    const spawnAgent = (async (_cwd: string, agentDef: any, prompt: string) => {
      const name = agentDef?.name ?? "unknown";
      // Both researchers share one agent, so derive a distinct output from the
      // prompt to prove each branch's own result reaches the fan-in node.
      const branch = /Research (A|B) from/.exec(prompt)?.[1];
      const output = branch ? `researcher-output-${branch}` : `${name}-output`;
      const key = `${name}:${Object.keys(seenPrompts).length}`;
      seenPrompts[key] = prompt;
      active.add(key);
      maxConcurrent = Math.max(maxConcurrent, active.size);
      await new Promise((r) => setTimeout(r, 20));
      active.delete(key);
      return {
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: output }] }],
        durationMs: 20,
      };
    }) as any;

    const tool = createGraphWorkflowTool({ cwd, spawnAgent });
    const res: any = await (tool as any).execute(
      "call-1",
      { script: SCRIPT, args: { task: "auth system" } },
      undefined,
      undefined,
      { cwd, model: undefined, sessionManager: undefined, modelRegistry: undefined },
    );

    const text = res.content[0].text;
    console.log("\n=== TOOL OUTPUT ===\n" + text + "\n===================\n");
    console.log("details:", JSON.stringify({
      mode: res.details.mode,
      iterations: res.details.iterations,
      nodeExecutions: res.details.nodeExecutions,
      path: res.details.path,
    }, null, 2));
    console.log("max concurrent spawns:", maxConcurrent);

    expect(res.details.mode).toBe("superstep");
    expect(res.details.status).toBe("completed");
    // Every node should have succeeded, not silently failed.
    expect(text).not.toContain("[failed]");
    expect(res.details.iterations).toBe(3);
    expect(res.details.nodeExecutions).toBe(4);
    expect(maxConcurrent).toBe(2); // researchers actually ran concurrently
    expect(text).toContain("4 node executions across 3 rounds");

    // The summarizer's prompt must contain BOTH researcher outputs (AND fan-in):
    // proof the fan-in node waited for the whole round rather than partial data.
    const summPrompt = Object.entries(seenPrompts).find(([k]) => k.startsWith("worker"))?.[1];
    console.log("summarizer prompt:", summPrompt);
    expect(summPrompt).toBeDefined();
    expect(summPrompt).toContain("researcher-output-A");
    expect(summPrompt).toContain("researcher-output-B");

    // Journal must contain round_complete markers.
    const runId = res.details.runId;
    const journal = fs.readFileSync(path.join(cwd, ".pi-workflow/runs", runId + ".jsonl"), "utf-8");
    const rounds = journal.split("\n").filter((l) => l.includes('"round_complete"'));
    console.log("round_complete markers:", rounds.length);
    expect(rounds.length).toBe(3);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("superstep resume", () => {
  it("resumes from the last completed round and skips finished work", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pw-resume-"));
    const ran: string[] = [];
    let failOn: string | null = "summarizer";

    const spawnAgent = (async (_cwd: string, agentDef: any, prompt: string) => {
      const name = agentDef?.name ?? "unknown";
      const branch = /Research (A|B) from/.exec(prompt)?.[1];
      const output = branch ? `out-${branch}` : `${name}-out`;
      ran.push(name + (branch ?? ""));
      if (failOn && name === "worker") throw new Error("boom: summarizer crashed");
      return {
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: output }] }],
        durationMs: 1,
      };
    }) as any;

    const tool = createGraphWorkflowTool({ cwd, spawnAgent });
    const run = (params: any) =>
      (tool as any).execute("c", params, undefined, undefined, {
        cwd, model: undefined, sessionManager: undefined, modelRegistry: undefined,
      });

    // First attempt: crashes at the summarizer (round 3).
    let runId: string | undefined;
    try {
      await run({ script: SCRIPT, args: { task: "auth" } });
    } catch (e: any) {
      runId = /Run ID: (\S+)/.exec(e.message)?.[1];
    }
    console.log("first attempt ran:", ran.join(", "), "| runId:", runId);
    expect(runId).toBeDefined();
    expect(ran).toEqual(["scout", "researcherA", "researcherB", "worker"]);

    // Second attempt: resume. scout + researchers must NOT re-run.
    ran.length = 0;
    failOn = null;
    const res: any = await run({ script: SCRIPT, args: { task: "auth" }, resumeRunId: runId });

    console.log("resumed run executed only:", ran.join(", "));
    console.log(res.content[0].text.split("\n")[0]);
    expect(ran).toEqual(["worker"]); // only the failed node re-ran
    expect(res.details.status).toBe("completed");
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
