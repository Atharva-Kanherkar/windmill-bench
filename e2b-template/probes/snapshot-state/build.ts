import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  await Template.build(template, 'windmill-bench-probe-snapshot', {
    onBuildLogs: defaultBuildLogger(),
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
