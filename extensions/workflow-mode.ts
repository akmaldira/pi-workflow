/**
 * "/workflow" command: forces the agent to delegate all work through the
 * `workflow` (and `subagent`) tools by restricting the active tool set to a
 * read-only + orchestration surface and injecting a system-prompt directive,
 * mirroring the approach the bundled `plan-mode` example extension uses for
 * its `/plan` read-only mode and the keyword-arming / prompt-injection
 * pattern in pi-dynamic-workflows' `workflow-editor.ts`
 * (`installWorkflowKeywordArming`, `buildArmedWorkflowPrompt`).
 *
 * When ON:
 *  - Active tools are restricted to: read, bash, grep, find, ls, workflow,
 *    workflow_status (plus any other currently-active non-mutating tools).
 *    `write`, `edit`, and `subagent` are removed from the active set —
 *    `subagent` is blocked too so the model can't bypass workflow's
 *    journaling/budget/error-resilience machinery by calling a single
 *    subagent directly; all delegation must go through `workflow`.
 *  - `bash` remains active, but write-shaped bash commands (redirects, `rm`,
 *    `mv`, `sed -i`, `git commit`, package installs, etc. — the same
 *    destructive-pattern list `plan-mode`'s `isSafeCommand()` uses) are
 *    blocked via a `tool_call` handler with a clear "use workflow" message.
 *  - A `before_agent_start` handler injects a non-displayed system message
 *    instructing the model to use the `workflow` tool for any work that
 *    needs file changes or delegation, and to use `read`/`bash` (read-only)
 *    only for investigation.
 *
 * When OFF: the prior active tool set is restored and no injection happens.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Tools that remain (or become) active while workflow mode is on. */
const WORKFLOW_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "workflow", "workflow_status"];

/** Tools explicitly removed from the active set while workflow mode is on. */
const WORKFLOW_MODE_DISABLED_TOOLS = new Set<string>(["write", "edit", "subagent"]);

/** Tools this feature owns when computing the restricted/restored sets. */
const WORKFLOW_MANAGED_TOOLS = new Set<string>([...WORKFLOW_MODE_TOOLS, ...WORKFLOW_MODE_DISABLED_TOOLS]);

// Reuses the same destructive-bash-pattern approach as the bundled
// plan-mode example (examples/extensions/plan-mode/utils.ts): a bash
// command is blocked in workflow mode if it matches any mutating pattern
// below, regardless of whether it also matches a "safe" read pattern.
const WRITE_BASH_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // redirect overwrite: `> file` (not `>>` handled separately, not `<`)
	/>>/, // redirect append
	/\bsed\s+-i\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|apply)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
];

/**
 * Whether a bash command mutates the filesystem/system state and should be
 * blocked while workflow mode is on. Pure-read commands (cat, grep, ls,
 * git status/log/diff, npm list, curl, etc.) are allowed through unchanged.
 */
export function isWriteBashCommand(command: string): boolean {
	return WRITE_BASH_PATTERNS.some((p) => p.test(command));
}

