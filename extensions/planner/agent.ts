export type PlannerParams = {
	task: string;
	title?: string;
};

export const MODEL = "gpt-5.5";
export const REASONING = "high";
export const SANDBOX = "read-only";

export function buildPrompt(sessionContext: string, task: string, cwd: string, requestedTitle?: string): string {
	const titleInstruction = requestedTitle?.trim()
		? `Use this Linear issue title unless it is clearly misleading: ${requestedTitle.trim()}`
		: "Choose a short, specific Linear issue title.";

	return `${sessionContext}

---

Working directory: ${cwd}

Review the session above and create a detailed, actionable implementation plan in Linear for:

${task}

${titleInstruction}

Use the Linear MCP server available to Codex to create exactly one Linear issue. Do not write a local plan file.

The Linear issue body must be a markdown plan with:
- Objective
- Step-by-step implementation breakdown
- Key decisions and trade-offs
- Files to create or modify
- Acceptance criteria / verification

Avoid "either ... or ..." statements. Pick the recommended path based on the session context and user's preferences.

After the Linear issue is successfully created, respond only with JSON matching the provided schema. Include the created issue identifier, title, URL, and a concise summary. Do not invent issue metadata if creation fails.`;
}
