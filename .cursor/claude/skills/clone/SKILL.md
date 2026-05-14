---
name: clone
description: Minimal fidelity-first website clone into Next.js (Tailwind installed for future use).
version: 1.1.0
---

# /clone — Minimal Clone Migration (Fidelity First)

## Intent
Clone a static website folder **as-is** into a minimal Next.js App Router project, preserving **100%** of original HTML/CSS/JS and responsive behavior.

This skill is designed to support a command like:

`/clone tôi muốn clone website này "path-source"`

Where `path-source` is a local folder path (example: `landing-pages/templatemo_570_chain_app_dev`).

## Non-negotiables
- **Fidelity first**: no redesign, no Tailwind remap, no component rewrite.
- **Tailwind**: install + keep default setup only (future usage).
- **Output naming**: folder name = `clone-<name>` where `<name>` is the **basename** of the source folder (same string as `landing-pages/<name>` when applicable).
- **Simple loader**: load the original HTML using a straightforward wrapper (iframe).
- **Basic SEO**: metadata + `robots` + `sitemap` + `manifest`.
- **Performance**: keep wrapper light; let original assets load from `public/`.

## Inputs
- Source folder: `landing-pages/<name>` (or any local path folder). Use `<name>` as the last segment of that path.

## Outputs
Create **one** project at the **repository root**:

- **`clone-<name>/`** — full Next.js source tree lives **directly inside** this folder (`package.json`, `app/`, `public/`, etc.). This is the only output; deploy from here (`vercel --prod`).

Do **not** use `minhnhatday-templates/...` or a nested `templates/...` duplicate for this workflow.

## Implementation steps (do exactly this order)
1. **Scaffold Next.js (minimal)** inside `clone-<name>/`
   - Create Next.js App Router + TypeScript + ESLint
   - Install Tailwind (default config) but **do not** rewrite styles into Tailwind

2. **Copy source**
   - Copy the entire source folder into:
     - `clone-<name>/public/<name>/...`
   - Keep all paths identical under that folder (`assets/`, `vendor/`, etc.)

3. **Load the site**
   - In `clone-<name>/app/page.tsx`, render:
     - `<iframe src="/<name>/index.html" ... />`
   - No other UI composition.

4. **SEO (basic + safe)**
   - `app/layout.tsx`: set basic `title`, `description`, basic OG/Twitter
   - `app/robots.ts`, `app/sitemap.ts`, `app/manifest.ts`

5. **Branding (minimal + safe)**
   - Only update Next.js metadata + README branding to `minhnhatday`
   - Avoid aggressive rewrites inside the source HTML/CSS/JS if it can break fidelity

6. **ESLint ignores**
   - Ensure ESLint ignores `public/<name>/**` (source files are vendor code)

7. **README (bilingual)**
   - `README.md` Vietnamese first, English second
   - Include: overview, run/build/deploy, and “fidelity 100%” note

8. **Validation**
   - From `clone-<name>/`, run: `npm run lint`, `npm run typecheck`, `npm run build`

## Done criteria
- Build passes
- Visual fidelity preserved (same HTML/CSS/JS served)
- Project path is **`clone-<name>/`** at repo root (not under `minhnhatday-templates` or `templates`)
- Deploy-ready: open `clone-<name>/`, install deps, `vercel --prod`
