import { Sandbox } from 'e2b'

// One-off probe (kept in-tree for follow-ups when adding/removing
// runtimes): deploys a 1-step sum flow per language, runs it with
// {a:2, b:3}, and reports OK / runtime error per language. Drop or
// archive once we trust the image.

const TEMPLATE = 'windmill-bench-dev'
const WORKSPACE = 'admins'

interface LangCase {
  label: string
  lang: string
  content: string
}

const cases: LangCase[] = [
  {
    label: 'bash',
    lang: 'bash',
    content: 'a="$1"\nb="$2"\necho $((a + b))\n',
  },
  {
    label: 'bun',
    lang: 'bun',
    content: 'export async function main(a: number, b: number) {\n  return a + b\n}\n',
  },
  {
    label: 'deno',
    lang: 'deno',
    content: 'export async function main(a: number, b: number) {\n  return a + b\n}\n',
  },
  {
    label: 'python3',
    lang: 'python3',
    content: 'def main(a: float, b: float):\n    return a + b\n',
  },
  {
    label: 'nativets',
    lang: 'nativets',
    content: 'export async function main(a: number, b: number) {\n  return a + b\n}\n',
  },
]

async function login(host: string): Promise<string> {
  const r = await fetch(`https://${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@windmill.dev', password: 'changeme' }),
  })
  if (!r.ok) throw new Error(`login HTTP ${r.status}`)
  return (await r.text()).trim().replace(/^"/, '').replace(/"$/, '')
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
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error('windmill /api/version did not become ready within 30s')
}

async function tryLang(host: string, token: string, c: LangCase): Promise<string> {
  const path = `u/admin/probe_${c.lang}`
  const flow = {
    path,
    summary: `probe ${c.lang}`,
    value: {
      modules: [
        {
          id: 'm',
          value: {
            type: 'rawscript',
            language: c.lang,
            content: c.content,
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
  const create = await fetch(`https://${host}/api/w/${WORKSPACE}/flows/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(flow),
  })
  if (!create.ok) return `deploy failed ${create.status}: ${(await create.text()).slice(0, 200)}`

  const startedAt = Date.now()
  const enq = await fetch(`https://${host}/api/w/${WORKSPACE}/jobs/run/f/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ a: 2, b: 3 }),
  })
  if (!enq.ok) return `enqueue failed ${enq.status}`
  const jobId = (await enq.text()).trim().replace(/^"/, '').replace(/"$/, '')

  for (let i = 0; i < 200; i++) {
    const r = await fetch(`https://${host}/api/w/${WORKSPACE}/jobs_u/completed/get_result_maybe/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const j = await r.json()
    if (j.completed) {
      const elapsed = Date.now() - startedAt
      if (j.success) return `ok (${elapsed}ms): result=${JSON.stringify(j.result)}`
      const err = j.result?.error?.message ?? JSON.stringify(j.result)
      return `runtime_error (${elapsed}ms): ${String(err).slice(0, 200)}`
    }
    await new Promise((res) => setTimeout(res, 200))
  }
  return 'timeout'
}

async function main() {
  console.log(`spawning sandbox from "${TEMPLATE}"...`)
  const sandbox = await Sandbox.create(TEMPLATE)
  try {
    const probe = await sandbox.commands.run(
      'echo bun=$(bun --version 2>&1) deno=$(deno --version 2>&1 | head -1) uv=$(uv --version 2>&1) python3=$(python3 --version 2>&1)',
    )
    console.log(probe.stdout.trim())
    const host = sandbox.getHost(8000)
    await pollApiReady(host)
    const token = await login(host)
    for (const c of cases) {
      const result = await tryLang(host, token, c)
      console.log(`[${c.label.padEnd(10)}] ${result}`)
    }
  } finally {
    await sandbox.kill()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
