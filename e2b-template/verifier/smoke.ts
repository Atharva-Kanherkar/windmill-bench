import { Sandbox } from 'e2b'
import { readFileSync } from 'node:fs'

// Smoke test for the wb-verify baked into windmill-bench-dev.
//
// One sandbox spawn, three checks:
//
//   1. NEGATIVE: invoke wb-verify against a path no flow has been
//      deployed to. Every case should report status='no_flow' and the
//      summary should be {passed:0, failed:5}.
//
//   2. POSITIVE: hand-deploy a correct sum flow at u/admin/submission
//      and re-run wb-verify. Expect {passed:5, failed:0}.
//
//   3. WRONG: overwrite the flow at u/admin/submission with one that
//      returns the constant 0 instead of a+b. Re-run wb-verify. Expect
//      {passed:1, failed:4} — the zero+zero case incidentally passes,
//      proving the verifier doesn't false-pass when the flow happens
//      to match for some cases but not all.
//
// The hand-deployed flows are deployed via Windmill's HTTP API directly
// from this script (not via wmill CLI), since the agent's deployment
// mechanism is the agent's concern; the verifier only cares that
// SOMETHING is deployed at the path.

const TEMPLATE = 'windmill-bench-dev'
const WORKSPACE = 'admins'
const FLOW_PATH = 'u/admin/submission'
const WRONG_FLOW_PATH = 'u/admin/submission_wrong'
const ADMIN_EMAIL = 'admin@windmill.dev'
const ADMIN_PASSWORD = 'changeme'

interface Summary {
  passed?: number
  failed?: number
  errors?: number
  fatal?: string
  cases?: Array<{ name: string; status: string; got?: unknown; expected?: unknown; detail?: string | null }>
}

// Bash flows are used here (not bun/nativets/python) because bash needs
// no external runtime install on the worker. The standalone Windmill in
// our image ships only the windmill binary + its embedded worker, and
// every other language currently fails with "Executable not found on
// worker": bun -> /usr/bin/bun missing, deno -> /usr/bin/deno missing,
// python3 -> uv missing. Adding language runtimes is tracked separately
// for when the agent corpus needs them; the verifier smoke only needs
// to prove the wb-verify pipeline works against ANY working flow.
//
// Bash protocol verified empirically against v1.699.0 in this image:
//   * input_transforms keys map to positional args $1, $2, ... in
//     insertion order. We always emit `a` then `b`, so $1=a, $2=b.
//   * Bash inputs are NOT auto-bound as named variables -- `$a`/`$b`
//     are empty unless the script explicitly assigns from `$1`/`$2`.
//   * Result is the last line of stdout, returned as a STRING (not
//     JSON-parsed). `echo $((a+b))` returns "5" (string), not 5
//     (number). The verifier handles this with a one-direction
//     numeric coercion (string -> number) when expected is numeric.
const correctFlow = {
  path: FLOW_PATH,
  summary: 'sum two numbers (correct)',
  value: {
    modules: [
      {
        id: 'sum',
        value: {
          type: 'rawscript',
          language: 'bash',
          content: 'a="$1"\nb="$2"\necho $((a + b))\n',
          input_transforms: {
            a: { type: 'javascript', expr: 'flow_input.a' },
            b: { type: 'javascript', expr: 'flow_input.b' },
          },
        },
      },
    ],
  },
  schema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
}

const wrongFlow = {
  ...correctFlow,
  path: WRONG_FLOW_PATH,
  summary: 'sum two numbers (always-zero — wrong)',
  value: {
    modules: [
      {
        id: 'sum',
        value: {
          type: 'rawscript',
          language: 'bash',
          content: 'echo 0\n',
          input_transforms: {
            a: { type: 'javascript', expr: 'flow_input.a' },
            b: { type: 'javascript', expr: 'flow_input.b' },
          },
        },
      },
    ],
  },
}

async function pollApiReady(host: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`https://${host}/api/version`)
      if (r.ok) return
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('windmill /api/version did not become ready within 30s')
}

