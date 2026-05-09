import { Sandbox } from 'e2b'

// Smoke test for windmill-bench-dev.
//
// Spawns one sandbox, verifies Windmill is actually serving and the seeded
// admin can log in. Reports a structured verdict and dies cleanly on any
// failure with enough context for the maintainer to debug.
//
// Run via `npm run smoke:run` after `npm run build:dev` has produced the
// template at least once.

const TEMPLATE = 'windmill-bench-dev'
const ADMIN_EMAIL = 'admin@windmill.dev'
const ADMIN_PASSWORD = 'changeme'

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

async function main() {
  console.log(`spawning sandbox from "${TEMPLATE}"...`)
  const sandbox = await Sandbox.create(TEMPLATE)
  try {
    // 1. Windmill /api/version reachable.
    const versionResult = await step(
      sandbox,
      'api_version',
      'curl -fsS http://localhost:8000/api/version',
    )
    if (!versionResult.ok) return reportFailure(versionResult.failure)
    console.log('  /api/version:           ', versionResult.stdout.trim())

    // 2. Login with seeded admin to obtain a bearer token.
    const loginCmd =
      `curl -fsS -X POST http://localhost:8000/api/auth/login ` +
      `-H 'Content-Type: application/json' ` +
      `-d '{"email":"${ADMIN_EMAIL}","password":"${ADMIN_PASSWORD}"}'`
    const loginResult = await step(sandbox, 'login', loginCmd)
    if (!loginResult.ok) return reportFailure(loginResult.failure)

    // /api/auth/login returns the token as a JSON-encoded string, e.g.
    // `"abc123..."`. Strip the surrounding quotes for downstream use.
    const token = loginResult.stdout.trim().replace(/^"/, '').replace(/"$/, '')
    if (!token || token.length < 20) {
      return reportFailure({
        step: 'login',
        exitCode: 0,
        stdout: loginResult.stdout,
        stderr: '(login returned 200 but token looks malformed)',
      })
    }
    console.log('  login token:            ', `${token.substring(0, 12)}...`)

    console.log('')
    console.log('verdict                READY')
    process.exitCode = 0
  } finally {
    await sandbox.kill()
  }
}

function reportFailure(failure: StepFailure) {
  console.log('')
  console.log('verdict                FAILED')
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
