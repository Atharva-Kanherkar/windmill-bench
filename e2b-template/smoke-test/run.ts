import { Sandbox } from 'e2b'

// Smoke test for windmill-bench-dev.
//
// Spawns one sandbox, verifies Windmill is actually serving and the seeded
// admin can log in, and times each stage so we can validate (or refute)
// PR 6's "~3s cold-start" claim with hard data.
//
// Run via `npm run smoke:run` after `npm run build:dev` has produced the
// template at least once.

const TEMPLATE = 'windmill-bench-dev'
const ADMIN_EMAIL = 'admin@windmill.dev'
const ADMIN_PASSWORD = 'changeme'
const API_READY_TIMEOUT_MS = 30_000

interface StepFailure {
  step: string
  exitCode: number
  stdout: string
  stderr: string
}

// The e2b SDK's `commands.run()` throws CommandExitError on any non-zero
// exit (it internally calls CommandHandle.wait()). This shape (try/catch
// → result/failure object) lets us treat both throw paths and zero-exit
// paths uniformly downstream.
function failureFromError(name: string, err: unknown): StepFailure {
  // CommandExitError carries exitCode/stdout/stderr; surface them when
  // present. Any other error type (network, sandbox dropped) falls back
  // to a stringified message.
  const e = err as Partial<{ exitCode: number; stdout: string; stderr: string }>
  return {
    step: name,
    exitCode: typeof e.exitCode === 'number' ? e.exitCode : -1,
    stdout: typeof e.stdout === 'string' ? e.stdout : '',
    stderr: typeof e.stderr === 'string' ? e.stderr : String(err),
  }
}

async function step(
  sandbox: Sandbox,
  name: string,
  cmd: string,
): Promise<{ ok: true; stdout: string } | { ok: false; failure: StepFailure }> {
  try {
    const result = await sandbox.commands.run(cmd)
    return { ok: true, stdout: result.stdout }
  } catch (err) {
    return { ok: false, failure: failureFromError(name, err) }
  }
}

