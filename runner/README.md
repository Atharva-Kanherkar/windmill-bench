# runner

Glue that drives one model through one task and records a scored result.

## Responsibilities

- Load a task: `tasks/{task-key}/`.
- Render the agent prompt: NL spec + Windmill system prompt fragment + workspace
  inventory + Hub snapshot index. (We snapshot Windmill's own `system_prompts/`
  conventions — see `../e2b-template/` for how that gets surfaced inside the
  sandbox.)
- Call the model adapter (provided by AgentClash) with the rendered prompt.
- Push the model's generated flow into the sandboxed Windmill.
- Trigger execution, wait, collect outputs.
- Run all `../scoring/` criteria.
- Emit a single result record (per-criterion pass/fail, composite score,
  artifacts: prompt, generated flow, run logs, runtime output).

## Not in scope

- The model itself — adapters are AgentClash's concern.
- The benchmark UI / leaderboard — that's downstream of the result records.
- Multi-turn refinement — v1 is single-shot.

## Reproducibility

Runner is pure given (task, model adapter, fixtures, sandbox template) — the
same combination must produce identical results modulo model non-determinism.
We log the random seed, model version, prompt hash, and fixtures version in
every result record.
