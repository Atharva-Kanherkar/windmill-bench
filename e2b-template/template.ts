import { Template } from 'e2b'

// Base template for windmill-bench sandboxes.
//
// Architecture: Windmill runs as a *binary* alongside a local Postgres inside
// the sandbox — no Docker-in-Docker, no compose. Mirrors the upstream
// ephemeral pattern in windmill-labs/windmill `ephemeral-backends/spawn.ts`.
// MODE=standalone runs server + worker + embedded frontend in one process;
// DISABLE_NSJAIL=true (Windmill's default) is appropriate because the E2B
// sandbox itself is the trust boundary.
//
// Layered build (each piece adds to the snapshot):
//   1. system essentials (this PR's existing apt block)
//   2. PostgreSQL 16                                  ← this PR
//   3. Node 20 + wmill CLI                            ← this PR
//   4. Windmill server binary v1.699.0 (SHA256-pinned) ← this PR
//   5. boot.sh + setStartCmd wiring                    ← later PR
//   6. language runtimes for user-script execution     ← later PR, scoped
//      to actual task corpus needs (avoid bloating the image with runtimes
//      the benchmark doesn't exercise).
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

  // PostgreSQL 16. Ubuntu 24.04 ships postgresql-16 in its default archive,
  // so no third-party apt repo is needed. The cluster is *not* started or
  // initialized here — that's the boot script's responsibility (later PR).
  // We only want the binaries on disk in the snapshot.
  .runCmd(
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ' +
      'postgresql-16 postgresql-contrib-16 ' +
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
