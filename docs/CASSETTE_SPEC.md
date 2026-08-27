# dry-run cassette protocol v2

The cassette protocol is a portable JSON contract for deterministic agent replay. It is intentionally framework-neutral and has no hosted-service dependency. The normative JSON Schema is [`schemas/cassette-v2.schema.json`](../schemas/cassette-v2.schema.json).

## Envelope

```json
{
  "$schema": "https://raw.githubusercontent.com/MuratKomurcu1/dry-run/main/schemas/cassette-v2.schema.json",
  "kind": "dry-run.cassette",
  "version": 2,
  "metadata": {
    "name": "support-flow",
    "createdAt": "2026-08-25T12:00:00.000Z",
    "updatedAt": "2026-08-25T12:00:00.000Z",
    "producer": { "name": "@muratkomurcu/dry-run", "version": "0.8.0" },
    "runtime": { "name": "node", "version": "v26.7.0", "platform": "darwin", "arch": "arm64" },
    "matching": "canonical",
    "redaction": { "enabled": true, "policy": "dry-run-secrets-v2" }
  },
  "interactions": [],
  "checksum": "sha256:..."
}
```

Unknown properties must be preserved by a reader where practical. A reader must reject an unknown major `version`; evolution within v2 may add optional fields.

## Canonical JSON and checksum

Canonical JSON recursively sorts object keys lexicographically, preserves array order, omits JavaScript `undefined` object properties, and emits compact UTF-8 JSON. `checksum` is lowercase SHA-256 over the canonical `interactions` array with the `sha256:` prefix.

The checksum detects accidental corruption or an interaction edit that bypassed migration/finalization. It is not keyed and therefore is not an authenticity signature.

## Request fingerprints

Every recorded interaction may contain SHA-256 fingerprints for all built-in policies:

- `exact`: serialized request after removing the runtime-only `signal`;
- `canonical`: key-sorted request with CRLF normalized to LF and trailing whitespace removed from strings;
- `shape`: model, ordered message roles/content types, prior tool names and argument-key shapes, presence of tool-call IDs, tool names/schemas, and response format.

A replayer calculates the chosen fingerprint from the current request and fails before returning a response when it differs. Implementations should provide a redacted diagnostic but must not leak raw secrets in mismatch output.

## Matching and migration

New recordings use `canonical` unless the caller explicitly selects another policy. A legacy top-level interaction array is cassette v1. Readers must treat it as `shape` to retain the old wording-drift behavior. Writers should emit v2 only.

```bash
dry-run cassette migrate old.json
dry-run cassette verify old.json
```

## Portability

The TypeScript and Python runtimes in this repository verify the same v2 checksum and replay the same request/response objects. Framework adapters should convert their native messages, tools and usage into the neutral `ChatRequest` / `ChatResponse` shape before recording.

## Security

The `redaction` metadata describes the policy applied by the producer; it does not prove that a cassette is free of sensitive data. Review fixtures before commit. A consumer must treat response/tool contents as untrusted data and generated scenario source as executable code requiring review.
