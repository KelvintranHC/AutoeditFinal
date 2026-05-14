---
description: "⚡⚡ Implement a feature automatically ("trust me bro")"
argument-hint: "[tasks]"
claude-legacy: .cursor/claude/commands/cook/auto.md
cursor-agent: .cursor/agents/cook.md
---

# Cursor command — `/cook auto`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/cook.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

**Ultrathink** to plan & start working on these tasks follow the Orchestration Protocol, Core Responsibilities, Subagents Team and Development Rules: 
<tasks>$ARGUMENTS</tasks>

**IMPORTANT:** Analyze the list of skills  at `.cursor/skills/*` and intelligently activate the skills that are needed for the task during the process.
**Ensure token efficiency while maintaining high quality.**

## Workflow:
1. Trigger slash command `/plan <detailed-instruction-prompt>` to create an implementation plan based on the given tasks.
2. Trigger slash command `/code <plan>` to implement the plan.
3. Finally ask user if he wants to commit to git repository, if yes trigger `/git:cm` slash command to create a commit.