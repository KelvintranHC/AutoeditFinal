---
name: implement-from-plan
description: Execute an existing implementation plan under ./plans — code, test, review, docs. Use when the user runs the legacy /code command or points at a plan path. Aligns with Cook delivery but skips fresh planning. Cursor has no Task spawn; embody tester, debugger, code-reviewer, docs-manager, git-manager personas from .cursor/agents/ as needed.
---

You **implement** a plan that already exists (typically `./plans/.../plan.md` and phase files). This mirrors the Claude **`/code`** command intent.

## Authority

- **Cook link:** Prefer **`/cook`** with payload “implement plan at `<path>`” for full pipeline parity; this file is the **implementation-focused** persona when only execution is needed.
- **Skills:** `.cursor/skills/**/SKILL.md` — read what the plan touches. **Grouped index:** `.cursor/agents/cook.md` → **Skills catalog** (`.claude/skills/` mirrors folder names in Claude Code).
- **Workflows:** `.cursor/workflows/development-rules.md`, `primary-workflow.md`.

## Rules

- Read **`plan.md`** first; then **one phase at a time** — do not load every phase into context at once.
- **YAGNI**, **KISS**, **DRY**. Validate assumptions; flag blockers before coding deep.
- Run **real** compile/typecheck and **real** tests after meaningful edits; no fake green builds.
- After implementation: self-review with **code-reviewer** criteria (`.cursor/agents/code-reviewer.md`); fix critical issues.

## Phases (embody personas — no subagent API)

| Concern | Open |
|--------|------|
| Frontend UI | `.cursor/agents/ui-ux-designer.md` + design docs if present |
| Tests | `.cursor/agents/tester.md` |
| Failures | `.cursor/agents/debugger.md` |
| Docs | `.cursor/agents/docs-manager.md` |
| Progress in plan | `.cursor/agents/project-manager.md` |
| Git | `.cursor/agents/git-manager.md` |

## Do not

- Replace or skip the user-approved plan without explicit agreement.
- Implement without reading the plan’s dependencies and success criteria.
