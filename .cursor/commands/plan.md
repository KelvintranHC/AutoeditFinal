---
description: "⚡⚡⚡ Intelligent plan creation with prompt enhancement"
argument-hint: "[task]"
claude-legacy: .cursor/claude/commands/plan.md
cursor-agent: .cursor/agents/planner.md
---

# Cursor command — `/plan`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/planner.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

## Your mission
<task>
$ARGUMENTS
</task>

## Workflow
- Analyze the given task and ask for more details if needed.
- Decide to use `/plan:fast` or `/plan:hard` SlashCommands based on the complexity.
- Execute Legacy Claude command (see `.cursor/commands/` equivalent): `/plan:fast <detailed-instructions-prompt>` or `/plan:hard <detailed-instructions-prompt>`
- Activate `planning` skill.
- Note: `detailed-instructions-prompt` is **an enhanced prompt** that describes the task in detail based on the provided task description.

## Important Notes
**IMPORTANT:** Analyze the skills catalog and activate the skills that are needed for the task during the process.
**IMPORTANT:** Sacrifice grammar for the sake of concision when writing reports.
**IMPORTANT:** Ensure token efficiency while maintaining high quality.
**IMPORTANT:** In reports, list any unresolved questions at the end, if any.
**IMPORTANT**: **Do not** start implementing.
