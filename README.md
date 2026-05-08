# windmill-bench

> Public benchmark for AI agents generating [Windmill](https://www.windmill.dev/) workflows — execution-graded.

**Status:** Pre-v0. Scaffolding only. Not yet runnable.

## What this is

A challenge pack that evaluates how well AI agents — frontier hosted models and
open-weights models alike — generate Windmill flows from natural-language
specifications.

Generated flows are graded by **actually executing them inside a sandboxed Windmill
instance** and comparing the runtime output against a reference oracle — not by
static analysis or LLM-judge alone.

## Why

Existing public benchmarks for code-generating agents either:

- Test single-function generation (HumanEval, BigCodeBench, LiveCodeBench), or
- Test agent task-completion in API/UI environments (AppWorld, τ-bench), or
- Generate operator graphs or workflow plans and evaluate them on downstream
  task benchmarks rather than against a workflow engine (WorFBench, AFLOW —
  the latter uses execution feedback over operator graphs, but the execution
  target is task suites like HumanEval/GSM8K, not a workflow runtime), or
- Generate workflow artifacts for a runtime (Airflow DAGs in Prompt2DAG) and
  grade with a mix of static checks and isolated execution against a stub
  scheduler.

None of them grade generated workflows by running them inside a **real,
open-source, production workflow engine** — with workspace state, typed
resources, secret management, a hub of third-party modules, and multi-language
script execution all in play. Windmill is the right reference engine because
it's open-source, exposes that full surface (workspace, resources, hub, the
`wmill` CLI), and covers scripts + flows + apps under one runtime.

## Scope (v1)

- **Target:** flow generation only (single-shot, no multi-turn debugging).
- **Difficulty tiers:** easy (2-step linear), medium (3-step with branching and
  hub-script lookup), hard (4-step with parallelism or loops, resource-typed
  inputs).
- **Grading:** parse-validity, no-hallucination grounding, execution-success,
  output-match against fixtures.

Out of scope for v1: app generation, multi-turn refinement, fine-tuning, anything
involving the agent loop itself. v2 may add multi-turn debug-from-error.

## How it relates to AgentClash

This benchmark ships as a challenge pack consumable by [AgentClash](https://agentclash.dev/)'s
existing harness. The pack carries its own E2B sandbox template (an image bundling
a pinned Windmill server, Postgres, a frozen Hub snapshot, and seeded workspace
fixtures). AgentClash spins up sandboxes from this template and runs the corpus
against any registered model adapter.

Repo layout (filling in over the next handful of PRs):

```
e2b-template/   E2B sandbox template — Windmill + Postgres, deterministic boot
tasks/          NL spec + reference flow + oracle, per task
fixtures/       Frozen Hub snapshot + workspace seed
scoring/        Rubric implementations (parse, grounding, execution, output-match)
runner/         Glue that drives a model through one task
```

## Differentiation from Windmill's internal evals

Windmill's repo includes an internal `ai_evals/` suite that uses an LLM judge and
covers script/flow/app/cli generation. That suite is for development sanity-checking
and its cases are deliberately simple (e.g. "sum two numbers", "reuse existing
script"). windmill-bench is **public, harder, and execution-graded** — designed
as a measurement substrate that fronts a public leaderboard rather than a CI gate.

## License

MIT. See [LICENSE](./LICENSE).
