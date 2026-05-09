import { Template, waitForURL } from 'e2b'

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

// Language runtimes for user-script execution inside Windmill flows.
// Versions PINNED to what windmill v1.699.0's official Dockerfile installs
// (verified against
// https://raw.githubusercontent.com/windmill-labs/windmill/v1.699.0/Dockerfile).
// Windmill's worker calls these at hardcoded paths -- /usr/bin/bun and
// /usr/bin/deno are the literal lookups; uv is PATH-resolved. Mismatches
// produce confusing "Executable not found on worker" runtime errors that
// only surface when a real flow runs, so we pin + verify version + SHA at
// build time.
const BUN_VERSION = '1.3.10'
const BUN_SHA256 = 'f57bc0187e39623de716ba3a389fda5486b2d7be7131a980ba54dc7b733d2e08'
const DENO_VERSION = '2.2.1'
const DENO_SHA256 = '2de60cc65349bb4f97636de26b32b1ff71e79a0e127f2e6b7397b1d89aa76ea4'
const UV_VERSION = '0.9.24'
const UV_SHA256 = 'fb13ad85106da6b21dd16613afca910994446fe94a78ee0b5bed9c75cd066078'

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

  // wb-verify: bench-side verifier baked into the image so challenge packs
  // can run an agent-deployed Windmill flow against a JSON cases file and
  // get a single-line JSON summary back. Plain-Node ESM (no deps), so we
  // ship the source as-is and wrap it in a shell shim at
  // /usr/local/bin/wb-verify. Cases live under /usr/share/wb/cases/ so
  // pack YAML can reference them by absolute path. See verifier/wb-verify.mjs
  // for the output contract — it's chosen to satisfy AgentClash's
  // code_execution validator parser (JSON path, not exit-code path).
  .copy('verifier/wb-verify.mjs', '/usr/local/lib/wb-verify.mjs', {
    user: 'root',
    mode: 0o644,
  })
  .runCmd('mkdir -p /usr/share/wb/cases')
  .copy('verifier/cases/sum-two-numbers.json', '/usr/share/wb/cases/sum-two-numbers.json', {
    user: 'root',
    mode: 0o644,
  })
  .copy('verifier/cases/h1-count-user-events.json', '/usr/share/wb/cases/h1-count-user-events.json', {
    user: 'root',
    mode: 0o644,
  })
  // Shim shell-script keeps the pack YAML concise (`wb-verify ...` rather
  // than `node /usr/local/lib/wb-verify.mjs ...`). printf preserves the
  // exact bytes; using echo here would be brittle across /bin/sh
  // implementations.
  .runCmd(
    'printf \'#!/bin/sh\\nexec node /usr/local/lib/wb-verify.mjs "$@"\\n\' > /usr/local/bin/wb-verify ' +
      '&& chmod 0755 /usr/local/bin/wb-verify',
  )

  // Language runtimes for Windmill user scripts. Each is pinned to the
  // exact version Windmill v1.699.0's official Dockerfile installs and
  // SHA256-verified at build time so a republished upstream zip fails
  // the build instead of silently swapping the binary. Paths match what
  // Windmill's worker looks up at runtime.

  // unzip — required to extract the bun + deno release zips. Installed as
  // its own layer so adding it does not invalidate the larger apt block
  // upstream.
  .runCmd(
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unzip ' +
      '&& rm -rf /var/lib/apt/lists/*',
  )

  // bun 1.3.10 → /usr/bin/bun (Windmill expects exactly this absolute
  // path). Empirically: without this, bun-language flows fail with
  // "Executable /usr/bin/bun not found on worker" -- the agent never
  // sees a useful error, just a runtime_error in the verifier.
  .runCmd(
    `curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip -o /tmp/bun.zip ` +
      `&& echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - ` +
      `&& unzip -q -j /tmp/bun.zip -d /tmp ` +
      `&& install -m 0755 /tmp/bun /usr/bin/bun ` +
      `&& rm -f /tmp/bun.zip /tmp/bun ` +
      `&& bun --version | grep -q "^${BUN_VERSION}$"`,
  )

  // deno 2.2.1 → /usr/bin/deno (same hardcoded-path story as bun).
  .runCmd(
    `curl -fsSL https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip ` +
      `&& echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - ` +
      `&& unzip -q -j /tmp/deno.zip -d /tmp ` +
      `&& install -m 0755 /tmp/deno /usr/bin/deno ` +
      `&& rm -f /tmp/deno.zip /tmp/deno ` +
      `&& deno --version | grep -q "^deno ${DENO_VERSION}"`,
  )

  // uv 0.9.24 → /usr/local/bin/uv. Windmill's python3 flows shell out
  // to uv for dependency resolution; without uv they error with
  // "Executable uv not found on worker".
  //
  // We download the release tarball directly and verify its SHA256
  // against astral-sh/uv's upstream-published .sha256 file. The
  // upstream installer script (uv-installer.sh) has a checksum
  // mechanism but ships v0.9.24 with NO embedded checksum value, so
  // running it falls through a "no checksums to verify" branch -- it
  // is not actually integrity-checked. Direct download + SHA verify
  // matches the discipline used for bun, deno, and the windmill
  // server binary in this template.
  .runCmd(
    `curl -fsSL https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz -o /tmp/uv.tar.gz ` +
      `&& echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - ` +
      `&& tar -xzf /tmp/uv.tar.gz -C /tmp uv-x86_64-unknown-linux-gnu/uv ` +
      `&& install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /usr/local/bin/uv ` +
      `&& rm -rf /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu ` +
      `&& uv --version | grep -q "^uv ${UV_VERSION}"`,
  )

  // Workspace is where benchmark runs do their work — mirrors the convention
  // AgentClash already uses inside its sandboxes. Subsequent PRs copy the
  // hub snapshot and workspace seed into here.
  .runCmd('mkdir -p /workspace')
  .setWorkdir('/workspace')

  // Boot script. Lives at /usr/local/bin/boot.sh, mode 0755, owned root.
  // The script itself documents what it does and why; see e2b-template/boot.sh.
  .copy('boot.sh', '/usr/local/bin/boot.sh', { user: 'root', mode: 0o755 })

  // Start command + readiness gate.
  //
  //   The start command runs ONCE during Template.build(); E2B then waits for
  //   the readiness check to succeed before snapshotting the live VM. Per the
  //   snapshot-state probe (probes/snapshot-state/), the snapshot captures
  //   both process state AND filesystem state, so spawned sandboxes restore
  //   with Postgres running, Windmill running, and migrations already applied.
  //
  //   waitForURL polls Windmill's official healthcheck endpoint
  //   (http://localhost:8000/api/version, the same one Windmill's own GitHub
  //   Actions use) until it returns 200. Windmill won't open the API port
  //   until the embedded SvelteKit frontend, the Axum router, and the worker
  //   thread are all up — by the time waitForURL succeeds, the system is
  //   genuinely ready.
  .setStartCmd(
    '/usr/local/bin/boot.sh',
    waitForURL('http://localhost:8000/api/version'),
  )
