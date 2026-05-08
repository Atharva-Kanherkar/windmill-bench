import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  await Template.build(template, 'windmill-bench-prod', {
    onBuildLogs: defaultBuildLogger(),
    // Same resource footprint as dev: Postgres + Windmill standalone plus
    // migration apply at template-build time needs ~2 GiB to avoid OOM.
    cpuCount: 2,
    memoryMB: 2048,
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
