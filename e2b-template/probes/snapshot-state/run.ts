import { Sandbox } from 'e2b'

// Snapshot-state probe runner.
//
// Spawns a fresh sandbox from `windmill-bench-probe-snapshot` (built by
// `npm run probe:snapshot:build`), reads the two probe files, and reports
// a verdict. See ./README.md for the scoring matrix.
//
// Run via `npm run probe:snapshot:run` after building the probe template.

const TEMPLATE = 'windmill-bench-probe-snapshot'

async function readProbeFile(sandbox: Sandbox, path: string): Promise<string | null> {
  const result = await sandbox.commands.run(`cat ${path} 2>/dev/null || echo __MISSING__`)
  const trimmed = result.stdout.trim()
  if (trimmed === '__MISSING__' || trimmed === '') return null
  return trimmed
}

async function main() {
  console.log(`spawning sandbox from template "${TEMPLATE}"...`)
  const sandbox = await Sandbox.create(TEMPLATE)
  try {
    const buildTime = await readProbeFile(sandbox, '/probe/build-time.txt')
    const startTime = await readProbeFile(sandbox, '/probe/start-time.txt')

    console.log('')
    console.log('  build-time write present:', buildTime !== null)
    console.log('  build-time stamp:        ', buildTime ?? '(missing)')
    console.log('  start-time write present:', startTime !== null)
    console.log('  start-time stamp:        ', startTime ?? '(missing)')
    console.log('')

    let verdict: 'START_PERSISTED' | 'BUILD_ONLY' | 'PROBE_BROKEN'
    if (buildTime !== null && startTime !== null) verdict = 'START_PERSISTED'
    else if (buildTime !== null && startTime === null) verdict = 'BUILD_ONLY'
    else verdict = 'PROBE_BROKEN'

    console.log(`VERDICT: ${verdict}`)
    console.log('')
    switch (verdict) {
      case 'START_PERSISTED':
        console.log('Implication: pre-migration trick is viable. The main')
        console.log('template can run windmill at build time so all Postgres')
        console.log('migrations apply before the snapshot. Cold-start ~3s.')
        break
      case 'BUILD_ONLY':
        console.log('Implication: snapshot only captures build-phase layers.')
        console.log('PR 5 boot script must run migrations at sandbox-boot')
        console.log('time. Cold-start ~10-15s.')
        break
      case 'PROBE_BROKEN':
        console.log('Implication: a fundamental assumption is violated.')
        console.log('The build-time write should always be present (it is')
        console.log('an image layer). Investigate the probe template before')
        console.log('drawing any conclusion about start-phase persistence.')
        break
    }

    // Set exit code rather than calling process.exit(): process.exit()
    // terminates the runtime synchronously and skips the `finally` block,
    // which would orphan the sandbox. Returning normally lets the finally
    // run sandbox.kill() before Node drains the event loop and exits with
    // the code we set here.
    process.exitCode = verdict === 'PROBE_BROKEN' ? 1 : 0
  } finally {
    await sandbox.kill()
  }
}

main().catch((err) => {
  console.error(err)
  // Safe to use process.exit here: this catch only runs if main()'s promise
  // rejected, which means the try/finally inside main has already settled
  // (the finally block awaits sandbox.kill before propagating). At this
  // point the sandbox is already torn down.
  process.exit(1)
})
