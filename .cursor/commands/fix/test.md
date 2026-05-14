---
description: "⚡⚡ Run test suite and fix issues"
argument-hint: "[issues]"
claude-legacy: .cursor/claude/commands/fix/test.md
cursor-agent: .cursor/agents/debugger.md
---

# Cursor command — `/fix test`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/debugger.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Analyze the skills catalog and activate the skills that are needed for the task during the process.

## Reported Issues:
<issues>$ARGUMENTS</issues>

## Workflow:
1. Use **tester** persona (`.cursor/agents/tester.md`) to compile the code and fix all syntax errors if any.
2. Use **tester** persona (`.cursor/agents/tester.md`) to run the tests and report back to main agent.
3. If there are issues or failed tests, use **debugger** persona (`.cursor/agents/debugger.md`) to find the root cause of the issues, then report back to main agent.
4. Use **planner** persona (`.cursor/agents/planner.md`) to create an implementation plan based on the reports, then report back to main agent.
5. Use main agent to implement the plan step by step.
6. Use `tester` agent to test the fix and make sure it works, then report back to main agent.
6. Use `code-reviewer` subagent to quickly review the code changes and make sure it meets requirements, then report back to main agent.
7. If there are issues or failed tests, repeat from step 2.
8. After finishing, respond back to user with a summary of the changes and explain everything briefly, guide user to get started and suggest the next steps.
