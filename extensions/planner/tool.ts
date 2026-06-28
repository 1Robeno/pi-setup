import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlannerResult } from "./logic";
import { registerPlannerUi, renderPlannerCall, renderPlannerResult, withPlannerUi } from "./widget";

const PLANNER_PARAMS = Type.Object({
	task: Type.String({
		description: "Planning request with goal, scope, constraints, and any important files.",
	}),
	title: Type.Optional(Type.String({
		description: "Short, subject-specific Linear issue title, e.g. 'Auth migration plan' or 'Dashboard redesign plan'.",
	})),
});

type PlannerToolDeps = {
	formatDuration: (ms: number) => string;
	hasActivePlanner: () => boolean;
	cancelActivePlanner: () => void;
	runCodexPlanner: (
		sessionContext: string,
		task: string,
		issueTitle: string | undefined,
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (text: string) => void,
	) => Promise<PlannerResult>;
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object" || !("type" in block)) return "";
			if (block.type === "text" && "text" in block && typeof block.text === "string") return block.text;
			if (block.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function serializeSession(ctx: any): string {
	const branch: any[] = (ctx as any).sessionManager?.getBranch?.() ?? [];
	const messages = branch
		.filter((e) => e.type === "message")
		.map((e) => e.message)
		.filter((m) => m.role === "user" || m.role === "assistant");

	return messages
		.map((m) => {
			const content = textFromContent(m.content).trim();
			return `${m.role.toUpperCase()}:\n${content}`;
		})
		.filter((s) => !s.endsWith(":\n"))
		.join("\n\n---\n\n");
}

export function registerPlannerTool(pi: ExtensionAPI, deps: PlannerToolDeps) {
	registerPlannerUi(pi, deps.hasActivePlanner, deps.cancelActivePlanner);

	pi.registerTool({
		name: "planner",
		label: "Planner",
		description:
			"Create an implementation plan as a Linear issue through Codex's Linear MCP. Reads the current session automatically. Use when the user wants a written plan, design doc, or architecture breakdown.",
		promptSnippet:
			"Create a Linear issue plan from the current session. Pass the goal, scope, constraints, important files, and a short subject-specific issue title.",
		promptGuidelines: [
			"Use planner when the plan itself is the deliverable.",
			"Pass a focused task with the goal, scope, constraints, important files, title for the Linear issue, e.g. 'Auth migration plan' or 'Dashboard redesign plan'.",
			"Do not repeat session history; full session context is read automatically.",
		],
		parameters: PLANNER_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await withPlannerUi(ctx, params.task, deps.formatDuration, async (ui) => {
				try {
					const sessionContext = serializeSession(ctx);

					const result = await deps.runCodexPlanner(
						sessionContext,
						params.task,
						params.title,
						ctx.cwd,
						signal,
						ui.update,
					);

					ui.finish("done", `Created ${result.issueIdentifier}`);
					ui.clear();

					return {
						content: [{ type: "text", text: `Plan created in Linear:\n${result.answer}` }],
						details: { ...result },
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ui.finish("error", message);
					ui.clear();
					throw new Error(`Planner failed: ${message}`);
				}
			});
		},
		renderCall(args, theme) {
			return renderPlannerCall(args, theme);
		},
		renderResult(result, { isPartial }, theme) {
			return renderPlannerResult(result, isPartial, theme);
		},
	});
}
