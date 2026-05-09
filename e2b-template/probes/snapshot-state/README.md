# snapshot-state probe

**Question:** when E2B builds a template via `Template.build()` and snapshots
the running VM, what gets restored when a sandbox is spawned from that
snapshot?

The probe checks three things independently:

1. **Build-phase filesystem write** (`.runCmd` layer) — this is the control;
   should always be present.
2. **Start-phase filesystem write** (`setStartCmd` start command) — does
   the snapshot capture filesystem mutations made by the start command
   before the ready marker?
3. **Start-phase process tree** — is the long-running `sleep infinity`
   process started by `setStartCmd` *still alive* in spawned sandboxes,
   or does the snapshot only capture disk state?

## Why this matters

If both filesystem AND processes are preserved, the main `template.ts` can
run the Windmill binary once at build time so it applies all Postgres
migrations, leave the windmill + postgres processes running, and snapshot
the populated `/var/lib/postgresql` along with the live processes. Spawned
sandboxes restore with Windmill already serving — cold-start ~3s.

If only filesystem is preserved (and processes aren't), the snapshot trick
breaks: spawned sandboxes have a migrated DB on disk but no live Windmill
or Postgres. boot.sh would need to be re-invoked at sandbox-spawn time
(via the harness, not via setStartCmd) to start the processes against the
migrated DB.

If even the build-phase write isn't present, something fundamental is
broken — investigate before drawing any other conclusion.

## How the probe works

The probe template writes two timestamped files and starts a long-running
process:

- `/probe/build-time.txt` — written during a `.runCmd(...)` (build phase).
- `/probe/start-time.txt` — written by the `setStartCmd` start command,
  before it touches `/probe/ready-marker` (the ready check).
- `sleep infinity` — left running as the start command's foreground
  process so we can verify start-phase process survival via `pgrep`.

The runner spawns a fresh sandbox, reads both files via
`sandbox.commands.run('cat ...')`, and runs `pgrep -fa "sleep infinity"`
to check whether the start-phase process tree survived.

## Scoring matrix

| `/probe/build-time.txt` | `/probe/start-time.txt` | `sleep infinity` alive | Verdict |
|---|---|---|---|
| present | present | yes | **`FS_AND_PROCESS_PERSISTED`** — full snapshot trick is viable |
| present | present | no  | **`FS_ONLY`** — boot.sh must run at sandbox spawn, not at template build |
| present | missing | *   | **`PROBE_BROKEN`** — start-phase write should always be present |
| missing | *       | *   | **`PROBE_BROKEN`** — build-phase write should always be present |

## Result

**Filesystem axes verified** 2026-05-09 against E2B SDK 2.14.x:

```
build-time write present: ✓  2026-05-08T20:52:53Z   (.runCmd phase)
start-time write present: ✓  2026-05-08T20:53:04Z   (setStartCmd phase, before ready marker)
```

**Process axis pending re-run.** The original probe runner only checked
filesystem state; it was extended in commit `7d8190b` to also verify the
start-phase process tree via `pgrep -fa "sleep infinity"`. The probe
needs to be re-run on E2B with the extended runner to record a final
verdict (`FS_AND_PROCESS_PERSISTED` vs `FS_ONLY`).

PR 6 ships `boot.sh` predicated on `FS_AND_PROCESS_PERSISTED` — the
strongest verdict. If the re-run reports `FS_ONLY` instead, PR 6's
setStartCmd wiring needs to change so boot.sh runs at sandbox spawn
rather than at template build.

## Re-running

```bash
cd e2b-template
npm run probe:snapshot:build      # builds template `windmill-bench-probe-snapshot`
npm run probe:snapshot:run        # spawns one sandbox, reads files, checks process, prints verdict
```

Re-run whenever the runner is extended (e.g. new check axis), E2B
changes its snapshot semantics, or we change the base image. Cost: one
short-lived template build + one short-lived sandbox.