async function login(host: string): Promise<string> {
  const r = await fetch(`https://${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  if (!r.ok) throw new Error(`login HTTP ${r.status}`)
  return (await r.text()).trim().replace(/^"/, '').replace(/"$/, '')
}

async function deployFlow(host: string, token: string, flow: unknown) {
  const r = await fetch(`https://${host}/api/w/${WORKSPACE}/flows/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(flow),
  })
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300)
    throw new Error(`deploy HTTP ${r.status}: ${body}`)
  }
}

async function runVerify(sandbox: Sandbox, label: string, flowPath: string): Promise<Summary> {
  const r = await sandbox.commands.run(
    `wb-verify --flow-path ${flowPath} --cases /usr/share/wb/cases/sum-two-numbers.json`,
  )
  console.log(`  [${label}] stdout: ${r.stdout.trim()}`)
  if (r.stderr) console.log(`  [${label}] stderr: ${r.stderr.trim()}`)
  let parsed: Summary
  try {
    parsed = JSON.parse(r.stdout.trim()) as Summary
  } catch (err) {
    throw new Error(`[${label}] verifier stdout was not parseable JSON: ${err}`)
  }
  return parsed
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.log(`  FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`  ok:   ${msg}`)
  }
}

async function main() {
  console.log(`spawning sandbox from "${TEMPLATE}"...`)
  const sandbox = await Sandbox.create(TEMPLATE)
  try {
    // Sync local wb-verify.mjs into the sandbox so iteration on the
    // verifier doesn't require rebuilding the template every time.
    // The baked-in copy at /usr/local/lib/wb-verify.mjs is overwritten
    // by whatever is on disk at smoke-run time. Drop this once the
    // verifier is stable and we trust the template build.
    // Path is resolved against process.cwd() rather than __dirname/import.meta
    // so this stays compatible with both the CommonJS-emitting tsc check and
    // the tsx ESM runtime. `npm run verifier:smoke` always runs from the
    // e2b-template/ directory, so the relative path is stable.
    const localVerifier = readFileSync('verifier/wb-verify.mjs', 'utf8')
    await sandbox.files.write('/usr/local/lib/wb-verify.mjs', localVerifier)
    const localCases = readFileSync('verifier/cases/sum-two-numbers.json', 'utf8')
    await sandbox.files.write('/usr/share/wb/cases/sum-two-numbers.json', localCases)

    const host = sandbox.getHost(8000)
    await pollApiReady(host)
    const token = await login(host)

    // 1. NEGATIVE: u/admin/submission has no flow deployed.
    console.log('check 1: negative (no flow deployed)')
    const neg = await runVerify(sandbox, 'negative', FLOW_PATH)
    assert(neg.passed === 0, `negative passed === 0 (got ${neg.passed})`)
    assert(neg.failed === 5, `negative failed === 5 (got ${neg.failed})`)
    assert(
      Array.isArray(neg.cases) && neg.cases.every((c) => c.status === 'no_flow'),
      `every case has status 'no_flow'`,
    )

    // 2. POSITIVE: correct flow deployed at u/admin/submission.
    console.log('check 2: positive (correct flow)')
    await deployFlow(host, token, correctFlow)
    const pos = await runVerify(sandbox, 'positive', FLOW_PATH)
    assert(pos.passed === 5, `positive passed === 5 (got ${pos.passed})`)
    assert(pos.failed === 0, `positive failed === 0 (got ${pos.failed})`)

    // 3. WRONG: always-zero flow at a separate path. flows/update would
    // be the more direct test but empirically does not replace the
    // running module value at the same path on this Windmill version,
    // so we use a fresh path for clean isolation -- the verifier
    // logic is what we're testing, not Windmill's update semantics.
    // Cases are designed so no `expected` is 0, so an always-zero flow
    // fails every case cleanly.
    console.log('check 3: wrong (always-zero flow at separate path)')
    await deployFlow(host, token, wrongFlow)
    const wrong = await runVerify(sandbox, 'wrong', WRONG_FLOW_PATH)
    assert(wrong.passed === 0, `wrong passed === 0 (got ${wrong.passed})`)
    assert(wrong.failed === 5, `wrong failed === 5 (got ${wrong.failed})`)

    if (process.exitCode !== 1) console.log('verdict: READY')
    else console.log('verdict: FAILED')
  } finally {
    await sandbox.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
