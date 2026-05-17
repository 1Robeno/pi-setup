import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExplorerParams } from "./agent";
import type { ExplorerResult } from "./logic";
import { registerExplorerUi, renderExplorerCall, renderExplorerResult, withExplorerUi } from "./widget";

const EXPLORER_PARAMS = Type.Object({
	query: Type.String({
		description: "Focused codebase question or flow to trace.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Relevant findings, errors, constraints, or hypotheses.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files or directories to prioritize.",
		}),
	),
});

type ExplorerToolDeps = {
	formatDuration: (ms: number) => string;
	hasActiveExplorer: () => boolean;
	cancelActiveExplorer: () => void;
	runCursorExplorer: (
		params: ExplorerParams,
		cwd: string,
		signal: AbortSignal | undefined,
		onProgress: (text: string) => void,
	) => Promise<ExplorerResult>;
};

export function registerExplorerTool(pi: ExtensionAPI, deps: ExplorerToolDeps) {
	registerExplorerUi(pi, deps.hasActiveExplorer, deps.cancelActiveExplorer);

	pi.registerTool({
		name: "explorer",
		label: "Explorer",
		description:
			"Read-only codebase exploration for tracing flows, multi-file reviews, definitions/usages, structure, and hidden dependencies. Best when the question spans multiple files. Returns findings to you.",
		promptSnippet:
			"Use for read-only codebase investigation across files. Ask a focused query; include paths or context when helpful.",
		promptGuidelines: [
			"Prefer explorer when the answer likely requires tracing across files or investigating non-obvious behavior.",
			"Avoid it for simple reads you can do directly or any task that needs edits.",
			"Provide a focused query; add relevant paths, errors, or prior findings.",
			"Use the findings to answer or act; do not paste the raw output to the user.",
		],
		parameters: EXPLORER_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await withExplorerUi(ctx, params.query, deps.formatDuration, async (ui) => {
				try {
					const result = await deps.runCursorExplorer(params, ctx.cwd, signal, ui.update);

					ui.finish("done", `Completed in ${deps.formatDuration(result.durationMs)}.`);
					ui.clear();

					return {
						content: [{ type: "text", text: result.answer }],
						details: { ...result, query: params.query, paths: params.paths ?? [] },
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ui.finish("error", message);
					ui.clear();
					throw new Error(`Explorer failed: ${message}`);
				}
			});
		},
		renderCall(args, theme) {
			return renderExplorerCall(args, theme);
		},
		renderResult(result, { isPartial }, theme) {
			return renderExplorerResult(result, isPartial, theme);
		},
	});
}
