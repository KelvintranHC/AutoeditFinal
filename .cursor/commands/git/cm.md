---
description: "Stage all files and create a commit."
claude-legacy: .cursor/claude/commands/git/cm.md
cursor-agent: .cursor/agents/git-manager.md
---

# Cursor command — `/git cm`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/git-manager.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Use `git-manager` agent to stage all files and create a commit.
**IMPORTANT: DO NOT push the changes to remote repository**