---
description: "Create a pull request"
argument-hint: "[branch] [from-branch]"
claude-legacy: .cursor/claude/commands/git/pr.md
cursor-agent: .cursor/agents/git-manager.md
---

# Cursor command — `/git pr`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/git-manager.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

## Variables

TO_BRANCH: $1 (defaults to `main`)
FROM_BRANCH: $2 (defaults to current branch)

## Workflow
- Use `git-manager` agent to create a pull request from {FROM_BRANCH} to {TO_BRANCH} branch.

## Notes
- If `gh` command is not available, instruct the user to install and authorize GitHub CLI first.