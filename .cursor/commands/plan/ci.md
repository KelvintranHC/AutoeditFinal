---
description: "Analyze Github Actions logs and provide a plan to fix the issues"
argument-hint: "[github-actions-url]"
claude-legacy: .cursor/claude/commands/plan/ci.md
cursor-agent: .cursor/agents/planner.md
---

# Cursor command — `/plan ci`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/planner.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Activate `planning` skill.

## Github Actions URL
 $ARGUMENTS

Use the **planner** persona (`.cursor/agents/planner.md`) to read the github actions logs, analyze and find the root causes of the issues, then provide a detailed plan for implementing the fixes.

**Output:**
Provide at least 2 implementation approaches with clear trade-offs, and explain the pros and cons of each approach, and provide a recommended approach.

**IMPORTANT:** Ask the user for confirmation before implementing.
**IMPORTANT:** Analyze the skills catalog and activate the skills that are needed for the task during the process.
**IMPORTANT:** Sacrifice grammar for the sake of concision when writing outputs.