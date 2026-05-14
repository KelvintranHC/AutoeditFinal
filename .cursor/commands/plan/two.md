---
description: "⚡⚡⚡⚡ Research & create an implementation plan with 2 approaches"
argument-hint: "[task]"
claude-legacy: .cursor/claude/commands/plan/two.md
cursor-agent: .cursor/agents/planner.md
---

# Cursor command — `/plan two`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/planner.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Think harder.
Activate `planning` skill.

## Your mission
Use the **planner** persona (`.cursor/agents/planner.md`) to create 2 detailed implementation plans for this following task:
<task>
 $ARGUMENTS
</task>

## Workflow
1. First: Create a directory named `plans/YYYYMMDD-HHmm-plan-name` (eg. `plans/20251101-1505-authentication-and-profile-implementation`).
   Make sure you pass the directory path to every persona (see `.cursor/agents/`) during the process.
2. Follow strictly to the "Plan Creation & Organization" rules of `planning` skill.
3. Use multiple `researcher` agents in parallel to research for this task, each agent research for a different aspect of the task and perform max 5 researches (max 5 tool calls).
4. Use `scout` agent to search the codebase for files needed to complete the task.
5. Main agent gathers all research and scout report filepaths, and pass them to **planner** persona (`.cursor/agents/planner.md`) with the detailed instructions prompt to create an implementation plan of this task.
  **Output:** Provide at least 2 implementation approaches with clear trade-offs, and explain the pros and cons of each approach, and provide a recommended approach.
1. Main agent receives the implementation plan from **planner** persona (`.cursor/agents/planner.md`), and ask user to review the plan

## Important Notes
**IMPORTANT:** Analyze the skills catalog and activate the skills that are needed for the task during the process.
**IMPORTANT:** Sacrifice grammar for the sake of concision when writing reports.
**IMPORTANT:** Ensure token efficiency while maintaining high quality.
**IMPORTANT:** In reports, list any unresolved questions at the end, if any.
**IMPORTANT**: **Do not** start implementing.