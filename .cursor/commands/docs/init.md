---
description: "⚡⚡⚡⚡ Analyze the codebase and create initial documentation"
claude-legacy: .cursor/claude/commands/docs/init.md
cursor-agent: .cursor/agents/docs-manager.md
---

# Cursor command — `/docs init`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/docs-manager.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

## Mission
Use `docs-manager` agent to analyze the codebase and create initial documentation:
- `docs/project-overview-pdr.md`: Project overview and PDR (Product Development Requirements)
- `docs/codebase-summary.md`: Codebase summary
- `docs/code-standards.md`: Codebase structure and code standards
- `docs/system-architecture.md`: System architecture
- Update `README.md` with initial documentation (keep it under 300 lines)

Use `docs/` directory as the source of truth for documentation.

**IMPORTANT**: **Do not** start implementing.