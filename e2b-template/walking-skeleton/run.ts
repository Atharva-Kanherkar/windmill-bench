import { Sandbox } from 'e2b'
import sampleFlow from './sample-flow.json'

// Walking skeleton for windmill-bench.
//
// Drives one hand-written Windmill flow end-to-end against a freshly
// spawned sandbox: spawn -> login -> push flow -> trigger run -> poll
// for completion -> assert result. Closes the "drive 1 hand-written
// flow end-to-end" milestone before any LLM-generated flows or
// scoring rubric exist. The benchmark runner that PRs 10+ build out
// will re-use this exact loop shape; this script is the minimum
// reference implementation.
//
// Run via `npm run walking-skeleton:run` after `npm run build:dev`
// has produced the template at least once.

const TEMPLATE = 'windmill-bench-dev'
const WORKSPACE = 'admins'
const ADMIN_EMAIL = 'admin@windmill.dev'
const ADMIN_PASSWORD = 'changeme'
const EXPECTED_RESULT = 'hello-from-windmill'
const POLL_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 200

interface Timings {
  spawn_latency_ms?: number
  api_ready_latency_ms?: number
  login_latency_ms?: number
  flow_create_latency_ms?: number
  flow_run_enqueue_ms?: number
  flow_complete_latency_ms?: number
  total_latency_ms?: number
}

interface Failure {
  step: string
  detail: string
}

// HTTP helper bound to the sandbox's exposed port. Returns parsed JSON
// when content-type says so, otherwise raw text. Throws Failure on
// non-2xx so the call sites can surface step + detail uniformly.
function makeApi(host: string, token?: string) {
  const base = `https://${host}`
  return async function api(
    step: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    if (!r.ok) {
      const f: Failure = {
        step,
        detail: `HTTP ${r.status} ${r.statusText} from ${method} ${path}\nbody: ${text.slice(0, 500)}`,
      }
      throw f
    }
    const ct = r.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    return text
  }
}

// Windmill returns text/plain bodies for createFlow + runFlowByPath +
// /api/auth/login. Some versions wrap the body in JSON quotes, some
// don't; strip them defensively (matches smoke-test/run.ts).
function unquote(s: string): string {
  return s.trim().replace(/^"/, '').replace(/"$/, '')
}

