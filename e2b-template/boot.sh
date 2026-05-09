#!/usr/bin/env bash
# Boots Windmill + Postgres inside the E2B sandbox.
#
# This script runs ONCE at template-build time, as the first arg of the
# template's setStartCmd. After it launches Windmill in the background and
# `wait`s, E2B's setStartCmd ready check (waitForURL on /api/version) blocks
# until Windmill is healthy, then snapshots the live VM. Per the snapshot-state
# probe (e2b-template/probes/snapshot-state/), the snapshot captures both
# process state AND filesystem state, so spawned sandboxes restore with
# Windmill already running on a migrated DB.
#
# Idempotent in the sense that the postgres-cluster init + database creation
# are guarded — defense in depth in case this ever runs twice. Not designed
# to be invoked manually after the snapshot.

set -euo pipefail

LOG_FILE="/var/log/windmill.log"
mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"  # truncate; build-time logs go in fresh

step() { echo "[boot] $*"; }

# ---------------------------------------------------------------------------
# 1. Initialize the postgresql-16 cluster if its data dir is empty.
#    Ubuntu's pg_createcluster wires up postgresql.conf, pg_hba.conf, and
#    the data dir under /var/lib/postgresql/16/main with sensible defaults
#    (peer auth on the unix socket, scram-sha-256 on TCP localhost).
# ---------------------------------------------------------------------------
PG_DATA='/var/lib/postgresql/16/main'
if [ ! -f "$PG_DATA/PG_VERSION" ]; then
  step 'initializing postgresql-16 cluster (main)'
  pg_createcluster 16 main >/dev/null
fi

# ---------------------------------------------------------------------------
# 2a. Ensure the unix-socket directory exists with correct ownership.
#     postgresql-common's postinst normally creates /var/run/postgresql,
#     but /var/run is a tmpfs in many container-like environments and the
#     directory can vanish between layers / between snapshot restores.
#     Postgres needs this for its default unix socket; failing to find it
#     produces a confusing "directory does not exist" error half-way
#     through startup. Idempotent — safe to run on every boot.
# ---------------------------------------------------------------------------
mkdir -p /var/run/postgresql
chown postgres:postgres /var/run/postgresql
chmod 2775 /var/run/postgresql

# ---------------------------------------------------------------------------
# 2. Start the cluster.
#
#    --skip-systemctl-redirect is REQUIRED here. Debian/Ubuntu's
#    pg_ctlcluster wrapper auto-redirects to `systemctl start
#    postgresql@16-main` whenever systemd is *installed* on the system —
#    not whenever systemd is actually running as PID 1. The E2B build VM
#    has systemd installed (it's a stock ubuntu:24.04 layer) but no
#    systemd init, so the redirect tries to talk to a phantom systemd
#    and pg_ctlcluster exits non-zero.
#
#    The flag tells pg_ctlcluster to call `pg_ctl` directly without the
#    systemd detour. This is the Debian-blessed path for containers and
#    is documented in pg_ctlcluster(8). DO NOT remove this flag — the
#    failure mode is non-obvious ("Job for postgresql@16-main.service
#    failed because the service did not take the steps required by its
#    unit configuration"), so a future reader who removes it for
#    aesthetics gets to debug the same bug we already debugged.
# ---------------------------------------------------------------------------
step 'starting postgresql-16 cluster'
pg_ctlcluster 16 main start --skip-systemctl-redirect

# ---------------------------------------------------------------------------
# 3. Wait for Postgres to accept connections. Bounded poll (~15s max) so a
#    misconfigured cluster fails the build instead of hanging forever.
# ---------------------------------------------------------------------------
step 'waiting for postgres to accept connections'
for _ in $(seq 1 30); do
  if pg_isready -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
pg_isready -h 127.0.0.1 -p 5432 -U postgres >/dev/null

# ---------------------------------------------------------------------------
# 4. Set the postgres user password and create the windmill database.
#    Uses runuser (not sudo, which is not installed) to switch to the
#    postgres OS user, which has peer-auth access via the unix socket.
#
#    Both operations are idempotent — ALTER USER WITH PASSWORD is fine to
#    re-run, and the CREATE DATABASE is gated by a NOT EXISTS check via
#    psql's \gexec meta-command.
# ---------------------------------------------------------------------------
step 'configuring postgres user and creating windmill database'
runuser -u postgres -- psql -v ON_ERROR_STOP=on <<'SQL'
ALTER USER postgres WITH PASSWORD 'changeme';
SELECT 'CREATE DATABASE windmill'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'windmill')\gexec
SQL

# ---------------------------------------------------------------------------
# 5. Windmill environment.
#
#    DATABASE_URL  — TCP, password auth (scram-sha-256 in the default
#                    pg_hba.conf for 127.0.0.1).
#    MODE          — standalone runs server + worker + embedded SvelteKit
#                    frontend in one process.
#    DISABLE_NSJAIL — Windmill's user-script isolation is redundant when
#                    the E2B sandbox is the trust boundary.
#    JSON_FMT      — structured logs make this easier to parse from the
#                    benchmark runner once it exists.
# ---------------------------------------------------------------------------
export DATABASE_URL='postgres://postgres:changeme@127.0.0.1:5432/windmill?sslmode=disable'
export MODE='standalone'
export PORT=8000
export BASE_URL='http://127.0.0.1:8000'
export NUM_WORKERS=1
export DISABLE_NSJAIL=true
export RUST_LOG=info
export JSON_FMT=true

# ---------------------------------------------------------------------------
# 6. Launch Windmill in the background. Output is teed to both stdout (so it
#    appears in the build log under the start command) and the on-disk log
#    file (for post-mortem inspection from inside a spawned sandbox).
#
#    Windmill runs migrations automatically on its first connection to a
#    fresh DB (per windmill-labs/windmill backend/src/main.rs:820-826).
# ---------------------------------------------------------------------------
step 'starting windmill (MODE=standalone, PORT=8000)'
/usr/local/bin/windmill 2>&1 | tee -a "$LOG_FILE" &

# ---------------------------------------------------------------------------
# 7. Block on children. Keeps this script alive so E2B's snapshot captures
#    Windmill (and its parent shell) as a running process tree.
#
#    setStartCmd's ready command — waitForURL('http://localhost:8000/api/version')
#    — does the actual gating from E2B's side. boot.sh's job is just to
#    launch and stay alive; it doesn't curl anything itself.
# ---------------------------------------------------------------------------
wait
