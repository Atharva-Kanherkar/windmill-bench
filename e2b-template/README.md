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
- `boot.sh` _(added in a later PR)_ — runs on sandbox start. Initializes
  the Postgres data dir if needed, starts Postgres, runs the Windmill
  binary in `MODE=standalone`, polls `/api/version`, and signals readiness
  via the `setStartCmd` ready check.

## What's in this PR (`feat/install-windmill-deps`)

Just the runtime dependencies, baked into the image at build time:

- PostgreSQL 16 via apt
- Node.js 20 via NodeSource (needed for the wmill CLI)
- `windmill-cli` via `npm install -g`
- The Windmill server binary v1.699.0, pinned by URL **and SHA256**, fetched
  from the GitHub release

No boot script in this PR. Nothing actually runs yet — the sandbox just has
the bits available. Boot orchestration lands in a later PR (see comment block
at the top of `template.ts`).

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

- **Pin every version.** Postgres 16 (apt), Node 20 (NodeSource), Windmill
  v1.699.0 (URL + SHA256 verified at build time). No `:latest`. SHA256 of
  the Windmill binary is checked before install — mismatch fails the build.
- **Frozen Hub snapshot** _(arrives later)_ lives in `../fixtures/hub-snapshot.json`
  and is baked into the image during build, never fetched at runtime.
- **Idempotent boot** _(arrives later)_. The boot script must be safe to
  re-run inside an already-bootstrapped sandbox. Distinct subcommands for
  fresh-start vs reuse rather than blanket truncation.
- **Health-check before signaling.** The boot script polls
  `http://localhost:8000/api/version` (Windmill's official healthcheck endpoint)
  before signaling ready. Same endpoint Windmill's own GitHub Actions use.
