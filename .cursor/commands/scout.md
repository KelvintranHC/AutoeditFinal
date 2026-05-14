---
description: "⚡⚡ Scout given directories to respond to the user's requests"
argument-hint: "[user-prompt] [scale]"
claude-legacy: .cursor/claude/commands/scout.md
cursor-agent: .cursor/agents/scout.md
---

# Cursor command — `/scout`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/scout.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

## Purpose

Search the codebase for files needed to complete the task using a fast, token efficient agent.

## Variables

USER_PROMPT: $1
SCALE: $2 (defaults to 3)
REPORT_OUTPUT_DIR: `plans/<plan-name>/reports/scout-report.md`

## Workflow (Cursor — no Task spawn)

- Open **`.cursor/agents/scout.md`** and follow it. Use **Grep**, **Glob**, **Read**, and semantic search in **parallel** (multiple directory scopes) instead of spawning subagents.
- Divide the repo into logical sections; run up to `SCALE` focused searches; merge file paths and dedupe.
- Keep each search pass **fast and shallow** — file paths and one-line relevance, not full-file reads unless needed.

**How to write reports:**

- **IMPORTANT:** Sacrifice grammar for the sake of concision when writing reports.
- **IMPORTANT:** In reports, list any unresolved questions at the end, if any.