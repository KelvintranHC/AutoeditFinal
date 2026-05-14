---
description: "⚡ Use external agentic tools to scout given directories"
argument-hint: "[user-prompt] [scale]"
claude-legacy: .cursor/claude/commands/scout/ext.md
cursor-agent: .cursor/agents/scout-external.md
---

# Cursor command — `/scout ext`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/scout-external.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

## Purpose

Utilize external agentic tools to scout given directories or explore the codebase for files needed to complete the task using a fast, token efficient agent.

## Variables

USER_PROMPT: $1
SCALE: $2 (defaults to 3)
RELEVANT_FILE_OUTPUT_DIR: `plans/<plan-name>/reports/`

## Workflow (Cursor — no Task spawn)

- Open **`.cursor/agents/scout-external.md`** and follow it.
- **Optional external CLIs:** If `gemini` / `opencode` (or similar) are installed, you may run **parallel** terminal invocations with scoped prompts and merge paths — only when the user approves shell use.
- **Fallback (default in Cursor):** Use **Grep**, **Glob**, **Read**, and semantic search across divided directory scopes in parallel — same outcome as “external scout,” without assuming Task/Bash-only orchestration.
- Keep searches **shallow** (paths + relevance); avoid reading entire large files unless necessary.
- **IMPORTANT:** Sacrifice grammar for the sake of concision when writing reports.
- **IMPORTANT:** In reports, list any unresolved questions at the end, if any.