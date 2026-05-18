# pi-agent

Personal harness for the [Pi coding agent](https://earendil.works) — a set of extensions that plug other coding CLIs (Codex, Cursor) into Pi as callable subagents, plus UI tweaks and tool integrations I use daily.

Shared publicly as a reference. Take whatever's useful.

---

## What's here

```
extensions/
  oracle/          — Codex (gpt-5.4, xhigh reasoning) as a read-only second opinion
  explorer/        — Cursor agent (composer-2-fast) for deep codebase navigation
  planner/         — Codex (gpt-5.5, high reasoning) to write structured plans to disk
  exa/             — Web search and fetch tools via the Exa API
  minimal/         — Compact footer: context gauge + model + thinking level
settings.json      — Pi settings (provider, model, theme)
AGENTS.md          — Standing instructions injected into every session
```

---

## Extensions

### oracle

Invokes `codex` as a higher-reasoning second opinion. Runs in a read-only sandbox — it sees the code, never touches it.

Pi calls the oracle tool with a question and optional file list. Codex responds with an analysis and a machine-readable `AGENT_CONTROL` block that tells Pi whether to stop (`INFORMATION`) or continue implementing (`IMPLEMENT`).

```
Model:     gpt-5.4
Reasoning: xhigh
Sandbox:   read-only
Load with: pi -e extensions/oracle
```

### explorer

Invokes the Cursor `agent` CLI for codebase navigation tasks — tracing call stacks, finding definitions, mapping dependencies.

The explorer runs shell commands freely (`rg`, `fd`, `git log`, `git blame`, etc.) and returns dense, precise output (file paths, line numbers, quotes) back to Pi. It never writes files.

```
Model:     composer-2-fast
Sandbox:   read-only (by instruction)
Load with: pi -e extensions/explorer
```

### planner

Invokes `codex` with the full session context to produce a detailed markdown implementation plan. Writes the plan to `.docs/plans/MMDD_<name>.md` in the working directory.

```
Model:     gpt-5.5
Reasoning: high
Sandbox:   read-only
Load with: pi -e extensions/planner
```

### exa

Registers three tools backed by the [Exa API](https://exa.ai):

| Tool | Description |
|------|-------------|
| `exa_search` | General web search with highlighted excerpts |
| `exa_code` | Code-focused search (uses Exa's `exa-code` behavior) |
| `exa_fetch` | Fetch and read a URL as clean text |

Requires `EXA_API_KEY` in the environment (or exported in `~/.bashrc`).

```
Load with: pi -e extensions/exa
```

### minimal

A compact terminal footer that renders a 10-block context usage gauge, the active model ID, and the current thinking level.

```
Load with: pi -e extensions/minimal
```

## Setup

**Prerequisites**: Pi coding agent, `bun`, `codex` CLI, Cursor `agent` CLI, `EXA_API_KEY`.

Clone into `~/.pi/agent` (Pi's default agent directory):

```sh
git clone <repo-url> ~/.pi/agent
```

Load extensions at startup:

```sh
pi -e extensions/oracle -e extensions/explorer -e extensions/planner -e extensions/exa -e extensions/minimal
```

Or add them to your Pi launch alias/config.

---

## AGENTS.md

Contains standing instructions that are injected into every Pi session — preferred CLI tools (`uv`, `bun`, `vercel`, `doppler`, `neon`), code style preferences, and other conventions. Edit it to match your own workflow.
