# e2b-template

Source for the E2B sandbox template that boots a deterministic Windmill instance.

This template is constructed via E2B's TypeScript SDK using the fluent
`Template()` API — same pattern AgentClash uses, so both templates build with
the same tooling.

## What goes here

- `package.json` — pins the `e2b` SDK and `tsx` runner. Provides `build:dev`
  and `build:prod` scripts.
- `template.ts` — the template itself: base image, system installs, file
  copies, and the start command. Pure declarative composition via the
  `Template()` builder; no Dockerfile.
- `build.dev.ts` / `build.prod.ts` — small entry points that call
  `Template.build(template, name, opts)` with the dev/prod template names.
- `boot.sh` _(added in a later PR)_ — runs on sandbox start. Brings up
  Windmill + Postgres, polls health, bootstraps workspace, loads the frozen
  Hub snapshot and workspace seed, signals `READY` on stdout.
- `docker-compose.yml` _(added in a later PR)_ — Windmill's official compose,
  version-pinned. Bundled into the image at build time.

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

- **Pin every version.** Windmill, Postgres, wmill CLI — no `:latest`. Inline
  the digests where the SDK supports them.
- **Frozen Hub snapshot** lives in `../fixtures/hub-snapshot.json` and is
  baked into the image during build, never fetched at runtime.
- **Idempotent boot.** The boot script must be safe to re-run inside an
  already-bootstrapped sandbox. Distinct subcommands for fresh-start vs
  reuse rather than blanket truncation.
- **Health-check before signaling.** The boot script polls
  `http://localhost:8000/api/version` (or equivalent) before emitting
  `READY` on stdout. The harness blocks on `READY` and never races a
  half-booted Windmill.
