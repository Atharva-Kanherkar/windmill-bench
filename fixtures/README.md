# fixtures

Frozen state that every task runs against. Determinism comes from these files.

## Contents

- `hub-snapshot.json` — frozen mirror of `hub.windmill.dev`'s public script set
  at a specific point in time. Tasks that mention "search the Hub for a Stripe
  refund script" only resolve against this snapshot, never the live Hub. Bumped
  via a refresh script (TBD), version-stamped in the pack manifest.
- `workspace-seed.json` — the pre-existing scripts that live in the seeded
  workspace before any task runs. Lets us write tasks like "reuse the existing
  `f/email/send` script" with a deterministic answer.
- `mocks/` — stub HTTP servers / canned responses for external services
  (Stripe, Slack, HubSpot, Typeform, etc). Tasks reference services by name;
  the mock layer intercepts and returns canned data. No network egress in
  scoring runs.

## Why this matters

Tasks must be deterministic across:
- Time (Hub content changes upstream — frozen snapshot insulates us).
- Network (no live API calls — mocks return canned data).
- Workspace state (seeded workspace is reset per sandbox).

If any task's score depends on something outside this directory, it's a bug.
