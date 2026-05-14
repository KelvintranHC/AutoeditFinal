---
description: "⚡ Analyze Github Actions logs and fix issues"
argument-hint: "[github-actions-url]"
claude-legacy: .cursor/claude/commands/fix/ci.md
cursor-agent: .cursor/agents/debugger.md
---

# Cursor command — `/fix ci`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/debugger.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

## Github Actions URL
<url>$ARGUMENTS</url>

## Workflow
1. Use **debugger** persona (`.cursor/agents/debugger.md`) to read the github actions logs, analyze and find the root causes of the issues, then report back to main agent.
2. Use **scout** persona (`.cursor/agents/scout.md`) to analyze the codebase and find the exact location of the issues, then report back to main agent.
3. Use **planner** persona (`.cursor/agents/planner.md`) to create an implementation plan based on the reports, then report back to main agent.
4. Start implementing the fix based the reports and solutions.
5. Use `tester` agent to test the fix and make sure it works, then report back to main agent.
6. Use `code-reviewer` subagent to quickly review the code changes and make sure it meets requirements, then report back to main agent.
7. If there are issues or failed tests, repeat from step 2.
8. After finishing, respond back to user with a summary of the changes and explain everything briefly, guide user to get started and suggest the next steps.

## Notes
- If `gh` command is not available, instruct the user to install and authorize GitHub CLI first.