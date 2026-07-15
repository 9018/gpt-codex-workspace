# Risk-aware agent pipeline

GPTWork selects the smallest safe agent chain when a task carries explicit risk metadata. Tasks without recognized risk metadata retain the historical full pipeline for backward compatibility.

| Risk level | Effective roles |
| --- | --- |
| `readonly` (`read_only`, `no_change`, `diagnostic`) | `verifier` |
| `low` | `builder -> verifier` |
| `medium` | `planner -> builder -> verifier -> reviewer` |
| `high` | `context_curator -> planner -> builder -> verifier -> reviewer -> integrator -> finalizer` |
| absent or unknown | historical default pipeline |

Explicit `agent_roles`, `pipeline_roles`, or `roles` always override risk selection.

Completion gates are derived from the selected chain. Omitted roles do not create synthetic missing gates and therefore cannot block closure. `context_curator` remains informational, matching the historical gate contract. Repairer remains a recovery branch and is not part of the main chain.