async function pollForCompletion(
  api: ReturnType<typeof makeApi>,
  jobId: string,
): Promise<{ completed: true; success: boolean; result: unknown }> {
  const startedAt = Date.now()
  let last: unknown = null
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const r = (await api(
      'poll_completion',
      'GET',
      `/api/w/${WORKSPACE}/jobs_u/completed/get_result_maybe/${jobId}`,
    )) as { completed: boolean; success?: boolean; result: unknown }
    last = r
    if (r.completed) {
      return { completed: true, success: r.success === true, result: r.result }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  const f: Failure = {
    step: 'poll_completion',
    detail: `job ${jobId} did not complete within ${POLL_TIMEOUT_MS}ms; last response: ${JSON.stringify(last)}`,
  }
  throw f
}

async function pollApiReady(api: ReturnType<typeof makeApi>): Promise<void> {
  const startedAt = Date.now()
  let lastErr: unknown = null
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    try {
      await api('api_version', 'GET', '/api/version')
      return
    } catch (err) {
      lastErr = err
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  const f: Failure = {
    step: 'api_version',
    detail: `/api/version did not respond within ${POLL_TIMEOUT_MS}ms; last error: ${JSON.stringify(lastErr)}`,
  }
  throw f
}

async function main() {
  const timings: Timings = {}
  console.log(`spawning sandbox from "${TEMPLATE}"...`)

  const t0 = Date.now()
  const sandbox = await Sandbox.create(TEMPLATE)
  const tSpawn = Date.now()
  timings.spawn_latency_ms = tSpawn - t0

  try {
    const host = sandbox.getHost(8000)
    const unauthed = makeApi(host)

    // 1. Verify Windmill is serving on the exposed port. Snapshot
    //    restore + E2B edge proxy warmup can cost a beat.
    await pollApiReady(unauthed)
    const tApi = Date.now()
    timings.api_ready_latency_ms = tApi - tSpawn

    // 2. Login as the seeded admin -> bearer token (text/plain).
    const tokenRaw = (await unauthed('login', 'POST', '/api/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    })) as string
    const token = unquote(tokenRaw)
    if (token.length < 20) {
      const f: Failure = { step: 'login', detail: `token looks malformed: ${tokenRaw.slice(0, 80)}` }
      throw f
    }
    const tLogin = Date.now()
    timings.login_latency_ms = tLogin - tApi

    const api = makeApi(host, token)

    // 3. Push the hand-written flow. Per v1.699.0 OpenAPI:
    //      POST /api/w/{workspace}/flows/create
    //      body: OpenFlowWPath (path + summary + value required)
    //      response: 201 text/plain (the deployed path)
    await api('flow_create', 'POST', `/api/w/${WORKSPACE}/flows/create`, sampleFlow)
    const tCreate = Date.now()
    timings.flow_create_latency_ms = tCreate - tLogin

    // 4. Trigger the flow fire-and-forget. We deliberately use
    //    /jobs/run/f/{path} (not /jobs/run_wait_result/f/{path})
    //    because the real benchmark loop will need the
    //    enqueue + poll shape for tasks that take longer than a
    //    single HTTP timeout. Walking-skeleton mirrors that loop
    //    so we don't rewrite it later.
    const flowPath = sampleFlow.path
    const jobIdRaw = (await api(
      'flow_run',
      'POST',
      `/api/w/${WORKSPACE}/jobs/run/f/${flowPath}`,
      {},
    )) as string
    const jobId = unquote(jobIdRaw)
    if (!/^[0-9a-f-]{36}$/.test(jobId)) {
      const f: Failure = { step: 'flow_run', detail: `job id is not a UUID: ${jobIdRaw.slice(0, 80)}` }
      throw f
    }
    const tEnqueue = Date.now()
    timings.flow_run_enqueue_ms = tEnqueue - tCreate
    console.log(`  enqueued job:           ${jobId}`)

    // 5. Poll get_result_maybe until completed=true. Returns
    //    {completed, result, success, started}; once completed we
    //    assert success + the bash-result-protocol value.
    const completion = await pollForCompletion(api, jobId)
    const tComplete = Date.now()
    timings.flow_complete_latency_ms = tComplete - tEnqueue

    if (!completion.success) {
      const f: Failure = {
        step: 'flow_complete',
        detail: `job ${jobId} completed with success=false; result: ${JSON.stringify(completion.result)}`,
      }
      throw f
    }

    // Windmill bash-result protocol: the script's "result" is the
    // last line of stdout, parsed as JSON if possible else as a
    // string. `echo 'hello-from-windmill'` => bare string.
    if (completion.result !== EXPECTED_RESULT) {
      const f: Failure = {
        step: 'assert_result',
        detail: `expected ${JSON.stringify(EXPECTED_RESULT)}, got ${JSON.stringify(completion.result)}`,
      }
      throw f
    }
    console.log(`  asserted result:        ${JSON.stringify(completion.result)}`)

    timings.total_latency_ms = tComplete - t0
    reportSuccess(timings)
  } catch (err) {
    reportFailure(err, timings)
  } finally {
    await sandbox.kill()
  }
}

function isFailure(x: unknown): x is Failure {
  return typeof x === 'object' && x !== null && 'step' in x && 'detail' in x
}

function reportSuccess(timings: Timings) {
  console.log('')
  for (const [k, v] of Object.entries(timings)) {
    console.log(`  ${k.padEnd(26)} ${v}`)
  }
  console.log(`  ${'verdict'.padEnd(26)} READY`)
  process.exitCode = 0
}

function reportFailure(err: unknown, timings: Timings) {
  console.log('')
  for (const [k, v] of Object.entries(timings)) {
    console.log(`  ${k.padEnd(26)} ${v ?? 'FAILED'}`)
  }
  console.log(`  ${'verdict'.padEnd(26)} FAILED`)
  console.log('')
  if (isFailure(err)) {
    console.log('failure step:   ', err.step)
    console.log('detail:         ', err.detail)
  } else {
    console.log('error:          ', err)
  }
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
