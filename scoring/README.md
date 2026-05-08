# scoring

Rubric implementations. Each criterion is a separate module so we can score
partial credit and report per-criterion pass rates on the leaderboard.

## Criteria

1. **`parse.ts`** — Does the agent's output parse as valid OpenFlow JSON?
   Schema reference: Windmill's `openflow.openapi.yaml`. Pure structural check;
   no semantics.

2. **`grounding.ts`** — Does the flow reference only scripts, resources, and
   variables that actually exist in the seeded workspace + frozen Hub snapshot?
   Hallucinated `f/email/send_email` (when only `f/email/send` exists) fails
   here. This is the "no fake successes" check.

3. **`execution.ts`** — Does the flow execute end-to-end inside the sandboxed
   Windmill without crashing? Runs via `wmill flow run` and polls the job to
   completion.

4. **`output-match.ts`** — Does the runtime output match the task's `oracle.json`?
   Tolerance buckets normalize timestamps, generated UUIDs, and parallel-step
   ordering before diffing.

## Composite score

The pack reports each criterion individually and a weighted composite. Weights
are TBD until v0 is running and we see real distributions. Default proposal:
parse 10%, grounding 30%, execution 30%, output-match 30%.

## Determinism contract

Same generated flow + same fixtures → identical scores on criteria 1, 2, 3.
Criterion 4 has tolerance for non-determinism that we can't strip (e.g.
LLM-generated free-text fields when the task allows them).
