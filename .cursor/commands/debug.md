---
description: "⚡⚡ Debugging technical issues and providing solutions."
argument-hint: "[issues]"
claude-legacy: .cursor/claude/commands/debug.md
cursor-agent: .cursor/agents/debugger.md
---

# Cursor command — `/debug`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/debugger.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

 
**Reported Issues**:
 $ARGUMENTS

Use the **debugger** persona (`.cursor/agents/debugger.md`) to find the root cause of the issues, then analyze and explain the reports to the user.

**IMPORTANT**: **Do not** implement the fix automatically.
**IMPORTANT:** Analyze the skills catalog and activate the skills that are needed for the task during the process.
**IMPORTANT:** Sacrifice grammar for the sake of concision when writing outputs.