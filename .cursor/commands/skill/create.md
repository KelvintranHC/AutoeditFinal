---
description: "Create a new agent skill"
argument-hint: "[prompt-or-llms-or-github-url]"
claude-legacy: .cursor/claude/commands/skill/create.md
cursor-agent: .cursor/agents/skill-creator.md
---

# Cursor command — `/skill create`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/skill-creator.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Ultrathink.
Use `skill-creator` and `claude-code` skills.
Use `docs-seeker` skills to search for documentation if needed.

## Your mission
Create a new skill in `.cursor/skills/` directory.

## Requirements
<user-prompt>$ARGUMENTS</user-prompt>

## Rules of Skill Creation:
Base on the requirements:
- Always keep in mind that `SKILL.md` and reference files should be token consumption efficient, so that **progressive disclosure** can be leveraged at best.
- `SKILL.md` is always short and concise, straight to the point, treat it as a quick reference guide.
- If you're given an URL, it's documentation page, use **Explore** persona (`.cursor/agents/scout-external.md`) to explore every internal link and report back to main agent, don't skip any link.
- If you receive a lot of URLs, use multiple **Explore** persona (see `.cursor/agents/scout-external.md`) to explore them in parallel, then report back to main agent.
- If you receive a lot of files, use multiple **Explore** persona (see `.cursor/agents/scout-external.md`) to explore them in parallel, then report back to main agent.
- If you're given a Github URL, use [`repomix`](https://repomix.com/guide/usage) command to summarize ([install it](https://repomix.com/guide/installation) if needed) and spawn multiple **Explore** persona (see `.cursor/agents/scout-external.md`) to explore it in parallel, then report back to main agent.

**IMPORTANT:**
- Skills are not documentation, they are practical instructions for Claude Code to use the tools, packages, plugins or APIs to achieve the tasks.
- Each skill teaches Claude how to perform a specific development task, not what a tool does.
- Claude Code can activate multiple skills automatically to achieve the user's request.