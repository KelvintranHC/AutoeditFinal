---
description: "Create an immersive design"
argument-hint: "[tasks]"
claude-legacy: .cursor/claude/commands/design/good.md
cursor-agent: .cursor/agents/ui-ux-designer.md
---

# Cursor command — `/design good`

## Cursor parity (no Task spawn)

- **Primary persona:** Open and follow `.cursor/agents/ui-ux-designer.md` for this command.
- **Skills / workflows:** `.cursor/skills/`, `.cursor/workflows/` (canonical; optional bundle: `.cursor/claude/`).
- **`/cook`:** This command can run **standalone** or as a **phase** inside a Cook session — see `.cursor/agents/cook.md` and `.cursor/commands/cook.md`.

---

Think hard to plan & start working on these tasks follow the Orchestration Protocol, Core Responsibilities, Subagents Team and Development Rules: 
<tasks>$ARGUMENTS</tasks>

**IMPORTANT**: Activate `aesthetic` and `frontend-design` skills.
**IMPORTANT**: Analyze the list of skills  at `.cursor/skills/*` and intelligently activate the skills that are needed for the task during the process.
**Ensure token efficiency while maintaining high quality.**

## Workflow:
1. Use **researcher** persona (`.cursor/agents/researcher.md`) to research about design style, trends, fonts, colors, border, spacing, elements' positions, etc.
2. Use `ui-ux-designer` subagent to implement the design step by step based on the research.
3. If user doesn't specify, create the design in pure HTML/CSS/JS.
4. Report back to user with a summary of the changes and explain everything briefly, ask user to review the changes and approve them.
5. If user approves the changes, update the `./docs/design-guidelines.md` docs if needed.

## Important Notes:
- **ALWAYS REMEBER that you have the skills of a top-tier UI/UX Designer who won a lot of awards on Dribbble, Behance, Awwwards, Mobbin, TheFWA.**
- Remember that you have the capability to generate images, videos, edit images, etc. with `ai-multimodal` skills for image generation. Use them to create the design with real assets.
- Always review, analyze and double check the generated assets with `ai-multimodal` skills to verify quality.
- Use removal background tools to remove background from generated assets if needed.
- Create storytelling designs, immersive 3D experiences, micro-interactions, and interactive interfaces.
- Maintain and update `./docs/design-guidelines.md` docs if needed.