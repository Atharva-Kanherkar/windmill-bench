# packs

AgentClash challenge pack manifests for windmill-bench. Each YAML file here
is a complete, publishable pack consumable by `agentclash challenge-pack
publish`.

## Currently shipped

- `windmill-bench-v1.yaml` -- one challenge (sum two numbers), bash-only
  flow, scored by `wb-verify` baked into the `windmill-bench-dev` E2B
  template. This is the minimum end-to-end loop, not the corpus -- v2
  expands to a tiered corpus once we know the loop works against real
  agents.

## Schema reference

The schema is the AgentClash `challengepack.Bundle` struct in
`agentclash/backend/internal/challengepack/bundle.go`. Cross-reference
with `agentclash/examples/challenge-packs/fibonacci-e2e-showcase.yaml`
for a fully-featured example exercising every validator + scorecard
surface.

## Validating locally

The hosted-API path:

```bash
export AGENTCLASH_API_URL="https://api.agentclash.dev"
agentclash auth login --device
agentclash workspace use <workspace-id>
agentclash challenge-pack validate packs/windmill-bench-v1.yaml
```

The offline path (no API server, no credentials). AgentClash's Go module
is rooted at `backend/`, so the test command must run from there, not
from the repo root:

```bash
# In a checkout of agentclash:
cat <<'EOF' > backend/internal/challengepack/wb_local_test.go
package challengepack
import (
  "os"; "testing"
)
func TestParseLocal(t *testing.T) {
  data, _ := os.ReadFile("/path/to/windmill-bench/packs/windmill-bench-v1.yaml")
  if _, err := ParseYAML(data); err != nil { t.Fatal(err) }
}
EOF
cd backend
go test ./internal/challengepack -run TestParseLocal -v
cd ..
rm backend/internal/challengepack/wb_local_test.go
```

The offline path runs the same `ParseYAML` + `StrictDecodeEvaluationSpec`
pipeline the API uses, so a passing local test means the API will accept
the pack on publish.

## Publishing a new pack version

```bash
agentclash challenge-pack publish packs/windmill-bench-v2.yaml
```

Bump `version.number` in the YAML when changes affect run reproducibility
(prompt edits, test cases, scoring rules, sandbox template id). Cosmetic
edits to the pack `name` or `description` do not require a version bump.
