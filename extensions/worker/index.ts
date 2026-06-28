/**
 * Worker — /worker, /workercont, /workerrm, /workerclear with live widgets
 *
 * Spawns background Pi SDK worker agents (no external coding CLI). Each worker has a
 * persistent Pi session, can use coding tools plus selected utility tools, and reports
 * completion back to the main model as a follow-up message.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	DynamicBorder,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as os from "node:os";
import * as path from "node:path";
import { applyExtensionDefaults } from "../minimal/themeMap.ts";

type SubStatus = "running" | "done" | "error" | "interrupted";

interface PersistedSubState {
	id: number;
	status: SubStatus;
	task: string;
	lastText: string;
	toolCount: number;
	elapsed: number;
	sessionFile: string;
	turnCount: number;
	updatedAt: number;
	modelId?: string;
	thinkingLevel?: string;
}

type NativeAgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

interface SubState extends PersistedSubState {
	textChunks: string[];
	session?: NativeAgentSession;
}

interface Snapshot {
	version: 1;
	nextId: number;
	agents: PersistedSubState[];
}

const CUSTOM_STATE_TYPE = "native-worker-state";
const CUSTOM_RESULT_TYPE = "native-worker-result";
const WORKER_MODEL_ID = "gpt-5.5";
const WORKER_THINKING = "medium";
const COMMIT_WORKER_MODEL_ID = "gpt-5.5";
const COMMIT_WORKER_THINKING = "low";
const WORKER_EXTENSION_PATHS = [path.join(getAgentDir(), "extensions", "exa")];
const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "exa_search", "exa_code", "exa_fetch"];

const WORKER_SYSTEM_APPEND = `You are a worker background agent delegated by the main model.

Your job:
- Complete the delegated task directly in the current working directory.
- You may inspect, search, edit, write, run bash commands, and use web/code search tools when they are available.
- Keep changes scoped to the task. Prefer surgical edits and avoid broad rewrites unless requested.
- Use bash responsibly: inspect first, run relevant checks when practical, and avoid destructive commands unless explicitly necessary.
- Do not ask the user questions unless the task is impossible without clarification.
- Keep your final response concise: list files changed, checks run, and anything the main model must know.`;

const COMMIT_MESSAGE_GUIDELINES = `You write concise git commit messages.
Return a JSON object with keys: subject, body.
Rules:
- subject must be imperative, <= 72 chars, and no trailing period
- body can be empty string or short bullet points
- capture the primary user-visible or developer-visible change`;

function makeCommitTask(messageArg?: string): string {
	const providedMessage = messageArg?.trim() ?? "";

	return `Commit the current repository changes.

Provided commit message argument, if any:
\`\`\`text
${providedMessage}
\`\`\`

Behavior:
- If the provided commit message argument above is non-empty, use it as the commit message.
- If the provided commit message argument above is empty, auto-generate the commit message from the git diff.
- Always push to current branch.
- Do not make unrelated code edits.
- Do not include raw diff output in the final response.

Procedure:
1. Inspect the git state with \`git status --short --branch\`.
2. If there are no changes to commit, do not create an empty commit; report that clearly.
3. If no commit message was provided, collect commit context:
   - current branch: \`git branch --show-current\`
   - staged/working file summary as needed
   - staged diff if changes are already staged, otherwise working-tree diff
4. Stage the intended changes using the same broad behavior as a normal quick commit: \`git add -A\`.
5. If no commit message was provided, build the commit message using this prompt setup:

\`\`\`text
${COMMIT_MESSAGE_GUIDELINES}

Branch: <current branch or (detached)>

Staged files:
<git diff --cached --name-status>

Staged patch:
<git diff --no-ext-diff --cached --patch --minimal>
\`\`\`

6. Convert the generated JSON into a normal git message:
   - Use \`subject\` as the first \`-m\` argument.
   - If \`body\` is non-empty, use it as a second \`-m\` argument.
   - Sanitize the subject: single line, trimmed, no trailing period, max 72 chars.
   - If generation fails or the subject is empty, use \`Update project files\`.
7. Run \`git commit -m "$subject"\` and add \`-m "$body"\` only when the body is non-empty. If a commit message argument was provided, use that message instead.
8. Report the commit SHA and final commit message.`;
}

function makeSubagentSessionDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions", "native-workers");
}

function toPersisted(state: SubState): PersistedSubState {
	return {
		id: state.id,
		status: state.status,
		task: state.task,
		lastText: state.textChunks.join("") || state.lastText || "",
		toolCount: state.toolCount,
		elapsed: state.elapsed,
		sessionFile: state.sessionFile,
		turnCount: state.turnCount,
		updatedAt: Date.now(),
		modelId: state.modelId,
		thinkingLevel: state.thinkingLevel,
	};
}

function extractMessageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			if (part?.type === "thinking" && typeof part.thinking === "string") return part.thinking;
			return "";
		})
		.filter(Boolean)
		.join("");
}

function resolveSubagentModel(ctx: ExtensionContext, modelId = WORKER_MODEL_ID): Model<any> | undefined {
	return (
		ctx.modelRegistry.find("openai-codex", modelId) ??
		ctx.modelRegistry.find("openai", modelId) ??
		ctx.modelRegistry.getAll().find((model) => model.id === modelId)
	);
}

function restoreSnapshot(ctx: ExtensionContext): Snapshot | undefined {
	let snapshot: Snapshot | undefined;
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type === "custom" && entry.customType === CUSTOM_STATE_TYPE) {
			snapshot = entry.data as Snapshot;
		}
	}
	return snapshot?.version === 1 ? snapshot : undefined;
}

function widgetKey(id: number): string {
	return `worker-${id}`;
}

export default function (pi: ExtensionAPI) {
	const agents: Map<number, SubState> = new Map();
	let nextId = 1;
	let widgetCtx: ExtensionContext | undefined;
	let shuttingDown = false;

	function persistSnapshot() {
		try {
			const snapshot: Snapshot = {
				version: 1,
				nextId,
				agents: Array.from(agents.values()).map(toPersisted),
			};
			pi.appendEntry(CUSTOM_STATE_TYPE, snapshot);
		} catch {
			// Runtime can be stale during reload/shutdown; best-effort persistence only.
		}
	}

	function updateWidgets() {
		const ctx = widgetCtx;
		if (!ctx?.hasUI) return;

		for (const [id, state] of Array.from(agents.entries())) {
			ctx.ui.setWidget(widgetKey(id), (_tui: any, theme: any) => {
				const container = new Container();
				const borderFn = (s: string) => theme.fg("dim", s);
				const content = new Text("", 1, 0);

				container.addChild(new Text("", 0, 0));
				container.addChild(new DynamicBorder(borderFn));
				container.addChild(content);
				container.addChild(new DynamicBorder(borderFn));

				return {
					render(width: number): string[] {
						const statusColor = state.status === "running" ? "accent"
							: state.status === "done" ? "success"
							: state.status === "interrupted" ? "warning"
							: "error";
						const statusIcon = state.status === "running" ? "●"
							: state.status === "done" ? "✓"
							: state.status === "interrupted" ? "!"
							: "✗";

						const taskPreview = state.task.length > 48 ? `${state.task.slice(0, 45)}...` : state.task;
						const turnLabel = state.turnCount > 1 ? theme.fg("dim", ` · Turn ${state.turnCount}`) : "";
						const seconds = Math.round(state.elapsed / 1000);
						const header = theme.fg(statusColor, `${statusIcon} Worker #${state.id}`) +
							turnLabel +
							theme.fg("dim", `  ${taskPreview}`) +
							theme.fg("dim", `  (${seconds}s)`) +
							theme.fg("dim", ` | Tools: ${state.toolCount}`);

						const lines = [truncateToWidth(header, Math.max(1, width - 2))];
						const fullText = state.textChunks.join("") || state.lastText;
						const lastLine = fullText.split("\n").filter((line) => line.trim()).pop() || "";
						if (lastLine) lines.push(truncateToWidth(theme.fg("muted", `  ${lastLine}`), Math.max(1, width - 2)));

						content.setText(lines.join("\n"));
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
				};
			});
		}
	}

	async function stopAgent(state: SubState, status: SubStatus = "interrupted") {
		state.status = status;
		await state.session?.abort().catch(() => {});
		state.session?.dispose();
		state.session = undefined;
		state.updatedAt = Date.now();
		updateWidgets();
	}

	async function createSdkSession(state: SubState, ctx: ExtensionContext): Promise<NativeAgentSession> {
		const modelId = state.modelId ?? WORKER_MODEL_ID;
		const thinkingLevel = state.thinkingLevel ?? WORKER_THINKING;
		const model = resolveSubagentModel(ctx, modelId);
		if (!model) throw new Error(`Could not find model ${modelId}. Check Pi model configuration.`);

		const resourceLoader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			additionalExtensionPaths: WORKER_EXTENSION_PATHS,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			appendSystemPrompt: [WORKER_SYSTEM_APPEND],
		});
		await resourceLoader.reload();

		const sessionManager = state.sessionFile
			? SessionManager.open(state.sessionFile, makeSubagentSessionDir(), ctx.cwd)
			: SessionManager.create(ctx.cwd, makeSubagentSessionDir());

		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			model,
			thinkingLevel,
			authStorage: ctx.modelRegistry.authStorage,
			modelRegistry: ctx.modelRegistry,
			resourceLoader,
			tools: WORKER_TOOLS,
			sessionManager,
		});

		state.sessionFile = session.sessionFile ?? state.sessionFile;
		return session;
	}

	async function runSubagent(state: SubState, prompt: string, ctx: ExtensionContext) {
		const startTime = Date.now();
		const timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidgets();
		}, 1000);

		try {
			const session = await createSdkSession(state, ctx);
			if (!agents.has(state.id) || shuttingDown || state.status !== "running") {
				session.dispose();
				return;
			}
			if (!state.sessionFile && session.sessionFile) state.sessionFile = session.sessionFile;
			state.session = session;
			persistSnapshot();

			const unsubscribe = session.subscribe((event: any) => {
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					state.textChunks.push(event.assistantMessageEvent.delta || "");
					updateWidgets();
				} else if (event.type === "message_end" && event.message?.role === "assistant") {
					const text = extractMessageText(event.message);
					if (text) state.lastText = text;
					updateWidgets();
				} else if (event.type === "tool_execution_start") {
					state.toolCount++;
					updateWidgets();
				}
			});

			try {
				await session.prompt(prompt);
			} finally {
				unsubscribe();
			}

			if (agents.has(state.id) && !shuttingDown) {
				state.status = "done";
			}
		} catch (err) {
			if (agents.has(state.id) && !shuttingDown) {
				state.status = state.status === "interrupted" ? "interrupted" : "error";
				state.textChunks.push(`\nError: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			clearInterval(timer);
			state.elapsed = Date.now() - startTime;
			state.session?.dispose();
			state.session = undefined;
			state.lastText = state.textChunks.join("") || state.lastText;
			state.updatedAt = Date.now();
			persistSnapshot();
			updateWidgets();

			if (!shuttingDown && agents.has(state.id)) {
				const result = state.lastText || state.textChunks.join("") || "(no text response)";
				const statusLabel = state.status === "done" ? "finished" : state.status;
				ctx.ui.notify(
					`Worker #${state.id} ${statusLabel} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : state.status === "interrupted" ? "warning" : "error",
				);

				try {
					pi.sendMessage({
						customType: CUSTOM_RESULT_TYPE,
						content: `Result:\n${result.slice(0, 8000)}${result.length > 8000 ? "\n\n... [truncated]" : ""}`,
						display: true,
						details: {
							...toPersisted(state),
							statusLabel,
							prompt,
						},
					}, { deliverAs: "followUp", triggerTurn: true });
				} catch {
					// Runtime may be stale during shutdown/reload.
				}
			}
		}
	}

	function startAgent(
		task: string,
		ctx: ExtensionContext,
		existing?: SubState,
		options: { modelId?: string; thinkingLevel?: string } = {},
	): SubState {
		widgetCtx = ctx;
		const state: SubState = existing ?? {
			id: nextId++,
			status: "running",
			task,
			lastText: "",
			textChunks: [],
			toolCount: 0,
			elapsed: 0,
			sessionFile: "",
			turnCount: 1,
			updatedAt: Date.now(),
		};

		state.status = "running";
		state.task = task;
		state.lastText = "";
		state.textChunks = [];
		state.toolCount = 0;
		state.elapsed = 0;
		state.modelId = options.modelId ?? state.modelId ?? WORKER_MODEL_ID;
		state.thinkingLevel = options.thinkingLevel ?? state.thinkingLevel ?? WORKER_THINKING;
		state.updatedAt = Date.now();
		agents.set(state.id, state);
		persistSnapshot();
		updateWidgets();
		runSubagent(state, task, ctx);
		return state;
	}

	function listAgents(): string {
		if (agents.size === 0) return "No worker agents.";
		return Array.from(agents.values())
			.map((s) => `#${s.id} [${s.status.toUpperCase()}] (Turn ${s.turnCount}) - ${s.task}\n  session: ${s.sessionFile || "pending"}`)
			.join("\n");
	}

	pi.registerTool({
		name: "subagent_create",
		label: "Worker Create",
		description: "Spawn a worker subagent: a native Pi background agent for medium-to-large execution tasks. It can read, search, run bash, edit/write files, and use web/code search tools when available. Returns immediately; the result is delivered as a follow-up message.",
		promptSnippet: "Spawn a worker subagent for medium-to-large code changes, research-backed implementation, refactors, tests, or independent execution work silos",
		promptGuidelines: [
			"Use subagent_create as a worker subagent when medium-to-large code changes, refactors, migrations, test additions, research-backed implementation, or other execution work can be delegated.",
			"Call subagent_create alone; the worker result will arrive as a follow-up message when it finishes.",
			"Use subagent_create to develop independent work silos in parallel. Spawn multiple workers when tasks can be split cleanly by file, component, feature, or concern.",
			"Give each worker a complete, bounded task with target files, constraints, expected output, and verification expectations. Avoid overlapping edits across workers unless coordination is explicit.",
			"Do not use subagent_create for simple read-only investigation or tiny edits; use direct bash or explorer instead.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Complete task description for the worker" }),
		}),
		execute: async (_callId, args, _signal, _onUpdate, ctx) => {
			const state = startAgent(args.task, ctx);
			return {
				content: [{ type: "text", text: `Worker #${state.id} spawned with ${state.modelId ?? WORKER_MODEL_ID}:${state.thinkingLevel ?? WORKER_THINKING}. It can use ${WORKER_TOOLS.join(", ")}.` }],
				details: toPersisted(state),
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "subagent_continue",
		label: "Worker Continue",
		description: "Continue an existing worker conversation using its persistent session. Use this for follow-up edits, fixes, research, or review after a worker finishes. Returns immediately; the result is delivered as a follow-up message.",
		promptSnippet: "Continue an existing worker by ID for follow-up execution, edits, research, or refinement",
		promptGuidelines: [
			"Use subagent_continue to give follow-up instructions to an existing worker after it finishes, especially for fixes, refinements, or additional edits in the same work silo.",
			"Call subagent_continue alone; the worker result will arrive as a follow-up message when it finishes.",
		],
		parameters: Type.Object({
			id: Type.Number({ description: "Worker ID" }),
			prompt: Type.String({ description: "Follow-up prompt or new instructions" }),
		}),
		execute: async (_callId, args, _signal, _onUpdate, ctx) => {
			const state = agents.get(args.id);
			if (!state) return { content: [{ type: "text", text: `Error: No worker #${args.id} found.` }] };
			if (state.status === "running") return { content: [{ type: "text", text: `Error: Worker #${args.id} is still running.` }] };
			state.turnCount++;
			startAgent(args.prompt, ctx, state);
			return {
				content: [{ type: "text", text: `Worker #${args.id} continuing in background.` }],
				details: toPersisted(state),
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "subagent_remove",
		label: "Worker Remove",
		description: "Remove a worker from the widget list. If it is running, abort it first.",
		parameters: Type.Object({
			id: Type.Number({ description: "Worker ID" }),
		}),
		execute: async (_callId, args, _signal, _onUpdate, ctx) => {
			widgetCtx = ctx;
			const state = agents.get(args.id);
			if (!state) return { content: [{ type: "text", text: `Error: No worker #${args.id} found.` }] };
			if (state.status === "running") await stopAgent(state);
			ctx.ui.setWidget(widgetKey(args.id), undefined);
			agents.delete(args.id);
			persistSnapshot();
			return { content: [{ type: "text", text: `Worker #${args.id} removed.` }] };
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Worker List",
		description: "List active and finished workers with IDs, tasks, status, and session files.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: listAgents() }] }),
	});

	async function startWorkerFromCommand(args: string | undefined, ctx: ExtensionContext, command: string) {
		const task = args?.trim();
		if (!task) return ctx.ui.notify(`Usage: /${command} <task>`, "error");
		const state = startAgent(task, ctx);
		ctx.ui.notify(`Worker #${state.id} started.`, "info");
	}

	async function continueWorkerFromCommand(args: string | undefined, ctx: ExtensionContext, command: string) {
		widgetCtx = ctx;
		const trimmed = args?.trim() ?? "";
		const spaceIdx = trimmed.indexOf(" ");
		if (spaceIdx === -1) return ctx.ui.notify(`Usage: /${command} <number> <prompt>`, "error");

		const id = parseInt(trimmed.slice(0, spaceIdx), 10);
		const prompt = trimmed.slice(spaceIdx + 1).trim();
		if (Number.isNaN(id) || !prompt) return ctx.ui.notify(`Usage: /${command} <number> <prompt>`, "error");

		const state = agents.get(id);
		if (!state) return ctx.ui.notify(`No worker #${id} found.`, "error");
		if (state.status === "running") return ctx.ui.notify(`Worker #${id} is still running.`, "warning");

		state.turnCount++;
		startAgent(prompt, ctx, state);
		ctx.ui.notify(`Continuing worker #${id} (Turn ${state.turnCount}).`, "info");
	}

	async function removeWorkerFromCommand(args: string | undefined, ctx: ExtensionContext, command: string) {
		widgetCtx = ctx;
		const id = parseInt(args?.trim() ?? "", 10);
		if (Number.isNaN(id)) return ctx.ui.notify(`Usage: /${command} <number>`, "error");

		const state = agents.get(id);
		if (!state) return ctx.ui.notify(`No worker #${id} found.`, "error");
		if (state.status === "running") await stopAgent(state);
		ctx.ui.setWidget(widgetKey(id), undefined);
		agents.delete(id);
		persistSnapshot();
		ctx.ui.notify(`Worker #${id} removed.`, "info");
	}

	async function clearWorkersFromCommand(_args: string | undefined, ctx: ExtensionContext) {
		widgetCtx = ctx;
		let interrupted = 0;
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.status === "running") {
				await stopAgent(state);
				interrupted++;
			}
			ctx.ui.setWidget(widgetKey(id), undefined);
		}
		const total = agents.size;
		agents.clear();
		nextId = 1;
		persistSnapshot();
		ctx.ui.notify(
			total === 0 ? "No workers to clear." : `Cleared ${total} worker${total === 1 ? "" : "s"}${interrupted ? ` (${interrupted} interrupted)` : ""}.`,
			total === 0 ? "info" : "success",
		);
	}

	pi.registerCommand("commit", {
		description: "Commit current changes using a fresh dedicated gpt-5.5:low worker",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const state = startAgent(makeCommitTask(args), ctx, undefined, {
				modelId: COMMIT_WORKER_MODEL_ID,
				thinkingLevel: COMMIT_WORKER_THINKING,
			});
			ctx.ui.notify(`Commit worker #${state.id} started with ${COMMIT_WORKER_MODEL_ID}:${COMMIT_WORKER_THINKING}.`, "info");
		},
	});

	pi.registerCommand("worker", {
		description: "Spawn a worker with live widget: /worker <task>",
		handler: async (args, ctx) => startWorkerFromCommand(args, ctx, "worker"),
	});

	pi.registerCommand("workercont", {
		description: "Continue an existing worker: /workercont <number> <prompt>",
		handler: async (args, ctx) => continueWorkerFromCommand(args, ctx, "workercont"),
	});

	pi.registerCommand("workerrm", {
		description: "Remove a worker widget: /workerrm <number>",
		handler: async (args, ctx) => removeWorkerFromCommand(args, ctx, "workerrm"),
	});

	pi.registerCommand("workerclear", {
		description: "Clear all worker widgets",
		handler: async (args, ctx) => clearWorkersFromCommand(args, ctx),
	});

	pi.registerCommand("workers", {
		description: "List active and finished workers",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			ctx.ui.notify(listAgents(), "info");
		},
	});

	pi.registerCommand("sub", {
		description: "Alias for /worker",
		handler: async (args, ctx) => startWorkerFromCommand(args, ctx, "sub"),
	});

	pi.registerCommand("subcont", {
		description: "Alias for /workercont",
		handler: async (args, ctx) => continueWorkerFromCommand(args, ctx, "subcont"),
	});

	pi.registerCommand("subrm", {
		description: "Alias for /workerrm",
		handler: async (args, ctx) => removeWorkerFromCommand(args, ctx, "subrm"),
	});

	pi.registerCommand("subclear", {
		description: "Alias for /workerclear",
		handler: async (args, ctx) => clearWorkersFromCommand(args, ctx),
	});

	pi.registerCommand("sublist", {
		description: "Alias for /workers",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			ctx.ui.notify(listAgents(), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		widgetCtx = ctx;
		applyExtensionDefaults(import.meta.url, ctx);

		for (const [id, state] of Array.from(agents.entries())) {
			if (state.status === "running") await stopAgent(state);
			ctx.ui.setWidget(widgetKey(id), undefined);
		}
		agents.clear();
		nextId = 1;

		const snapshot = restoreSnapshot(ctx);
		if (snapshot) {
			nextId = snapshot.nextId;
			for (const item of snapshot.agents) {
				const restoredStatus = item.status === "running" ? "interrupted" : item.status;
				agents.set(item.id, {
					...item,
					status: restoredStatus,
					lastText: item.lastText || (item.status === "running" ? "Restored after restart/reload. Use /workercont to continue." : ""),
					textChunks: [],
				});
			}
			nextId = Math.max(nextId, ...Array.from(agents.keys()).map((id) => id + 1));
			updateWidgets();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		for (const [id, state] of Array.from(agents.entries())) {
			if (state.status === "running") {
				state.status = "interrupted";
				state.lastText = state.lastText || "Interrupted by session shutdown/reload. Use /workercont to continue.";
				await stopAgent(state, "interrupted");
			}
			ctx.ui.setWidget(widgetKey(id), undefined);
		}
		persistSnapshot();
	});
}
