# e2b-template

Source for the E2B sandbox template that boots a deterministic Windmill instance.

This template is constructed via E2B's TypeScript SDK using the fluent
`Template()` API — same pattern AgentClash uses, so both templates build with
the same tooling.

## How Windmill runs inside the sandbox

The sandbox runs Windmill **directly as a binary alongside a local Postgres**,
not via Docker-in-Docker or `docker compose`. This mirrors the upstream
ephemeral pattern in `windmill-labs/windmill` at
[`ephemeral-backends/spawn.ts`](https://github.com/windmill-labs/windmill/blob/main/ephemeral-backends/spawn.ts) —
the canonical "spin up a fresh Windmill on demand" reference in the project's
own repo.

Why direct binaries instead of a Docker stack inside the sandbox:

- **Fewer moving parts.** One Windmill process + one Postgres process. No
  Docker daemon, no containerd, no nested compose orchestration.
- **Faster cold-start.** No Docker daemon to initialize before Windmill can
  boot.
- **Smaller image.** ~2 GiB vs. ~3-4 GiB for a DinD stack.
- **Same code path as production.** Windmill's official Docker image runs
  this exact binary as its entrypoint. We just skip the container layer.

The two key Windmill env-var defaults we rely on:

- **`MODE=standalone`** — runs the API server, the embedded SvelteKit
  frontend, and a worker in one process. This is the default if `MODE` is
  unset.
- **`DISABLE_NSJAIL=true`** — Windmill's user-script isolation mode.
  Disabled because the E2B sandbox itself is the trust boundary, so
  per-script kernel isolation is redundant. This is also the default.

## What goes here

- `package.json` — pins the `e2b` SDK and `tsx` runner. Provides `build:dev`
  and `build:prod` scripts.
- `template.ts` — the template itself: base image, system installs, file
  copies, and the start command. Pure declarative composition via the
  `Template()` builder; no Dockerfile.
- `build.dev.ts` / `build.prod.ts` — small entry points that call
  `Template.build(template, name, opts)` with the dev/prod template names.
- `tsconfig.json` — TS config scoped to the three authored files; strict
  mode, NodeNext modules, ES2022 target.
- `boot.sh` — runs once at template build via `setStartCmd`. Initializes
  the Postgres data dir, starts Postgres, creates the `windmill` database,
  sets the postgres password, and execs Windmill in `MODE=standalone`.
  Windmill auto-runs migrations on first connection. The
  `waitForURL('http://localhost:8000/api/version')` ready check blocks
  E2B's snapshot until Windmill is healthy.

## Boot sequence

`boot.sh` runs **once at template-build time** (not at sandbox spawn) via
`setStartCmd`. The snapshot-state probe (`probes/snapshot-state/`,
verdict `FS_AND_PROCESS_PERSISTED` observed 2026-05-09 against E2B SDK
2.14.x) verified both halves of the premise:

- **Filesystem state** persists: ✅ the migrated `/var/lib/postgresql`
  survives into spawned sandboxes.
- **Process state** persists: ✅ the start-command process tree (and its
  children) is alive in spawned sandboxes; verified via
  `pgrep -fa "sleep infinity"`.

So when sandboxes spawn, Postgres is already running and Windmill is
already serving on the migrated DB. **Cold-start ~1.9 seconds**
(measured 2026-05-09: `spawn_latency=1351ms + api_ready_latency=514ms`
via `npm run smoke:run`; better than the original ~3s estimate).

What the script does, in order:

1. Truncates `/var/log/windmill.log` for fresh build-time logs.
2. Initializes the postgresql-16 cluster (`pg_createcluster 16 main`) if
   the data dir is empty.
3. Starts the cluster (`pg_ctlcluster 16 main start`). systemd is not
   present in the sandbox.
4. Polls `pg_isready` for up to ~15 seconds.
5. Sets the `postgres` user password to `changeme` and creates the
   `windmill` database (idempotent via `\gexec`). Uses `runuser -u postgres`
   — `sudo` is not in the image.
6. Exports Windmill env: `DATABASE_URL`, `MODE=standalone`, `PORT=8000`,
   `BASE_URL`, `NUM_WORKERS=1`, `DISABLE_NSJAIL=true`, `RUST_LOG=info`,
   `JSON_FMT=true`.
7. Launches `/usr/local/bin/windmill` in the background, output teed to
   the log file and stdout. Windmill applies all Postgres migrations on
   its first connection.
8. `wait`. Keeps the start-command process alive so E2B's snapshot
   captures Windmill as a live process.

## Default credentials inside the running Windmill

Seeded by Windmill's own first migration (not configured by us):

```
email:    admin@windmill.dev
password: changeme
```

These are the credentials a benchmark runner uses to obtain a bearer token
via `POST /api/auth/login` once a sandbox is spawned.

## Building

You need a configured E2B account and the SDK installed:

```bash
cd e2b-template
npm install
npm run build:dev    # → builds and uploads template `windmill-bench-dev`
npm run build:prod   # → builds and uploads template `windmill-bench-prod`
```

The build returns a template ID; reference it in the challenge pack manifest
under `version.sandbox.sandbox_template_id`.

## Reliability principles

- **Pin every version.** Postgres 16 (apt), Node 20 (NodeSource),
  windmill-cli (npm `1.699.0`), Windmill server binary (`v1.699.0`,
  SHA256-verified at build time). No `:latest`. Mismatch on the binary
  hash fails the build.
- **Frozen Hub snapshot** _(arrives in a later PR)_ lives in
  `../fixtures/hub-snapshot.json` and is baked into the image during
  build, never fetched at runtime.
- **Idempotent boot.** The cluster init and database creation in `boot.sh`
  are guarded so a second run is a no-op (defense in depth — the script is
  expected to run only once per template build).
- **Health-check via the official endpoint.** `setStartCmd`'s ready check
  is `waitForURL('http://localhost:8000/api/version')`, the same endpoint
  Windmill's own GitHub Actions use. Windmill does not open the API port
  until migrations have applied and server + worker + embedded frontend
  are all up.

## Verifying a built template

```bash
# Build (one-off, after editing template.ts or boot.sh)
npm run build:dev

# Smoke-check a spawned sandbox
node -e "
  const { Sandbox } = require('e2b');
  Sandbox.create('windmill-bench-dev').then(async s => {
    const r = await s.commands.run('curl -fs http://localhost:8000/api/version');
    console.log(r.stdout);
    await s.kill();
  });
"
# Expect: a version JSON within ~3 seconds of spawn.
```

Static checks (run before pushing template changes):

```bash
npm run typecheck   # template.ts, build.{dev,prod}.ts, probes/**
npm run shellcheck  # boot.sh
```
