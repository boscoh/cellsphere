# Beads — local issue tracking

Issues are stored in a **local embedded Dolt database** at
`.beads/embeddeddolt/`. That directory is gitignored: the database is not
committed to git. `bd dolt status` reports the current mode.

## Where the data lives

| Channel | Path / ref | Purpose |
|---|---|---|
| Database | `.beads/embeddeddolt/` (gitignored) | source of truth |
| Dolt remote | `refs/dolt/data` on `origin` (GitHub) | cross-machine sync, off-machine |
| Local backup | `.beads/backup/` (gitignored) | same-machine Dolt snapshots |
| Export | `.beads/issues.jsonl` (gitignored) | optional export for viewers/review; not the database |

`bd dolt push` / `bd dolt pull` move the database to and from the Dolt remote;
neither is a git commit. Off-machine recovery relies on the Dolt remote — no
filesystem backup destination is configured.

## Files here

- `.beads/issues.jsonl` — optional JSONL export. Not committed; `export.auto`
  is at its default (`false`), so refresh on demand with
  `bd export -o .beads/issues.jsonl`. It is an **export, not the source of
  truth** — do not hand-merge it.
- `.beads/interactions.jsonl` — append-only audit log written by `bd audit`;
  intentionally versioned in git.
- `.beads/config.yaml` — tracked project settings. Set with `bd config set`.
- `.beads/.gitignore` — canonical ignore rules. Do not duplicate them in the
  repository-level `.gitignore`.
- `.beads/metadata.json` — storage mode, database name, project id.

## Commands

```bash
bd ready                                # unblocked work
bd show <id>                            # issue + dependencies
bd create "title" -t task -p 2 -d "why"
bd update <id> --claim
bd close <id> --reason "done"
bd dolt push                            # sync the database to the Dolt remote
bd export -o .beads/issues.jsonl        # refresh the optional JSONL export
```

There is no `bd sync` in bd 1.2.2. Cross-machine transfer is
`bd dolt push` / `bd dolt pull` against the configured Dolt remote;
`bd export` is for viewers and interchange only.

See `AGENTS.md` for the agent workflow and `docs/DESIGN.md` for the project.
