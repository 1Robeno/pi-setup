/**
 * Planner — GPT-5.5 high-reasoning Linear plan generator.
 *
 * Reads full session context, asks Codex to create a detailed plan as a Linear
 * issue via the configured Linear MCP server. Blue theme.
 *
 * Load with: `pi -e extensions/planner`
 */
export { default } from "./logic";
