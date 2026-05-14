# `.cursor/` layout (AI Super Kit)

Configs are **separate** by role:

| Path | Purpose |
|------|---------|
| **`rules/*.mdc`** | Cursor always-on / scoped rules |
| **`agents/*.md`** | Personas for in-chat adoption (**Cook**, planner, scout, …) — no Task spawn |
| **`commands/*.md`** | Cursor-oriented slash-style prompts; parity headers + `cursor-agent` frontmatter |
| **`skills/**`** | **Canonical** skill tree — edit here for active development |
| **`workflows/*.md`** | Shared engineering workflows |
| **`claude/**`** | **Full Claude Code bundle** copied from legacy `.claude/` (commands, agents, hooks, scripts, skills mirror, settings). Safe reference if you **delete repo-root `.claude/`** |
| **`mcp.json.example`** | MCP template at `.cursor/` root (prefer **`mcp.json`** in-repo for Cursor) |

**Orchestration:** **`/cook`** → `.cursor/commands/cook.md` → `.cursor/agents/cook.md`.

**Mapping:** `.cursor/agents/claude-commands-parity.md` lists Claude-style commands → primary agent.
