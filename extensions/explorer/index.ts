/**
 * Explorer — read-only Codex exec agent (gpt-5.5 low reasoning) for deep codebase navigation.
 *
 * Runs in a Codex read-only sandbox to trace flows, find definitions, and map structure.
 * Never writes files. Green theme.
 *
 * Load with: `pi -e extensions/explorer`
 */
export { default } from "./logic";
