import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyExtensionDefaults } from "../minimal/themeMap.ts";

type DirectorMode = "off" | "advisory" | "strict";

const CUSTOM_STATE_TYPE = "director-state";
const DIRECTOR_MODEL_ID = "gpt-5.5";
const DIRECTOR_THINKING = "high";
const STRICT_TOOLS = [
	"bash",
	"explorer",
	"planner",
	"oracle",
	"subagent_create",
	"subagent_continue",
	"subagent_list",
	"subagent_remove",
	"linear_viewer",
	"linear_teams",
	"linear_search_issues",
	"linear_list_issues",
	"linear_get_issue",
	"linear_create_issue",
	"linear_update_issue",
	"linear_add_comment",
	"linear_graphql",
];

function explicitDirectorLaunch(): boolean {
	const args = process.argv;
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] !== "-e" && args[i] !== "--extension") continue;
		const value = args[i + 1]?.replace(/\\/g, "/") ?? "";
		if (/\/director(?:\/index\.ts|\/)?$/.test(value) || /\/director\.ts$/.test(value) || value === "director") {
			return true;
		}
	}
	return false;
}

function restoreMode(ctx: ExtensionContext): DirectorMode | undefined {
	let mode: DirectorMode | undefined;
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_STATE_TYPE) continue;
		const value = entry.data?.mode;
		if (value === "off" || value === "advisory" || value === "strict") mode = value;
	}
	return mode;
}

function validMode(value: string | undefined): DirectorMode | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "off" || normalized === "advisory" || normalized === "strict") return normalized;
	return undefined;
}

function buildDirectorPrompt(mode: DirectorMode): string {
	const strictLine = mode === "strict"
		? "- Strict mode is active: your only direct built-in tool is bash. Do not attempt direct read/edit/write work."
		: "- Advisory mode is active: you may work directly when truly small, but prefer delegation for execution.";

	return `## Director mode (${mode})

You are the main director/verifier agent. Your job is to decide, delegate, synthesize, and verify. Execution should flow through the specialist surfaces available to you.

Rules:
${strictLine}
- Use bash only for lightweight flexibility: repo status, quick inspection, test/check commands, and other small terminal tasks.
- Use explorer for read-only codebase tracing, non-obvious dependencies, multi-file investigation, and architecture lookup.
- Use planner when a written plan/design doc is itself the deliverable.
- Use worker subagents via subagent_create/subagent_continue for implementation, refactors, tests, research-backed changes, and independent work silos.
- Use Linear tools for issue/project/status work, including Linear lookup, comments, and explicit user-requested issue updates.
- Use oracle for complex debugging, subtle logic review, architecture decisions, or high-risk verification.
- After worker results, verify before final response. Prefer bash checks/tests, explorer inspection, or oracle review depending on risk.
- Keep task delegation bounded: include target files, constraints, expected result, and verification expectations.
- Keep final responses concise and separate verified facts from follow-up recommendations.`;
}

export default function directorExtension(pi: ExtensionAPI) {
	let mode: DirectorMode = "off";
	let normalTools: string[] | undefined;
	let lastCtx: ExtensionContext | undefined;

	pi.registerFlag("director", {
		description: "Start in director mode (strict verifier/delegator mode)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("director-mode", {
		description: "Director mode to start with: strict, advisory, or off",
		type: "string",
	});

	function availableStrictTools(): string[] {
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		return STRICT_TOOLS.filter((tool) => available.has(tool));
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (mode === "off") {
			ctx.ui.setStatus("director", undefined);
			return;
		}
		const color = mode === "strict" ? "accent" : "warning";
		ctx.ui.setStatus("director", ctx.ui.theme.fg(color, `director:${mode}`));
	}

	async function applyDirectorModel(ctx: ExtensionContext) {
		if (mode === "off") return;
		const model =
			ctx.modelRegistry.find("openai-codex", DIRECTOR_MODEL_ID) ??
			ctx.modelRegistry.find("openai", DIRECTOR_MODEL_ID) ??
			ctx.modelRegistry.getAll().find((candidate) => candidate.id === DIRECTOR_MODEL_ID);
		if (model) await pi.setModel(model);
		pi.setThinkingLevel(DIRECTOR_THINKING);
	}

	async function setMode(nextMode: DirectorMode, ctx: ExtensionContext, options: { persist?: boolean; notify?: boolean } = {}) {
		lastCtx = ctx;
		if (mode !== "strict" && nextMode === "strict") normalTools = pi.getActiveTools();
		mode = nextMode;

		if (mode === "strict") {
			const tools = availableStrictTools();
			pi.setActiveTools(tools);
		} else if (normalTools) {
			pi.setActiveTools(normalTools);
			normalTools = undefined;
		}

		await applyDirectorModel(ctx);
		updateStatus(ctx);

		if (options.persist !== false) pi.appendEntry(CUSTOM_STATE_TYPE, { mode });
		if (options.notify && ctx.hasUI) {
			const tools = mode === "strict" ? `\nTools: ${availableStrictTools().join(", ")}` : "";
			ctx.ui.notify(`Director mode: ${mode}${tools}`, mode === "off" ? "info" : "success");
		}
	}

	pi.registerCommand("director", {
		description: "Set director mode: /director strict|advisory|off",
		handler: async (args, ctx) => {
			const requested = validMode(args);
			if (requested) {
				await setMode(requested, ctx, { notify: true });
				return;
			}

			const choice = await ctx.ui.select("Director mode", [
				"strict — delegate execution; main gets bash + specialist tools",
				"advisory — prefer delegation but keep current tools",
				"off — restore normal tools",
			]);
			if (!choice) return;
			await setMode(choice.startsWith("strict") ? "strict" : choice.startsWith("advisory") ? "advisory" : "off", ctx, {
				notify: true,
			});
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (mode === "off") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildDirectorPrompt(mode)}` };
	});

	pi.on("tool_call", async (event) => {
		if (mode !== "strict") return;
		if (STRICT_TOOLS.includes(event.toolName)) return;
		return {
			block: true,
			reason: `Director strict mode blocks direct tool "${event.toolName}". Use bash for lightweight checks or delegate through explorer/planner/oracle/worker.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		applyExtensionDefaults(import.meta.url, ctx);
		normalTools = pi.getActiveTools();

		const flagMode = validMode(pi.getFlag("director-mode") as string | undefined);
		const shouldStartStrict = pi.getFlag("director") === true || explicitDirectorLaunch();
		const restored = restoreMode(ctx);
		const initialMode = flagMode ?? (shouldStartStrict ? "strict" : restored ?? "off");
		await setMode(initialMode, ctx, { persist: false });
	});

	pi.on("session_shutdown", async () => {
		if (lastCtx?.hasUI) lastCtx.ui.setStatus("director", undefined);
	});
}
