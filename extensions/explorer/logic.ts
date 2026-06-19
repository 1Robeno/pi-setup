import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, MODEL, REASONING, SANDBOX, type ExplorerParams } from "./agent";
import { registerExplorerTool } from "./tool";

export type ExplorerResult = {
	answer: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	model: string;
	reasoning: string;
};

let activeExplorerCancel: (() => void) | undefined;

function hasActiveExplorer(): boolean {
	return Boolean(activeExplorerCancel);
}

function cancelActiveExplorer() {
	activeExplorerCancel?.();
}

function truncate(text: string, maxChars = 60_000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[Explorer output truncated: ${text.length - maxChars} characters omitted.]`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function killProcess(child: ReturnType<typeof spawn>) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		return;
	}
	child.kill("SIGTERM");
}

async function runCodexExplorer(
	params: ExplorerParams,
	cwd: string,
	signal: AbortSignal | undefined,
	onProgress: (text: string) => void,
): Promise<ExplorerResult> {
	const startedAt = Date.now();
	const tempDir = await mkdtemp(join(tmpdir(), "codex-explorer-"));
	const outputFile = join(tempDir, "last-message.md");
	const prompt = buildPrompt(params, cwd);

	const args = [
		"exec",
		"--model",
		MODEL,
		"-c",
		`model_reasoning_effort=${REASONING}`,
		"--skip-git-repo-check",
		"--sandbox",
		SANDBOX,
		"--cd",
		cwd,
		"--output-last-message",
		outputFile,
		"-",
	];

	let stdout = "";
	let stderr = "";

	try {
		const child = spawn("codex", args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		const abortExplorer = () => killProcess(child);
		activeExplorerCancel = abortExplorer;
		if (signal?.aborted) abortExplorer();
		else signal?.addEventListener("abort", abortExplorer, { once: true });

		child.stdin.write(prompt);
		child.stdin.end();

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		const progressTimer = setInterval(() => {
			onProgress(`Still exploring (${formatDuration(Date.now() - startedAt)}).`);
		}, 15_000);

		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code) => resolve(code));
		}).finally(() => {
			clearInterval(progressTimer);
			signal?.removeEventListener("abort", abortExplorer);
			if (activeExplorerCancel === abortExplorer) activeExplorerCancel = undefined;
		});

		if (signal?.aborted) {
			throw new Error("Explorer cancelled.");
		}
		if (exitCode !== 0) {
			throw new Error(`Codex exited with code ${exitCode}.\n\nSTDERR:\n${stderr}\n\nSTDOUT:\n${stdout}`);
		}

		let answer = "";
		try {
			answer = await readFile(outputFile, "utf8");
		} catch {
			answer = stdout.trim();
		}

		const finalAnswer = answer.trim() || stdout.trim() || stderr.trim() || "(explorer returned no output)";

		return {
			answer: truncate(finalAnswer),
			stdout: truncate(stdout),
			stderr: truncate(stderr),
			exitCode,
			durationMs: Date.now() - startedAt,
			model: MODEL,
			reasoning: REASONING,
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export default function explorerExtension(pi: ExtensionAPI) {
	registerExplorerTool(pi, {
		formatDuration,
		hasActiveExplorer,
		cancelActiveExplorer,
		runCodexExplorer,
	});
}
