---
description: "Write creative & smart copy [FAST]"
argument-hint: "[user-request]"
claude-legacy: .cursor/claude/commands/content/fast.md
cursor-agent: .cursor/agents/copywriter.md
---

# Cursor command — `/content fast`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/copywriter.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Write creative & smart copy for this user request:
<user_request>$ARGUMENTS</user_request>

## Workflow

- If the user provides screenshots, use `ai-multimodal` skill to analyze and describe the context.
- If the user provides videos, use `ai-multimodal` (`video-analysis`) skill to analyze video content.
- Use `copywriter` agent to write the copy, then report back to main agent.