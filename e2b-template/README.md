# e2b-template

Source for the E2B sandbox template that boots a deterministic Windmill instance.

## What goes here

- `e2b.toml` — E2B template manifest (template name, base image, build args).
- `Dockerfile` — image definition. Pinned Windmill + Postgres versions; pre-pulled
  images so cold-start is fast.
- `boot.sh` — runs on sandbox start. Brings up Windmill + Postgres via
  docker-compose, polls health endpoint, bootstraps workspace, loads frozen Hub
  snapshot and workspace seed, then signals `READY` on stdout.
- `docker-compose.yml` — Windmill's official compose, version-pinned.

## Building

```bash
# from repo root, after installing the e2b CLI:
cd e2b-template
e2b template build
# → returns a template ID; reference it in pack.yaml
```

## Reliability principles

- Pin every version (Windmill, Postgres, wmill CLI). No `:latest`.
- Frozen Hub snapshot lives in `../fixtures/hub-snapshot.json`.
- Boot script is idempotent — safe to re-run inside a sandbox.
- Health-check before signaling `READY`. Never race the harness against a
  half-booted Windmill.
