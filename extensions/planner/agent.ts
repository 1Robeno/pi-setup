export type PlannerParams = {
	task: string;
	title?: string;
};

export const MODEL = "gpt-5.5";
export const REASONING = "high";
export const SANDBOX = "read-only";

export function buildPrompt(sessionContext: string, task: string, cwd: string): string {
	return `${sessionContext}

---

Working directory: ${cwd}

Review the session above and produce a detailed, actionable plan for:

${task}

Output a single markdown document. Include: objective, step-by-step implementation breakdown, key decisions and trade-offs, files to create or modify.
Avoid "either ... or ..." statements. Pick the recommended path based on the session context and user's preferences.`;
}
