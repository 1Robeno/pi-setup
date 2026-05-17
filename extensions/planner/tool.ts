import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlannerResult } from "./logic";
import { registerPlannerUi, renderPlannerCall, renderPlannerResult, withPlannerUi } from "./widget";

const PLANNER_PARAMS = Type.Object({
	task: Type.String({
		description: "Planning request with goal, scope, constraints, and any important files.",
	}),
});

type PlannerToolDeps = {
	formatDuration: (ms: number) => string;
	hasActivePlanner: () => boolean;
	cancelActivePlanner: () => void;
	runCodexPlanner: (
		sessionContext: string,
		task: string,
		planPath: string,
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

function generatePlanPath(task: string): string {
	const now = new Date();
	const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 35);
	return `.docs/plans/${mmdd}_${slug}.md`;
}

export function registerPlannerTool(pi: ExtensionAPI, deps: PlannerToolDeps) {
	registerPlannerUi(pi, deps.hasActivePlanner, deps.cancelActivePlanner);

	pi.registerTool({
		name: "planner",
		label: "Planner",
		description:
			"Write a markdown implementation plan to `.docs/plans/`. Reads the current session automatically. Use when the user wants a written plan, design doc, or architecture breakdown.",
		promptSnippet:
			"Create a markdown plan from the current session. Pass the goal, scope, constraints, and any important files.",
		promptGuidelines: [
			"Use planner when the plan itself is the deliverable.",
			"Pass a focused task with the goal, scope, constraints, and any important files.",
			"Do not repeat session history; full session context is read automatically.",
		],
		parameters: PLANNER_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await withPlannerUi(ctx, params.task, deps.formatDuration, async (ui) => {
				try {
					const sessionContext = serializeSession(ctx);
					const planPath = generatePlanPath(params.task);

					const result = await deps.runCodexPlanner(
						sessionContext,
						params.task,
						planPath,
						ctx.cwd,
						signal,
						ui.update,
					);

					ui.finish("done", `Saved to ${result.planPath}`);
					ui.clear();

					return {
						content: [{ type: "text", text: `Plan saved to ${result.planPath}\n\n${result.answer}` }],
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
