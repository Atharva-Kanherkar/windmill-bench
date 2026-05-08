import { Template } from 'e2b'

// Pinned Windmill release. Bump in a dedicated commit when upgrading;
// the URL, the SHA256, and the matching wmill CLI npm version must all
// be updated together. SHA256 is verified at template-build time against
// the downloaded binary; mismatch fails the build so we catch supply-chain
// compromise or accidental upstream rebuild. The CLI npm package tracks
// the same version stream as the server binary.
const WMILL_VERSION = 'v1.699.0'
const WMILL_NPM_VERSION = '1.699.0' // wmill-cli on npm uses no leading 'v'
const WMILL_BINARY_URL = `https://github.com/windmill-labs/windmill/releases/download/${WMILL_VERSION}/windmill-amd64`
const WMILL_BINARY_SHA256 = '8f89894f171879fad6a2e5d40fee0e3487a3f111c0020d8747735d6cf14b03e9'

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
  // tight. Lists are cleaned up so they don't bloat the snapshot. `file` is
  // included because the Windmill binary install verifies the result with
  // `file /usr/local/bin/windmill | grep -q "ELF 64-bit"`, and ubuntu:24.04
  // does not ship `file`/libmagic1 in its base layer.
  .runCmd(
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ' +
      'bash ca-certificates coreutils curl wget git jq file ' +
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

  // Node 20 via the official NodeSource apt repo. Needed for the wmill CLI
  // (distributed only via npm; no standalone single-file binary). We pin to
  // major version 20 LTS — same as AgentClash's template — which matches
  // what windmill-cli's package.json expects and avoids surprise updates
  // from the NodeSource setup script.
  .runCmd(
    'curl -fsSL https://deb.nodesource.com/setup_20.x | bash - ' +
      '&& apt-get install -y --no-install-recommends nodejs ' +
      '&& rm -rf /var/lib/apt/lists/*',
  )

  // wmill CLI from npm, pinned to the exact version that matches the server
  // binary. Without an explicit version, `npm install -g windmill-cli` would
  // pull whatever `latest` is at build time, drifting away from the pinned
  // server binary across rebuilds — bad for benchmark reproducibility. The
  // trailing version probe still fails the build loudly on broken installs.
  .runCmd(`npm install -g windmill-cli@${WMILL_NPM_VERSION} && wmill --version`)

  // Windmill server binary. Pinned by version + SHA256. Steps:
  //   1. Download to /tmp.
  //   2. Verify SHA256 — fails the whole .runCmd on mismatch.
  //   3. Atomically install into /usr/local/bin with mode 0755.
  //   4. Sanity-check the installed file is a Linux x86-64 ELF binary
  //      (cheap probe; doesn't try to invoke `windmill --help` because the
  //      binary may attempt to read DATABASE_URL even for --help and we
  //      don't want a build-time failure for that reason).
  .runCmd(
    `curl -fsSL ${WMILL_BINARY_URL} -o /tmp/windmill.bin ` +
      `&& echo "${WMILL_BINARY_SHA256}  /tmp/windmill.bin" | sha256sum -c - ` +
      `&& install -m 0755 /tmp/windmill.bin /usr/local/bin/windmill ` +
      `&& rm -f /tmp/windmill.bin ` +
      `&& file /usr/local/bin/windmill | grep -q "ELF 64-bit"`,
  )

  // Workspace is where benchmark runs do their work — mirrors the convention
  // AgentClash already uses inside its sandboxes. Subsequent PRs copy the
  // hub snapshot, workspace seed, and boot script into here.
  .runCmd('mkdir -p /workspace')
  .setWorkdir('/workspace')

  // Placeholder start command. A later PR replaces this with a call to
  // boot.sh that starts Postgres + the Windmill binary in MODE=standalone,
  // then waits on `waitForURL('http://localhost:8000/api/version')` for
  // readiness. Keeping the placeholder so this template is buildable today
  // and the binary install in this PR can be verified by spawning a sandbox
  // and exec-ing into it.
  .setStartCmd('sleep infinity', 'sleep 5')
