# probes

One-off empirical probes for E2B template behavior. Each probe answers a
single question that informs how the main `e2b-template/template.ts` is
structured.

A probe is **not** a long-lived test; it's a small disposable experiment
that produces a finding. The finding gets recorded in the probe's own
README, and the probe itself can stay around for re-verification when E2B
or the underlying base image changes.

Current probes:

- [`snapshot-state/`](./snapshot-state/) — does an E2B snapshot capture
  filesystem writes made by the start command before the ready signal?
  (Determines whether `e2b-template/template.ts` can pre-migrate Postgres
  at template-build time.)

## Layout convention

```
probes/
└── <question-slug>/
    ├── README.md       what we're asking, scoring matrix, recorded result
    ├── template.ts     the probe template (E2B Template builder)
    ├── build.ts        Template.build() entry point
    └── run.ts          spawns a sandbox and reports the finding
```

Each probe wires its own `npm run probe:<slug>:build` and
`npm run probe:<slug>:run` scripts in the parent `package.json`.
