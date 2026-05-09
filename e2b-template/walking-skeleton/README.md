# walking-skeleton

The minimum loop a windmill-bench runner needs: spawn a sandbox, push a
flow, run it, poll for completion, assert the result.

This is **not** part of the benchmark corpus. It exists to prove the
machinery end-to-end before any LLM-generated flows or scoring rubric
land.

## What's in here

- `sample-flow.json` — a hand-written `OpenFlowWPath` body with one
  bash step that echoes a known constant. The smallest possible
  flow that's still a flow (not a single script).
- `run.ts` — driver that spawns a fresh sandbox from the
  `windmill-bench-dev` template, logs in as the seeded admin, pushes
  `sample-flow.json` via `POST /flows/create`, fires it via
  `POST /jobs/run/f/{path}`, polls
  `GET /jobs_u/completed/get_result_maybe/{id}` until done, and asserts
  `success === true && result === "hello-from-windmill"`.

## Running it

You need an `E2B_API_KEY` in your environment and the dev template
already built (`npm run build:dev` from the `e2b-template/` dir at
least once).

```bash
cd e2b-template
npm install
npm run walking-skeleton:run
```

Expected output:

```text
spawning sandbox from "windmill-bench-dev"...
  enqueued job:           <uuid>
  asserted result:        "hello-from-windmill"

  spawn_latency_ms          ~1300
  api_ready_latency_ms      ~500
  login_latency_ms          ~50
  flow_create_latency_ms    ~100
  flow_run_enqueue_ms       ~50
  flow_complete_latency_ms  ~500
  total_latency_ms          ~2500
  verdict                   READY
```

Numbers are illustrative; the first cold-start measurement run on
2026-05-09 saw `spawn=1351ms`, `api_ready=514ms` for the smoke test
which uses the same template.

## Design notes

**Why fire-and-forget + poll, not run_wait_result.** Windmill exposes
both `/jobs/run/f/{path}` (returns a UUID, queue + walk away) and
`/jobs/run_wait_result/f/{path}` (blocks until done, returns the
result). For a 1-step echo either would work. The skeleton uses the
poll loop because that's what the real benchmark runner will need —
some tasks will run longer than a single HTTP keep-alive — and writing
the skeleton in the shape it'll need anyway means we don't rewrite it
when the corpus grows.

**Why `getHost(8000)` + fetch, not curl-in-sandbox.** The
`smoke-test/` runs `curl` inside the sandbox because it specifically
tests in-sandbox tooling (the `wmill` CLI). This skeleton tests the
HTTP API loop, so JSON bodies + bearer auth are involved; native
`fetch` from Node is far cleaner than shell-escaping JSON into curl.

**Why path `u/admin/walking_skeleton`.** Windmill scopes saved
runnables under `u/<user>/...` (user-owned) or `f/<folder>/...`
(folder-owned). The seeded admin's username is `admin`, so the path
is `u/admin/walking_skeleton`. The flow is keyed on its path; the
`/jobs/run/f/{path}` URL takes the path with literal slashes (no
URL encoding).

**Bash result protocol.** Windmill bash scripts emit the **last line
of stdout** as the job's `result`, parsed as JSON if possible else as
a string. `echo 'hello-from-windmill'` produces the bare string
`"hello-from-windmill"` — hence the `=== "hello-from-windmill"`
assertion. A future markdown-tier task that returns structured data
will rely on the JSON-parse branch instead.
