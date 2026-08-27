# Migrate existing evaluation data

Dry Run accepts documented JSON export shapes from DeepEval, Langfuse, and Braintrust. The adapter is intentionally clean-room: it maps public data fields into Dry Run documents and does not include vendor implementation code.

```bash
dry-run migrate deepeval ./test-run.json -o ./dry-run-import.json --name support-quality
dry-run migrate langfuse ./traces.json -o ./dry-run-import.json
dry-run migrate braintrust ./spans.json -o ./dry-run-import.json
```

The output is a `dry-run.migration` bundle containing checksummed datasets, nested trace documents, warnings, and exact counts. Output creation is exclusive: an existing file is never overwritten.

## Mapping

| Source | Imported as | Preserved |
| --- | --- | --- |
| DeepEval test cases | Dry Run dataset cases | input, expected/actual output, context, retrieval context, turns, prior metric results as metadata |
| Langfuse traces/observations | Dry Run traces/spans | hierarchy, input/output, status, model, usage, metadata, tags, scores as external feedback |
| Braintrust span rows | Dry Run traces/spans | root grouping, parent hierarchy, input/output, errors, timing, metrics, attributes |

Secret-shaped values pass through Dry Run redaction before being written. IDs are normalized to filesystem-safe stable values. Missing timestamps use a deterministic Unix-epoch fallback rather than the import time.

Historical vendor metric results are evidence from a different evaluator implementation. They are preserved but are not silently presented as freshly computed Dry Run scores. Rerun the imported dataset through the current metric suite for an apples-to-apples baseline.

## Load into a project

The bundle is reviewable JSON. Dataset documents can be saved under `.dryrun/datasets/`; trace documents can be POSTed to the team API or persisted through `TraceStore`. Keeping the intermediate bundle makes a migration auditable and reversible.

For large exports, split at source and migrate in batches. Validate counts in `summary` before deleting the source export. Keep the original export until backup restore and representative query checks have passed.
