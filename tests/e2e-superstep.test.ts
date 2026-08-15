import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGraphWorkflowTool } from "../extensions/graph-tool.ts";
import { trackDetached } from "./helpers/detached.ts";

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

    const tracker = trackDetached();
    const tool = createGraphWorkflowTool({ cwd, spawnAgent, ...tracker });
    await (tool as any).execute(
      "call-1",
      { script: SCRIPT, args: { task: "auth system" } },
      undefined,
      undefined,
      { cwd, model: undefined, sessionManager: undefined, modelRegistry: undefined },
    );
    // The tool detaches, so the outcome arrives on the run's own promise.
    const res: any = await tracker.settled();

    const text = res.text;
    console.log("\n=== TOOL OUTPUT ===\n" + text + "\n===================\n");
    console.log("details:", JSON.stringify({
      iterations: res.iterations,
      nodeExecutions: res.nodeExecutions,
      path: res.result.path,
    }, null, 2));
    console.log("max concurrent spawns:", maxConcurrent);

    expect(res.status).toBe("completed");
    // Every node should have succeeded, not silently failed.
    expect(text).not.toContain("[failed]");
    expect(res.iterations).toBe(3);
    expect(res.nodeExecutions).toBe(4);
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
    const runId = res.runId;
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

    const tracker = trackDetached();
    const tool = createGraphWorkflowTool({ cwd, spawnAgent, ...tracker });
    const run = async (params: any) => {
      await (tool as any).execute("c", params, undefined, undefined, {
        cwd, model: undefined, sessionManager: undefined, modelRegistry: undefined,
      });
      return tracker.settled();
    };

    // First attempt: crashes at the summarizer (round 3). A detached run
    // reports an abort in its report rather than by throwing.
    const first: any = await run({ script: SCRIPT, args: { task: "auth" } });
    const runId = /Run ID: (\S+)/.exec(first.text)?.[1];
    console.log("first attempt ran:", ran.join(", "), "| runId:", runId);
    expect(runId).toBeDefined();
    expect(ran).toEqual(["scout", "researcherA", "researcherB", "worker"]);

    // Second attempt: resume. scout + researchers must NOT re-run.
    ran.length = 0;
    failOn = null;
    const res: any = await run({ script: SCRIPT, args: { task: "auth" }, resumeRunId: runId });

    console.log("resumed run executed only:", ran.join(", "));
    console.log(res.text.split("\n")[0]);
    expect(ran).toEqual(["worker"]); // only the failed node re-ran
    expect(res.status).toBe("completed");
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("e2e: conditional routing through the real tool", () => {
  it("spawns only the branch the graph chose", async () => {
    // The headline bug, checked at the level that matters: how many agents
    // actually got spawned, not what the summary text says.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pw-cond-"));
    const spawned: string[] = [];

    const spawnAgent = (async (_cwd: string, agentDef: any) => {
      spawned.push(agentDef?.name ?? "unknown");
      return {
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        durationMs: 1,
      };
    }) as any;

    const SCRIPT = `export const meta = { name: "cond", description: "either/or" };
const g = graph();
g.node("green", agent("green", () => "implement"));
g.node("deploy", agent("worker", () => "deploy it"));
g.node("rollback", agent("reviewer", () => "roll back"));
g.edge("green", (s, r) => r.status === 'blocked' ? "rollback" : "deploy");
g.edge("deploy", END);
g.edge("rollback", END);
g.run({});`;

    const tracker = trackDetached();
    const tool = createGraphWorkflowTool({ cwd, spawnAgent, ...tracker });
    await (tool as any).execute("c", { script: SCRIPT }, undefined, undefined, {
      cwd, model: undefined, sessionManager: undefined, modelRegistry: undefined,
    });
    const res: any = await tracker.settled();

    console.log("agents actually spawned:", spawned.join(", "));
    console.log(res.text.split("\n")[0]);

    // green succeeds, so deploy runs and rollback must never spawn.
    expect(spawned).toEqual(["green", "worker"]);
    expect(spawned).not.toContain("reviewer");
    expect(res.status).toBe("completed");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("still runs a sequential graph one node per round", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pw-seq-"));
    const spawned: string[] = [];
    const spawnAgent = (async (_cwd: string, agentDef: any) => {
      spawned.push(agentDef?.name ?? "unknown");
      return {
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        durationMs: 1,
      };
    }) as any;

    const SCRIPT = `export const meta = { name: "seq", description: "plain chain" };
const g = graph();
g.node("architect", agent("architect", () => "design"));
g.node("green", agent("green", (s) => "implement " + s.architect));
g.edge("architect", "green");
g.edge("green", END);
g.run({});`;

    const tracker = trackDetached();
    const tool = createGraphWorkflowTool({ cwd, spawnAgent, ...tracker });
    await (tool as any).execute("s", { script: SCRIPT }, undefined, undefined, {
      cwd, model: undefined, sessionManager: undefined, modelRegistry: undefined,
    });
    const res: any = await tracker.settled();

    expect(spawned).toEqual(["architect", "green"]);
    // One node per round: a sequential graph is just a graph with no fan-out.
    expect(res.iterations).toBe(2);
    expect(res.nodeExecutions).toBe(2);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("e2e: staggered wave-reset resume through the real tool", () => {
  it("crashes after the first retry back-edge, resumes via resumeRunId, and still completes", async () => {
    // A fan-out/fan-in graph with two conditional retry back-edges. Track
    // "machine" retries once and resolves EARLY; track "messstelle" (behind
    // an extra hop) retries once and resolves LATE, in a different round.
    // This is the production shape the wave-reset claim fix targets: the
    // pre-fix executor deadlocked assemble here after the second reset.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pw-stagger-resume-"));
    const script = `export const meta = { name: "stagger_resume", description: "staggered reset resume" };
const g = graph();
g.node("plan", agent("planner", () => "plan"));

g.node("scout_machine", agent("scout", () => "s"));
g.node("extract_machine", agent("worker", (s) => "extract machine"));
g.node("extract_machine_retry", agent("worker", (s) => "retry machine"));
g.edge("plan", "scout_machine");
g.edge("scout_machine", "extract_machine");
g.edge("extract_machine", (s, r) => (r.status === "blocked" ? "extract_machine_retry" : "assemble"));
g.edge("extract_machine_retry", "extract_machine");

g.node("scout_client", agent("scout", () => "s"));
g.node("extract_client", agent("worker", (s) => "extract client"));
g.edge("plan", "scout_client");
g.edge("scout_client", "extract_client");
g.edge("extract_client", "assemble");

g.node("scout_messstelle", agent("scout", () => "s"));
g.node("delay1_messstelle", (s) => "d1");
g.node("extract_messstelle", agent("worker", (s) => "extract messstelle"));
g.node("extract_messstelle_retry", agent("worker", (s) => "retry messstelle"));
g.edge("plan", "scout_messstelle");
g.edge("scout_messstelle", "delay1_messstelle");
g.edge("delay1_messstelle", "extract_messstelle");
g.edge("extract_messstelle", (s, r) => (r.status === "blocked" ? "extract_messstelle_retry" : "assemble"));
g.edge("extract_messstelle_retry", "extract_messstelle");

g.node("assemble", agent("worker", (s) => "assembled: " + s.extract_machine + " | " + s.extract_client + " | " + s.extract_messstelle));
g.edge("assemble", END);
g.run({});
`;

    // Each extractor blocks (asks to retry) on its FIRST call, then succeeds.
    // extract_machine_retry / extract_messstelle_retry just echo through.
    const calls: Record<string, number> = {};
    let crashNow = false;
    const spawnAgent = (async (_cwd: string, agentDef: any, prompt: string) => {
      const name = agentDef?.name ?? "unknown";
      calls[name] = (calls[name] ?? 0) + 1;

      if (name === "worker" && /extract machine/.test(prompt) && calls["worker:machine"] === undefined) {
        calls["worker:machine"] = 1;
        return {
          exitCode: 0,
          messages: [{ role: "assistant", content: [{ type: "text", text: "STATUS: blocked\nBLOCKED_ON: data" }] }],
          durationMs: 1,
        };
      }
      if (name === "worker" && /extract messstelle/.test(prompt) && calls["worker:messstelle"] === undefined) {
        calls["worker:messstelle"] = 1;
        if (crashNow) throw new Error("boom: simulated crash right after messstelle's first (blocking) attempt");
        return {
          exitCode: 0,
          messages: [{ role: "assistant", content: [{ type: "text", text: "STATUS: blocked\nBLOCKED_ON: data" }] }],
          durationMs: 1,
        };
      }
      return {
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: `${name}-ok` }] }],
        durationMs: 1,
      };
    }) as any;

    const tracker = trackDetached();
    const tool = createGraphWorkflowTool({ cwd, spawnAgent, ...tracker });
    const run = async (params: any) => {
      await (tool as any).execute("c", params, undefined, undefined, {
        cwd, model: undefined, sessionManager: undefined, modelRegistry: undefined,
      });
      return tracker.settled();
    };

    // First attempt: crashes right when messstelle's extractor first blocks,
    // i.e. right before its retry back-edge would resolve. Machine's retry
    // has ALREADY resolved by then (fewer hops to its extractor).
    crashNow = true;
    const first: any = await run({ script, args: {} });
    const runId = /Run ID: (\S+)/.exec(first.text)?.[1];
    expect(runId).toBeDefined();
    expect(first.status).toBe("aborted");

    // Second attempt: resume. Reset the retry bookkeeping for messstelle so
    // its extractor blocks once more on resume (a real crash also loses
    // in-flight decisions), then succeeds.
    crashNow = false;
    delete calls["worker:messstelle"];
    const resumed: any = await run({ script, args: {}, resumeRunId: runId });

    // The point: assemble genuinely ran (the fan-in it deadlocked on
    // pre-fix), reached END, and the run's path shows both retry back-edges
    // resolved in different rounds before it.
    expect(resumed.status).toBe("completed");
    expect(resumed.text).toMatch(/assemble \(worker\) -> END/);
    expect(resumed.text).toMatch(/extract_machine_retry/);
    expect(resumed.text).toMatch(/extract_messstelle_retry/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
