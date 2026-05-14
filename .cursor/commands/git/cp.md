---
description: "Stage, commit and push all code in the current branch"
claude-legacy: .cursor/claude/commands/git/cp.md
cursor-agent: .cursor/agents/git-manager.md
---

# Cursor command — `/git cp`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/git-manager.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Use `git-manager` agent to stage all files, create a meaningful commit based on the changes and push to remote repository.