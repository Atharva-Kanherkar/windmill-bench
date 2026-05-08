# windmill-bench

> Public benchmark for AI agents generating [Windmill](https://www.windmill.dev/) workflows — execution-graded.

**Status:** Pre-v0. Scaffolding only. Not yet runnable.

## What this is

A challenge pack that evaluates how well AI agents (Claude, GPT, Gemini, open-weights)
generate Windmill flows from natural-language specifications.

Generated flows are graded by **actually executing them inside a sandboxed Windmill
instance** and comparing the runtime output against a reference oracle — not by
static analysis or LLM-judge alone.

## Why

Existing public benchmarks for code-generating agents either:

- Test single-function generation (HumanEval, BigCodeBench, LiveCodeBench), or
- Test agent task-completion in environments (AppWorld, τ-bench), or
- Test workflow generation as abstract DAGs without a real execution target
  (WorFBench, AFLOW), or
- Test DAG generation against static analyzers, not execution (Prompt2DAG, dbt
  semantic-layer benchmarks).

None of them generate artifacts for a **real, open-source, executable production
workflow engine** and grade by **running the generated artifact**. Windmill is the
right reference engine because it's open-source, covers scripts + flows + apps
under one runtime, and exposes a programmatic surface (the `wmill` CLI) clean
enough to drive a benchmark harness against.

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
