import { Sandbox } from 'e2b'

// Snapshot-state probe runner.
//
// Spawns a fresh sandbox from `windmill-bench-probe-snapshot` (built by
// `npm run probe:snapshot:build`), then verifies three independent things:
//
//   1. Build-phase filesystem write   — /probe/build-time.txt (control)
//   2. Start-phase filesystem write   — /probe/start-time.txt
//   3. Start-phase process tree alive — `sleep infinity` (the long-running
//                                        process started by setStartCmd's
//                                        start command before the ready
//                                        signal)
//
// (3) was added after a PR review caught that (1) and (2) only verify
// filesystem persistence; nothing about the original probe demonstrated
// that the start command's *process* survived restoration. PR 6's claim
// "Windmill running on cold-start" requires (3), so the probe now checks
// it directly.
//
// Run via `npm run probe:snapshot:run` after building the probe template.

const TEMPLATE = 'windmill-bench-probe-snapshot'

async function readProbeFile(sandbox: Sandbox, path: string): Promise<string | null> {
  const result = await sandbox.commands.run(`cat ${path} 2>/dev/null || echo __MISSING__`)
  const trimmed = result.stdout.trim()
  if (trimmed === '__MISSING__' || trimmed === '') return null
  return trimmed
}

async function checkSleepProcessAlive(sandbox: Sandbox): Promise<boolean> {
  // pgrep -fa matches against the full command line, so we find the specific
  // `sleep infinity` invocation from the probe template's start command and
  // not, say, an unrelated short-lived sleep. Exit 0 means at least one match.
  const result = await sandbox.commands.run('pgrep -fa "sleep infinity" || true')
  return result.stdout.includes('sleep infinity')
}

async function main() {
  console.log(`spawning sandbox from template "${TEMPLATE}"...`)
  const sandbox = await Sandbox.create(TEMPLATE)
  try {
    const buildTime = await readProbeFile(sandbox, '/probe/build-time.txt')
    const startTime = await readProbeFile(sandbox, '/probe/start-time.txt')
    const startProcessAlive = await checkSleepProcessAlive(sandbox)

    console.log('')
    console.log('  build-time write present:    ', buildTime !== null)
    console.log('  build-time stamp:            ', buildTime ?? '(missing)')
    console.log('  start-time write present:    ', startTime !== null)
    console.log('  start-time stamp:            ', startTime ?? '(missing)')
    console.log('  start-cmd process alive:     ', startProcessAlive)
    console.log('')

    // Composite verdict across three axes.
    //   FS+PROC : best case, snapshot captures filesystem AND processes.
    //   FS_ONLY : files survive but processes don't. PR 6's claim breaks;
    //             boot.sh would need to be re-invoked at sandbox spawn.
    //   PROBE_BROKEN : build-time control failed; investigate before
    //                  drawing any conclusion.
    let verdict: 'FS_AND_PROCESS_PERSISTED' | 'FS_ONLY' | 'PROBE_BROKEN'
    if (buildTime === null) verdict = 'PROBE_BROKEN'
    else if (startTime === null) verdict = 'PROBE_BROKEN'
    else if (startProcessAlive) verdict = 'FS_AND_PROCESS_PERSISTED'
    else verdict = 'FS_ONLY'

    console.log(`VERDICT: ${verdict}`)
    console.log('')
    switch (verdict) {
      case 'FS_AND_PROCESS_PERSISTED':
        console.log('Implication: the snapshot captures both filesystem and')
        console.log('process state. The pre-migration trick is fully viable —')
        console.log('boot.sh runs once at template build, leaves Windmill +')
        console.log('Postgres running, and spawned sandboxes restore with')
        console.log('Windmill already serving. Cold-start ~3s.')
        break
      case 'FS_ONLY':
        console.log('Implication: snapshot captures filesystem but NOT')
        console.log('processes. PR 6 boot.sh approach breaks — sandboxes')
        console.log('would restore with a migrated DB on disk but no live')
        console.log('Windmill or Postgres. boot.sh needs to be invoked at')
        console.log('sandbox spawn (via the harness, not via setStartCmd) to')
        console.log('start the processes against the migrated DB.')
        break
      case 'PROBE_BROKEN':
        console.log('Implication: a fundamental assumption is violated. The')
        console.log('build-time and start-time files should both always be')
        console.log('present. Investigate the probe template before drawing')
        console.log('any conclusion about persistence semantics.')
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
