import { Template } from 'e2b'

// Base template for windmill-bench sandboxes. This file holds the system-level
// composition only: base image, shell utilities, workdir. PR 3 adds Docker
// engine + Windmill + Postgres + the docker-compose orchestration. PR 3+ add
// the wmill CLI and the boot script. Keep this file focused on what is
// universally needed regardless of what's running on top.
export const template = Template()
  .fromImage('ubuntu:24.04')
  .setUser('root')
  .setWorkdir('/')

  // Shell + transport essentials. Single apt-get block to keep image layers
  // tight. Lists are cleaned up so they don't bloat the snapshot.
  .runCmd(
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ' +
      'bash ca-certificates coreutils curl wget git jq ' +
      'gnupg software-properties-common ' +
      '&& rm -rf /var/lib/apt/lists/*',
  )

  // Workspace is where benchmark runs do their work — mirrors the convention
  // AgentClash already uses inside its sandboxes. Subsequent PRs copy the
  // hub snapshot, workspace seed, and boot script into here.
  .runCmd('mkdir -p /workspace')
  .setWorkdir('/workspace')

  // Placeholder start command. PR 3 replaces this with a call to boot.sh
  // that brings Windmill + Postgres up and signals READY on stdout.
  .setStartCmd('sleep infinity', 'sleep 5')