// Snapshot restore returns Windmill from a "running" state, but the network
// and process scheduler may need a brief moment to begin servicing requests.
// Poll /api/version until it answers or we hit the timeout. Returns
// successfully on the first 200; the time-to-success is the api_ready
// latency.
//
// IMPORTANT: the curl invocation deliberately does NOT include `|| true`
// or `2>&1`. We need curl's true exit code to flow through:
//   - 0 means HTTP 2xx; we got a real response — succeed.
//   - non-zero means connection refused / HTTP 4xx-5xx (because of -f);
//     the SDK throws CommandExitError, we catch it, wait, retry.
// A previous version used `curl -fsS ${url} 2>&1 || true` and checked
// "exitCode 0 + non-empty stdout" — that false-passes on connection
// failures because curl's error text gets redirected into stdout and the
// shell always exits 0.
async function pollApiReady(
  sandbox: Sandbox,
  url: string,
): Promise<{ ok: true; stdout: string } | { ok: false; failure: StepFailure }> {
  const startedAt = Date.now()
  let lastFailure: StepFailure | null = null
  while (Date.now() - startedAt < API_READY_TIMEOUT_MS) {
    try {
      const r = await sandbox.commands.run(`curl -fsS ${url}`)
      // curl -f exits 0 only on 2xx; we have a real response.
      return { ok: true, stdout: r.stdout }
    } catch (err) {
      lastFailure = failureFromError('api_version', err)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    ok: false,
    failure: {
      step: 'api_version',
      exitCode: lastFailure?.exitCode ?? -1,
      stdout: lastFailure?.stdout ?? '',
      stderr:
        `polling /api/version timed out after ${API_READY_TIMEOUT_MS}ms` +
        (lastFailure?.stderr ? `\nlast curl error: ${lastFailure.stderr}` : ''),
    },
  }
}

interface Timings {
  spawn_latency_ms?: number
  api_ready_latency_ms?: number
  login_latency_ms?: number
  wmill_cli_latency_ms?: number
  total_latency_ms?: number
}

async function main() {
  const timings: Timings = {}
  console.log(`spawning sandbox from "${TEMPLATE}"...`)

  const t0 = Date.now()
  const sandbox = await Sandbox.create(TEMPLATE)
  const tSpawn = Date.now()
  timings.spawn_latency_ms = tSpawn - t0

  try {
    // 1. Windmill /api/version reachable. Poll because snapshot-restore +
    //    network warmup can cost a small but non-zero amount.
    const versionResult = await pollApiReady(sandbox, 'http://localhost:8000/api/version')
    const tApi = Date.now()
    timings.api_ready_latency_ms = tApi - tSpawn
    if (!versionResult.ok) return reportFailure(versionResult.failure, timings)
    console.log('  /api/version:           ', versionResult.stdout.trim())

    // 2. Login with seeded admin to obtain a bearer token.
    const loginCmd =
      `curl -fsS -X POST http://localhost:8000/api/auth/login ` +
      `-H 'Content-Type: application/json' ` +
      `-d '{"email":"${ADMIN_EMAIL}","password":"${ADMIN_PASSWORD}"}'`
    const loginResult = await step(sandbox, 'login', loginCmd)
    const tLogin = Date.now()
    timings.login_latency_ms = tLogin - tApi
    if (!loginResult.ok) return reportFailure(loginResult.failure, timings)

    const token = loginResult.stdout.trim().replace(/^"/, '').replace(/"$/, '')
    if (!token || token.length < 20) {
      return reportFailure(
        {
          step: 'login',
          exitCode: 0,
          stdout: loginResult.stdout,
          stderr: '(login returned 200 but token looks malformed)',
        },
        timings,
      )
    }
    console.log('  login token:            ', `${token.substring(0, 12)}...`)

    // 3. wmill CLI: register a local workspace alias against the running
    //    Windmill, then list to confirm it took. This proves the CLI tool
    //    PR 8 will use for flow push/run is actually functional in the
    //    booted sandbox — not just the HTTP API.
    //
    //    Per research, the form is `wmill workspace add <name> <ws> <url> <token>`
    //    where `<name>` is a local alias and `<ws>` is the existing
    //    server-side workspace id (the seeded `admins` workspace). If
    //    flag order has changed, the failure capture below ALSO prints
    //    `wmill workspace add --help` so the maintainer sees the right
    //    form rather than a bare exit code.
    const wmillAddCmd =
      `wmill workspace add bench admins http://localhost:8000 ${token}`
    const wmillAddResult = await step(sandbox, 'wmill_workspace_add', wmillAddCmd)
    if (!wmillAddResult.ok) {
      const helpResult = await sandbox.commands.run(
        'wmill workspace add --help 2>&1 || true',
      )
      return reportFailure(
        {
          step: 'wmill_workspace_add',
          exitCode: wmillAddResult.failure.exitCode,
          stdout: wmillAddResult.failure.stdout,
          stderr:
            `${wmillAddResult.failure.stderr}\n\n` +
            `--- wmill workspace add --help ---\n${helpResult.stdout}`,
        },
        timings,
      )
    }

    const wmillListResult = await step(sandbox, 'wmill_workspace_list', 'wmill workspace list')
    const tWmill = Date.now()
    timings.wmill_cli_latency_ms = tWmill - tLogin
    if (!wmillListResult.ok) return reportFailure(wmillListResult.failure, timings)
    if (!wmillListResult.stdout.includes('bench')) {
      return reportFailure(
        {
          step: 'wmill_workspace_list',
          exitCode: 0,
          stdout: wmillListResult.stdout,
          stderr: "(workspace alias 'bench' not in list output — wmill add may have silently no-op'd)",
        },
        timings,
      )
    }
    console.log('  wmill workspaces:       ', wmillListResult.stdout.trim().split('\n').length, 'entries')

    timings.total_latency_ms = tWmill - t0
    reportSuccess(timings)
  } finally {
    await sandbox.kill()
  }
}

function reportSuccess(timings: Timings) {
  console.log('')
  for (const [k, v] of Object.entries(timings)) {
    console.log(`  ${k.padEnd(22)} ${v}`)
  }
  console.log(`  ${'verdict'.padEnd(22)} READY`)
  process.exitCode = 0
}

function reportFailure(failure: StepFailure, timings: Timings) {
  console.log('')
  for (const [k, v] of Object.entries(timings)) {
    console.log(`  ${k.padEnd(22)} ${v ?? 'FAILED'}`)
  }
  console.log(`  ${'verdict'.padEnd(22)} FAILED`)
  console.log('')
  console.log('failure step:   ', failure.step)
  console.log('exit code:      ', failure.exitCode)
  console.log('stdout:         ', failure.stdout || '(empty)')
  console.log('stderr:         ', failure.stderr || '(empty)')
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
