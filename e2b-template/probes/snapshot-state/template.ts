import { Template, waitForFile } from 'e2b'

// Snapshot-state probe template.
//
// Two filesystem writes, each timestamped, exercising the two phases
// whose persistence we want to characterize:
//
//   1. .runCmd (build phase) — produces an image layer, expected to be
//      in the snapshot regardless of what E2B does. This is the control.
//   2. setStartCmd's start command (snapshot phase) — runs once during
//      Template.build(), waits for the ready signal, then E2B snapshots
//      the live VM. The question is whether mkdir/echo/touch operations
//      this command performs are captured.
//
// Ready check is `waitForFile('/probe/ready-marker')`, so the snapshot
// is only taken AFTER the start command has done its writes.
export const template = Template()
  .fromImage('ubuntu:24.04')
  .setUser('root')
  .setWorkdir('/')

  // Minimal essentials. coreutils gives us `date` and `mkdir`; ca-certificates
  // is harmless and matches what the main template installs so the probe
  // image is a closer approximation.
  .runCmd(
    'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ' +
      'bash ca-certificates coreutils ' +
      '&& rm -rf /var/lib/apt/lists/*',
  )

  // Build-phase write. Should always be present in spawned sandboxes.
  .runCmd(
    'mkdir -p /probe ' +
      '&& date -u +%FT%TZ > /probe/build-time.txt ' +
      '&& cat /probe/build-time.txt',
  )

  // Start-phase write + ready marker. The shell runs once during
  // Template.build(), writes the timestamp, touches the ready marker,
  // then sleeps so the snapshot captures a live process.
  .setStartCmd(
    "bash -c 'mkdir -p /probe " +
      "&& date -u +%FT%TZ > /probe/start-time.txt " +
      "&& touch /probe/ready-marker " +
      "&& sleep infinity'",
    waitForFile('/probe/ready-marker'),
  )
