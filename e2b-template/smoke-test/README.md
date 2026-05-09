# smoke-test

Single-file integration test for `windmill-bench-dev`. Spawns one sandbox,
verifies Windmill is actually serving and reachable end-to-end, reports
cold-start latency, and exits cleanly.

This is the **first real test** of the `template.ts` + `boot.sh` +
`setStartCmd` stack. Every prior PR was code-review + the small probe
template; nothing has actually exercised the full Windmill boot until you
run this.

## What it verifies

In sequence, after spawning a sandbox from `windmill-bench-dev`:

1. `GET http://localhost:8000/api/version` returns 200 — Windmill is
   serving (poll loop with 30 s ceiling and 100 ms backoff to absorb
   network warmup after snapshot restore).
2. `POST http://localhost:8000/api/auth/login` with the seeded admin
   credentials (`admin@windmill.dev` / `changeme`) returns a bearer
   token.
3. `wmill workspace add bench admins http://localhost:8000 <token>`
   succeeds — the wmill CLI authenticates against the booted Windmill.
4. `wmill workspace list` shows the new `bench` alias — the CLI's local
   state actually persisted the registration.

If all four pass, the template is genuinely working as designed. PR 8
(walking skeleton: push + run a real flow) starts on a known-good
foundation.

## Running

```bash
cd e2b-template
export E2B_API_KEY='...'

# First time only — actually build the template. ~5-10 minutes for the
# first build (547 MiB Windmill binary download + apt installs +
# Postgres init + migration apply at template build time). Subsequent
# builds cache layer-by-layer.
npm run build:dev

# Smoke test. Spawns one sandbox, runs the four checks, reports. ~5-15s.
npm run smoke:run
```

## Reading the output

Success:

```
spawning sandbox from "windmill-bench-dev"...
  /api/version:            {"version":"v1.699.0"}
  login token:             abcd1234ef...
  wmill workspaces:        2 entries

  spawn_latency_ms       2400
  api_ready_latency_ms    700
  login_latency_ms        180
  wmill_cli_latency_ms    420
  total_latency_ms       3700
  verdict                READY
```

The headline cold-start number is `spawn_latency_ms + api_ready_latency_ms`
— time from "I want a Windmill" to "I can hit the API." PR 6 claims this
should be ~3 seconds; the smoke test reports the real number.

Failure (e.g. login times out):

```
spawning sandbox from "windmill-bench-dev"...
  /api/version:            {"version":"v1.699.0"}

  spawn_latency_ms       2400
  api_ready_latency_ms    700
  login_latency_ms       FAILED
  verdict                FAILED

failure step:    login
exit code:       7
stdout:          (empty)
stderr:          curl: (7) Failed to connect to localhost port 8000
```

Partial timings are emitted on failure paths so you can see how far
along the test got before things broke down.

## When it fails

Look at the failing step. Each step has a fundamentally different
debugging path:

- **api_version** times out → the build's `setStartCmd` likely never
  reached the ready signal. Check `npm run build:dev` logs for migration
  errors. The Windmill binary's stdout from boot.sh's `tee` should be in
  the build log.
- **login** fails → `/api/version` worked but `/api/auth/login` didn't.
  Probably means migrations didn't seed the admin user. Re-check
  Windmill's first migration ran by running `runuser -u postgres -- psql -d
  windmill -tAc "SELECT count(*) FROM password"` inside the sandbox.
- **wmill_workspace_add** fails → the failure report includes
  `wmill workspace add --help` output. Compare the documented argument
  order against what we're passing in `run.ts`.
- **wmill_workspace_list** doesn't show `bench` → the add silently
  no-op'd. Inspect `~/.config/wmill/Config.json` inside the sandbox.

Don't loop on a failed run by retrying the same flow. Read the failure
output once, fix the one thing, re-run. First-time integration always
uncovers something — the discipline is to debug it once.
