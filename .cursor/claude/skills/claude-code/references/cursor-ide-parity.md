# Cursor IDE parity (vs Claude Code)

This repo keeps **Cursor** config under **`.cursor/`** and a **full Claude Code bundle** under **`.cursor/claude/`** (commands, agents, hooks, scripts, skills mirror). You can remove a repo-root **`.claude/`** directory once you rely on **`.cursor/claude/`**.

| Concern | Claude Code (bundled) | Cursor (this repo) |
|--------|------------------------|---------------------|
| Agent instructions | `.cursor/claude/agents/` | `.cursor/agents/` — Cook + parity personas; adopt in-chat (no Task spawn) |
| Skills (active) | use `.cursor/skills/` | `.cursor/skills/**/SKILL.md` — single canonical tree |
| Skills (bundle copy) | `.cursor/claude/skills/` | Optional duplicate inside bundle; prefer `.cursor/skills/` for edits |
| Workflows | `.cursor/workflows/` | Same files — shared |
| Subagent spawn | Task tool | **No Task** — read `.cursor/agents/<role>.md` and execute that role |
| Slash commands | `.cursor/claude/commands/` | Cursor-oriented wrappers in `.cursor/commands/` (parity headers + `cursor-agent`) |
| Rules / always-on | Hooks + `settings.json` in bundle | `.cursor/rules/*.mdc` |
| MCP config | `.cursor/claude/.mcp.json` | Prefer **`.cursor/mcp.json`**; fallback to bundle path (see `mcp-management` skill) |

The **`claude-code`** skill upstream docs that mention **Anthropic’s** default `~/.claude` or `.claude/` layout are **product documentation**; in this repo, resolve paths to **`.cursor/`** as in the table above.
