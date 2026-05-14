---
description: "⚡ Analyze the codebase and update documentation"
argument-hint: "[focused-topics] [should-scan-codebase]"
claude-legacy: .cursor/claude/commands/docs/summarize.md
cursor-agent: .cursor/agents/docs-manager.md
---

# Cursor command — `/docs summarize`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/docs-manager.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Use `docs-manager` agent to analyze the codebase based on `docs/codebase-summary.md` and respond with a summary report.

## Arguments:
$1: Focused topics (default: all)
$2: Should scan codebase (`Boolean`, default: `false`)

## Focused Topics:
<focused_topics>$1</focused_topics>

## Should Scan Codebase:
<should_scan_codebase>$2</should_scan_codebase>

## Important:
- Use `docs/` directory as the source of truth for documentation.
- Do not scan the entire codebase unless the user explicitly requests it.

**IMPORTANT**: **Do not** start implementing.