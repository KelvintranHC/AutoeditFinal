# Claude Code commands → Cursor

Legacy slash commands live under **`.cursor/claude/commands/`**. Cursor equivalents:

- **Commands (payload + parity header):** **`.cursor/commands/**`** — same relative paths as `.cursor/claude/commands/` (54 files). Each file has YAML frontmatter: `claude-legacy`, `cursor-agent`.
- **Personas:** **`.cursor/agents/*.md`** — adopt these in-chat (Cursor does not spawn subagents via Task).

**`/cook`** is the umbrella senior-engineer entry; other commands are **standalone** or **phases** inside a Cook session. Prefer **`.cursor/agents/cook.md`** for orchestration.

## Mapping (`.cursor/claude/commands/...` → primary `.cursor/agents/`)

| Claude path | Primary agent | Notes |
|-------------|---------------|--------|
| `cook.md`, `cook/auto.md`, `cook/auto/fast.md` | `cook.md` | Full delivery pipeline |
| `bootstrap.md`, `bootstrap/auto.md`, `bootstrap/auto/fast.md` | `cook.md` | New project bootstrap |
| `plan.md`, `plan/fast.md`, `plan/hard.md`, `plan/two.md`, `plan/cro.md`, `plan/ci.md` | `planner.md` | Planning skill + `planning` |
| `fix.md`, `fix/fast.md`, `fix/hard.md`, `fix/ui.md`, `fix/types.md`, `fix/test.md`, `fix/logs.md`, `fix/ci.md` | `debugger.md` | Triage & fix |
| `scout.md` | `scout.md` | Use Grep/Glob; see agent for Cursor parity |
| `scout/ext.md` | `scout-external.md` | |
| `code.md` | `implement-from-plan.md` | Execute existing `./plans/...` |
| `test.md` | `tester.md` | Run tests, analyze |
| `debug.md` | `debugger.md` | Root cause analysis |
| `ask.md` | `architect.md` | Architecture Q&A only |
| `brainstorm.md` | `brainstormer.md` | |
| `journal.md` | `journal-writer.md` | |
| `integrate/sepay.md`, `integrate/polar.md` | `cook.md` | + `payment-integration` skill |
| `git/pr.md`, `git/cp.md`, `git/cm.md` | `git-manager.md` | |
| `docs/update.md`, `docs/summarize.md`, `docs/init.md` | `docs-manager.md` | |
| `design/*.md` | `ui-ux-designer.md` | + `frontend-design`, `ai-multimodal`, `aesthetic`, Tailwind suite (`tailwindcss`, `tailwind-design-system`, `tailwind-css-patterns`, `tailwindcss-advanced-layouts`, `tailwindcss-animations`), `ui-animation`, `brand-designer` |
| `content/*.md` | `copywriter.md` | |
| `review/codebase.md` | `code-reviewer.md` | + researcher/scout as needed |
| `use-mcp.md` | `mcp-manager.md` | + `mcp-management` skill |
| `skill/create.md`, `skill/add.md`, `skill/optimize.md`, `skill/optimize/auto.md`, `skill/fix-logs.md` | `skill-creator.md` | |
| `watzup.md` | `git-manager.md` | Branch / recent commits summary |

## Adding new commands

When you add a file under **`.cursor/claude/commands/`**, add a matching **`.cursor/commands`** path with the parity header and `cursor-agent` frontmatter, then extend this table.
