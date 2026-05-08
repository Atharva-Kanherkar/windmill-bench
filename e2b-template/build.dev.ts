import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  await Template.build(template, 'windmill-bench-dev', {
    onBuildLogs: defaultBuildLogger(),
    // Postgres + Windmill (server + worker + embedded frontend) plus the
    // migration apply step needs more than the 1 GiB E2B default. 2 GiB
    // gives comfortable headroom; bump higher if migrations OOM during
    // future Windmill version upgrades.
    cpuCount: 2,
    memoryMB: 2048,
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
