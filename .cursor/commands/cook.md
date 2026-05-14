---
description: "⚡ Senior engineer mode — full skills catalog (`.cursor/skills` + `.cursor/claude/skills`) + `.cursor/workflows`; plan → implement → test → review → docs (Cook persona)."
argument-hint: "[tasks]"
claude-legacy: .cursor/claude/commands/cook.md
cursor-agent: .cursor/agents/cook.md
---

# /cook

When the user types **`/cook`** or **`/cook ...`**, activate the **Cook** senior-engineer persona:

1. Open **`.cursor/agents/cook.md`** and follow it for this turn and until the request is done.
2. Treat everything after `/cook` (or the quoted user message) as the task payload:

```text
<tasks>$ARGUMENTS</tasks>
```

If `$ARGUMENTS` is empty, ask what to build or fix **one question at a time**.

## What Cook does

- **Skills:** The **full inventory** is in **`.cursor/agents/cook.md` → “Skills catalog”** (all entries across **`.cursor/skills`** and **`.cursor/claude/skills`**, including nested `document-skills/*`). Discover on disk with **`.cursor/skills/**/SKILL.md`** and **`.cursor/claude/skills/**/SKILL.md`**. Read only what the task needs (progressive disclosure).
- **Workflows:** Obey `.cursor/workflows/` — especially `primary-workflow.md`, `orchestration-protocol.md`, `development-rules.md`, `documentation-management.md`.
- **Personas:** Adopt `.cursor/agents/*.md` (scout, researcher, planner, tester, code-reviewer, etc.) — Cursor has no Task spawn; you embody those roles yourself.
- **New apps / UI from scratch:** Follow **New apps & UI work** in `.cursor/agents/cook.md` — align with the repo’s `package.json` and docs; do not impose a specific UI toolkit or install/bootstrap unless the user asks.
- **Other slash-style workflows:** Every **`.cursor/commands/*.md`** file mirrors **`.cursor/claude/commands/**`** (Claude Code bundle) — see **`.cursor/agents/claude-commands-parity.md`**.

## Quick links

| Resource | Path |
|----------|------|
| Cook persona | `.cursor/agents/cook.md` |
| Skills catalog (grouped) | `.cursor/agents/cook.md` → **Skills catalog** |
| Claude → Cursor command map | `.cursor/agents/claude-commands-parity.md` |
| Skills | `.cursor/skills/` and `.cursor/claude/skills/` |
| Workflows | `.cursor/workflows/` |
| Agent playbooks | `.cursor/agents/` |

## Legacy Claude long-form

The full step-by-step workflow (subagent wording, extra reminders) is preserved at **`.cursor/claude/commands/cook.md`**. Prefer **`.cursor/agents/cook.md`** as the maintained Cursor source of truth.

## Claude Code note

The bundled long-form command lives at **`.cursor/claude/commands/cook.md`**; this file is the **Cursor** entry point under **`.cursor/commands/`**.
