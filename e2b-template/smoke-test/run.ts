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

async function step(
  sandbox: Sandbox,
  name: string,
  cmd: string,
): Promise<{ ok: true; stdout: string } | { ok: false; failure: StepFailure }> {
  const result = await sandbox.commands.run(cmd)
  if (result.exitCode !== 0) {
    return {
      ok: false,
      failure: {
        step: name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    }
  }
  return { ok: true, stdout: result.stdout }
}

// Snapshot restore returns Windmill from a "running" state, but the network
// and process scheduler may need a brief moment to begin servicing requests.
// Poll /api/version until it answers or we hit the timeout. Returns
// successfully on the first 200; the time-to-success is the api_ready
// latency.
async function pollApiReady(
  sandbox: Sandbox,
  url: string,
): Promise<{ ok: true; stdout: string } | { ok: false; failure: StepFailure }> {
  const startedAt = Date.now()
  let lastResult: { exitCode: number; stdout: string; stderr: string } | null = null
  while (Date.now() - startedAt < API_READY_TIMEOUT_MS) {
    const r = await sandbox.commands.run(`curl -fsS ${url} 2>&1 || true`)
    lastResult = r
    if (r.exitCode === 0 && r.stdout.trim().length > 0) {
      return { ok: true, stdout: r.stdout }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    ok: false,
    failure: {
      step: 'api_version',
      exitCode: lastResult?.exitCode ?? -1,
      stdout: lastResult?.stdout ?? '',
      stderr: `polling /api/version timed out after ${API_READY_TIMEOUT_MS}ms`,
    },
  }
}

interface Timings {
  spawn_latency_ms?: number
  api_ready_latency_ms?: number
  login_latency_ms?: number
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

    timings.total_latency_ms = tLogin - t0
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