/** Shared, mutable view of whether workflow-only mode is currently active. */
export interface WorkflowModeState {
	enabled: boolean;
	toolsBeforeWorkflowMode?: string[];
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

/** Compute the restricted active-tool list: current tools minus disabled ones, plus the workflow-mode set. */
export function getWorkflowModeTools(activeToolNames: string[]): string[] {
	return uniqueToolNames([
		...activeToolNames.filter((name) => !WORKFLOW_MODE_DISABLED_TOOLS.has(name)),
		...WORKFLOW_MODE_TOOLS,
	]);
}

/** Compute the restored active-tool list when leaving workflow mode, given the currently active (restricted) set. */
export function getRestoredTools(activeToolNames: string[], toolsBeforeWorkflowMode: string[] | undefined): string[] {
	if (toolsBeforeWorkflowMode) return toolsBeforeWorkflowMode;
	// Fallback if we somehow don't have a saved snapshot: put back the
	// disabled tools alongside whatever's currently active (keep the
	// currently-active restricted set as-is; just re-add write/edit/subagent).
	return uniqueToolNames([...activeToolNames, ...Array.from(WORKFLOW_MODE_DISABLED_TOOLS)]);
}

/** The non-displayed system-prompt injection added to every turn while workflow mode is on. */
export const WORKFLOW_MODE_SYSTEM_DIRECTIVE = `[WORKFLOW MODE ACTIVE]
You must delegate all work through the \`workflow\` tool. Direct filesystem mutation and direct subagent
delegation are unavailable in this mode:

- \`write\` and \`edit\` are disabled — you cannot modify files directly.
- \`subagent\` is disabled — you cannot delegate to a single subagent directly.
- \`bash\` remains available for read-only investigation only (e.g. \`cat\`, \`grep\`, \`ls\`, \`git status\`,
  \`git diff\`, \`git log\`); write-shaped commands (redirects, \`rm\`, \`mv\`, \`sed -i\`, \`git commit\`, package
  installs, etc.) are blocked and will return an error telling you to use \`workflow\` instead.

For any task that requires changing files or delegating to an agent:
1. Use \`read\`/\`bash\` (read-only) first if you need to investigate the codebase.
2. Use the \`list_agents\` tool to discover available subagents and their capabilities.
3. Consult the \`pi-workflow\` skill (or load it) for complete syntax, API reference, closed escalation vocabulary (like \`contract\`, \`tests\`, \`environment\`, \`requirements\`, \`information\`, \`conflict\`), and advanced coordination patterns.
4. Write a graph script and call the \`workflow\` tool — its nodes are subagents that DO have full
   tool access (including write/edit), scoped to their own isolated run. 
   - Define nodes using:
     * \`agent(name, promptFn)\` for subagents.
     * \`human(prompt | promptFn, { options, default })\` to ask the user.
     * \`mainAgent(prompt | promptFn)\` to pause for your own judgment mid-run.
   - Route between them with \`g.edge(from, to)\` or conditional \`g.edge(from, (state, result) => target)\`.
5. Use \`workflow_status\` to inspect a run's progress or investigate a failure.

If the user's request is purely conversational or a question that needs no file changes or delegation,
just answer directly — workflow mode does not force you to call the \`workflow\` tool for every message,
only when file mutation or delegation is actually needed.`;

/**
 * Register the `/workflow` command (on/off/status toggle) and the two
 * enforcement hooks (bash write-blocking, system-prompt injection).
 *
 * `workflowToolName`/`subagentToolName` let callers pass the actual
 * registered tool names (defaults match this package's own tools) in case a
 * consumer renames them.
 */
export function registerWorkflowMode(
	pi: ExtensionAPI,
	options: { workflowToolName?: string; subagentToolName?: string } = {},
): WorkflowModeState {
	const state: WorkflowModeState = { enabled: false };

	function setMode(enabled: boolean, ctx?: ExtensionContext): void {
		if (enabled === state.enabled) return;
		state.enabled = enabled;
		if (enabled) {
			if (state.toolsBeforeWorkflowMode === undefined) {
				try {
					state.toolsBeforeWorkflowMode = pi.getActiveTools?.() ?? [];
				} catch {
					state.toolsBeforeWorkflowMode = [];
				}
			}
			try {
				pi.setActiveTools?.(getWorkflowModeTools(state.toolsBeforeWorkflowMode ?? []));
			} catch {
				// best-effort; the system-prompt injection still steers the model
			}
		} else {
			try {
				pi.setActiveTools?.(getRestoredTools(pi.getActiveTools?.() ?? [], state.toolsBeforeWorkflowMode));
			} catch {
				// ignore
			}
			state.toolsBeforeWorkflowMode = undefined;
		}
		if (ctx?.ui) updateStatus(ctx.ui);
	}

	function updateStatus(ui: ExtensionUIContext): void {
		try {
			ui.setStatus?.("workflow-mode", state.enabled ? ui.theme?.fg?.("warning", "\u2699 workflow-only") ?? "\u2699 workflow-only" : undefined);
		} catch {
			// status bar is cosmetic; ignore failures
		}
	}

	pi.registerCommand("workflow", {
		description: "Toggle workflow-only mode: blocks write/edit/subagent, forces delegation through the workflow tool. Usage: /workflow [on|off]",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "on") {
				setMode(true, ctx);
				ctx.ui.notify(
					"Workflow mode ON \u2014 write/edit/subagent are disabled; bash is read-only; use the workflow tool for any file changes or delegation. Use /workflow off to restore full access.",
					"info",
				);
				return;
			}
			if (arg === "off") {
				setMode(false, ctx);
				ctx.ui.notify("Workflow mode OFF \u2014 full tool access restored.", "info");
				return;
			}
			if (arg === "" || arg === "status") {
				ctx.ui.notify(`Workflow mode is ${state.enabled ? "ON" : "OFF"}. Usage: /workflow [on|off]`, "info");
				return;
			}
			ctx.ui.notify(`Unknown argument "${args}". Usage: /workflow [on|off]`, "warning");
		},
	});

	// Block write-shaped bash commands, and any direct write/edit/subagent
	// tool call that slips through (e.g. a stale tool reference from
	// mid-turn context) while workflow mode is on.
	const disabledToolNames = new Set<string>([
		...Array.from(WORKFLOW_MODE_DISABLED_TOOLS),
	]);
	if (options.subagentToolName) disabledToolNames.add(options.subagentToolName);

	pi.on("tool_call", async (event: { toolName: string; input: Record<string, unknown> }) => {
		if (!state.enabled) return;
		if (disabledToolNames.has(event.toolName)) {
			return {
				block: true,
				reason: `Workflow mode is active: "${event.toolName}" is disabled. Use the workflow tool to delegate this work to a subagent instead.`,
			};
		}
		if (event.toolName === "bash") {
			const command = String(event.input?.command ?? "");
			if (isWriteBashCommand(command)) {
				return {
					block: true,
					reason: `Workflow mode is active: bash is read-only (this command looks like a write/mutation). Use the workflow tool instead.\nCommand: ${command}`,
				};
			}
		}
	});

	// Inject the workflow-mode directive into the system prompt for every
	// turn while the mode is active.
	pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
		if (!state.enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${WORKFLOW_MODE_SYSTEM_DIRECTIVE}`,
		};
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx?.ui) updateStatus(ctx.ui);
	});

	return state;
}
