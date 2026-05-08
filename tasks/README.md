# tasks

The task corpus. Each task is one directory.

## Layout

```
tasks/
├── easy-01-stripe-refund/
│   ├── prompt.md         # Natural-language spec given to the agent
│   ├── reference.flow.json   # Known-good flow (the "answer key")
│   ├── oracle.json       # Expected runtime output for grading
│   └── fixtures/         # Per-task stubs (mock API responses, etc)
├── medium-01-...
└── hard-01-...
```

## Naming

`{difficulty}-{seq}-{shortname}` — e.g. `easy-01-stripe-refund`,
`medium-03-typeform-routing`. Lowercase, kebab-case.

## Difficulty tiers (v1)

- **easy** — 2-step linear flow, no branching, no Hub lookup.
- **medium** — 3-step flow with branchone, requires picking the right Hub script
  from a small set in the frozen snapshot.
- **hard** — 4–5 step flow with parallelism or loops, resource-typed inputs,
  must reuse at least one pre-existing script from the seeded workspace.

## Authoring rule

Every reference flow must score 100% against the rubric in `../scoring/`. If a
reference can't pass its own oracle, the rubric or the oracle is wrong — fix
that first.
