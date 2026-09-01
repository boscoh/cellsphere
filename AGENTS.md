# AGENT.md - Development Guide

Follow these instructions precisely for all sessions.

## Project Overview

"Cell" is a Vue 3 + Three.js interactive visualization: a glowing circle that
circumscribes a swarm of softly colliding, floating cells drifting in a
viscosity-controlled simulation.

- **Framework**: Vue 3 with Vite, `<script setup>` SFCs
- **Rendering**: Three.js (WebGLRenderer, OrbitControls from `three/addons`)
- **Physics**: custom velocity-based particle model (soft spring collisions, ring-wall bounces)

## Project Structure

- `src/App.vue` — Three.js scene, physics loop, and overlay UI (all in one file)
- `src/main.js` — app bootstrap
- `src/style.css` — global reset / base styles
- `index.html` — entry HTML

## Commands

- **Dev**: `npm run dev` — Start dev server (http://localhost:5173)
- **Build**: `npm run build` — Production build to `dist/`
- **Preview**: `npm run preview` — Preview production build

## Beads Workflow (MANDATORY)

This project uses [Beads](https://github.com/steveyegge/beads) for issue tracking.
**Use `bd` commands instead of markdown TODOs.**

### Session Start
1. Run `bd ready` to list unblocked issues
2. Select highest-priority matching issue
3. Claim it: `bd update <id> --status=in_progress`

### During Work
- Create issues: `bd create --title="..." --type=task --priority=2`
- Update progress: `bd update <id> --note="Progress..."`
- Add dependencies: `bd dep add <child> <blocks>`
- Types: task, bug, feature, epic, question, docs
- Priorities: P0 (critical) → P4 (backlog)

### After Each Task (MANDATORY)
1. Close the issue: `bd close <id> --reason="..."`
2. Stage and commit: `git add -A && git commit -m "Close cell-<id>: description"`
3. Only then move to the next task

### Session End (Landing the Plane)
1. File issues for any remaining/follow-up work
2. Run quality gates: `npm run build`
3. Close finished issues, update in-progress items
4. Push to remote: `git pull --rebase && bd sync && git push`
5. Verify: `git status` shows "up to date with origin"

## Tuning Parameters

Defined as constants at the top of `src/App.vue`:

- `SPRING` — collision stiffness
- `RESTORE_RATE` — how fast cells return to base speed
- `WALL_RESTITUTION` — bounciness of the circle boundary
- `DAMPING` — velocity damping per second
- `CELL_COUNT` — number of cells
- `viscosity` (reactive) — scales the simulation clock; adjustable via overlay slider

## Code Style

- 2 spaces, no semicolons, single quotes
- Vue Composition API with `<script setup>`
- `camelCase` for variables/functions, `PascalCase` for components
- No comments unless the logic genuinely needs them
- Keep the physics state in each cell's `userData` (position/velocity in XZ, radius, mass, base speed, bob params)

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
