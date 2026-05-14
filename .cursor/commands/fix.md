---
description: "⚡⚡ Analyze and fix small issues [AUTO DETECT COMPLEXITY]"
argument-hint: "[issues]"
claude-legacy: .cursor/claude/commands/fix.md
cursor-agent: .cursor/agents/debugger.md
---

# Cursor command — `/fix`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/debugger.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

If there is a markdown implementation plan already, use `/code <path-to-plan>` slash command to implement it.

Else: 
- Analyze the issues and ask for more details if needed.
- Decide to use `/fix:fast` or `/fix:hard` SlashCommands based on the complexity.
- Execute Legacy Claude command (see `.cursor/commands/` equivalent): `/fix:fast <detailed-instructions-prompt>` or `/fix:hard <detailed-instructions-prompt>`
- Note: `detailed-instructions-prompt` is **an enhanced prompt** that describes the issue in detail based on the provided issue description.