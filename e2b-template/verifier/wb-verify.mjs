#!/usr/bin/env node
// wb-verify -- runs an agent-deployed Windmill flow against a JSON cases
// file and emits a single-line JSON summary on stdout in the format
// AgentClash's code_execution validator parses
// (backend/internal/scoring/code_execution.go ParseCodeExecutionCounts):
//
//   {"passed": N, "failed": M, "errors": K, "cases": [...]}
//
// The validator's parser tries JSON first on the *combined stdout+stderr*
// of the test_command, so this script writes ONLY the JSON object to
// stdout and writes NOTHING to stderr. Diagnostics for humans live as
// extra keys in the JSON (passed, failed, errors are the only keys the
// parser reads; everything else is ignored).
//
// Exit code is always 0 on a successful run. The validator scores from
// the parsed counts, not the exit code, so a verifier-level fatal
// (cannot reach Windmill, login failed, etc.) is reported as
// {"passed":0, "failed":<all>, "errors":1, "fatal":"..."} -- the score
// becomes 0/N.
//
// Usage:
//   wb-verify --flow-path u/admin/submission \
//             --cases /usr/share/wb/cases/sum-two-numbers.json
//
// Cases file shape:
//   [
//     { "name": "small", "inputs": {"a": 2, "b": 3}, "expected": 5 },
//     ...
//   ]
//
// Authenticates as the seeded admin (admin@windmill.dev / changeme)
// against the in-sandbox Windmill at http://localhost:8000. The
// verifier's auth is independent of however the agent authenticated
// during its run -- we get a fresh token on every invocation, no
// dependence on snapshot-baked credentials.

import { readFileSync } from 'node:fs'
import { argv, exit, stdout } from 'node:process'

const WORKSPACE = 'admins'
const ADMIN_EMAIL = 'admin@windmill.dev'
const ADMIN_PASSWORD = 'changeme'
const BASE = 'http://localhost:8000'
const POLL_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 200

function parseArgs(args) {
  const out = { flowPath: null, cases: null }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--flow-path') out.flowPath = args[++i]
    else if (a === '--cases') out.cases = args[++i]
  }
  return out
}

function emit(summary) {
  // Single line of JSON to stdout, no trailing newline noise that
  // the validator's strict json.Unmarshal would still accept (it
  // trims whitespace). No stderr.
  stdout.write(JSON.stringify(summary) + '\n')
  exit(0)
}

function fatal(passed, failed, detail) {
  emit({ passed, failed, errors: 1, fatal: detail })
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  if (!r.ok) throw new Error(`login HTTP ${r.status}`)
  const text = (await r.text()).trim()
  return text.replace(/^"/, '').replace(/"$/, '')
}

async function runOneCase(token, flowPath, inputs) {
  // Fire-and-forget enqueue. Returns text/plain UUID.
  const enqueue = await fetch(
    `${BASE}/api/w/${WORKSPACE}/jobs/run/f/${flowPath}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(inputs),
    },
  )
  if (enqueue.status === 404) {
    return { status: 'no_flow', detail: `flow ${flowPath} not found (HTTP 404 on /jobs/run/f/{path})` }
  }
  if (!enqueue.ok) {
    const body = (await enqueue.text()).slice(0, 300)
    return { status: 'enqueue_failed', detail: `HTTP ${enqueue.status}: ${body}` }
  }
  const jobId = (await enqueue.text()).trim().replace(/^"/, '').replace(/"$/, '')
  if (!/^[0-9a-f-]{36}$/.test(jobId)) {
    return { status: 'enqueue_failed', detail: `non-UUID job id: ${jobId.slice(0, 80)}` }
  }

  // Poll for completion.
  const startedAt = Date.now()
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const r = await fetch(
      `${BASE}/api/w/${WORKSPACE}/jobs_u/completed/get_result_maybe/${jobId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300)
      return { status: 'poll_failed', detail: `HTTP ${r.status}: ${body}`, jobId }
    }
    const j = await r.json()
    if (j.completed) {
      return {
        status: j.success === true ? 'completed' : 'runtime_error',
        result: j.result,
        success: j.success === true,
        jobId,
      }
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
  }
  return { status: 'timeout', detail: `not completed within ${POLL_TIMEOUT_MS}ms`, jobId }
}

// Strict equality for the result. We deliberately do NOT coerce
// "5" (string) to 5 (number). The pack instructions tell the agent
// the expected return type, and grading honestly is more useful than
// being friendly. JSON.stringify-compare handles arrays/objects.
function strictEqual(got, expected) {
  return JSON.stringify(got) === JSON.stringify(expected)
}

async function main() {
  const { flowPath, cases } = parseArgs(argv.slice(2))
  if (!flowPath || !cases) {
    fatal(0, 1, 'usage: wb-verify --flow-path <path> --cases <cases.json>')
    return
  }

  let casesData
  try {
    casesData = JSON.parse(readFileSync(cases, 'utf8'))
  } catch (err) {
    fatal(0, 1, `cannot read cases file ${cases}: ${err?.message ?? err}`)
    return
  }
  if (!Array.isArray(casesData) || casesData.length === 0) {
    fatal(0, 1, `cases file is not a non-empty array`)
    return
  }

  let token
  try {
    token = await login()
    if (token.length < 20) throw new Error(`token looks malformed: ${token.slice(0, 80)}`)
  } catch (err) {
    fatal(0, casesData.length, `login failed: ${err?.message ?? err}`)
    return
  }

  let passed = 0
  let failed = 0
  const details = []
  for (const c of casesData) {
    const name = c.name ?? JSON.stringify(c.inputs)
    let detail
    try {
      const res = await runOneCase(token, flowPath, c.inputs ?? {})
      if (res.status !== 'completed') {
        failed++
        details.push({ name, status: res.status, detail: res.detail ?? null, jobId: res.jobId ?? null })
        continue
      }
      if (strictEqual(res.result, c.expected)) {
        passed++
        details.push({ name, status: 'ok', got: res.result, jobId: res.jobId })
      } else {
        failed++
        details.push({
          name,
          status: 'mismatch',
          got: res.result,
          expected: c.expected,
          jobId: res.jobId,
        })
      }
    } catch (err) {
      failed++
      detail = err?.message ?? String(err)
      details.push({ name, status: 'verifier_error', detail })
    }
  }

  emit({ passed, failed, errors: 0, cases: details, flow_path: flowPath })
}

main().catch((err) => {
  fatal(0, 1, `unhandled: ${err?.message ?? err}`)
})
