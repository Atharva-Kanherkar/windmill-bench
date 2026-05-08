# snapshot-state probe

**Question:** when E2B builds a template via `Template.build()` and snapshots
the running VM, are filesystem writes made by the **start command** (before
the ready signal) preserved in spawned sandboxes — or does the snapshot only
capture the build-phase layers?

## Why this matters

If start-phase filesystem writes are preserved, the main `template.ts` can
run the Windmill binary once at build time so it applies all Postgres
migrations, snapshot the populated `/var/lib/postgresql`, and cold-start
sandboxes will inherit the migrated DB. Cold-start lands at ~3s.

If they aren't preserved, every sandbox cold-start has to migrate from an
empty DB → ~10-15s plus extra migration logic in the boot script.

## How the probe works

The probe template writes two timestamped files:

- `/probe/build-time.txt` — written during a `.runCmd(...)` (build phase).
  Should always be in the snapshot, since `.runCmd` produces image layers.
- `/probe/start-time.txt` — written by the `setStartCmd` start command,
  before it touches `/probe/ready-marker` (the ready check). This is the
  question.

The runner spawns a fresh sandbox from the built template and reads both
files via `sandbox.commands.run('cat ...')`.

## Scoring matrix

| `/probe/build-time.txt` | `/probe/start-time.txt` | Verdict |
|---|---|---|
| present | present | **`START_PERSISTED`** — pre-migration trick is viable |
| present | missing | **`BUILD_ONLY`** — boot script must migrate at cold-start |
| missing | * | **`PROBE_BROKEN`** — fundamental assumption violated |

## Result

_Awaiting first run. Will be updated with the verdict + the timestamps observed._

## Re-running

```bash
cd e2b-template
npm run probe:snapshot:build      # builds template `windmill-bench-probe-snapshot`
npm run probe:snapshot:run        # spawns one sandbox, reads files, prints verdict
```

Re-run whenever E2B changes its snapshot semantics or we change the base
image; the cost is one short-lived template build + one short-lived sandbox.
