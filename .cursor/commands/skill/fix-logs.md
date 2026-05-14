---
description: "Fix the agent skill based on `logs.txt` file."
argument-hint: "[prompt-or-path-to-skill]"
claude-legacy: .cursor/claude/commands/skill/fix-logs.md
cursor-agent: .cursor/agents/skill-creator.md
---

# Cursor command — `/skill fix-logs`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/skill-creator.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Think harder.
Use `skill-creator` and `claude-code` skills.
Use `docs-seeker` skills to search for documentation if needed.

## Your mission
Fix the agent skill based on the current `logs.txt` file (in the project root directory).

## Requirements
<user-prompt>$ARGUMENTS</user-prompt>

## Rules of Skill Fixing:
Base on the requirements:
- If you're given an URL, it's documentation page, use **Explorer** persona (`.cursor/agents/scout-external.md`) to explore every internal link and report back to main agent, don't skip any link.
- If you receive a lot of URLs, use multiple **Explorer** persona (see `.cursor/agents/scout-external.md`) to explore them in parallel, then report back to main agent.
- If you receive a lot of files, use multiple **Explorer** persona (see `.cursor/agents/scout-external.md`) to explore them in parallel, then report back to main agent.
- If you're given a Github URL, use [`repomix`](https://repomix.com/guide/usage) command to summarize ([install it](https://repomix.com/guide/installation) if needed) and spawn multiple **Explorer** persona (see `.cursor/agents/scout-external.md`) to explore it in parallel, then report back to main agent.