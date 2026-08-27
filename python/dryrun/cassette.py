from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

MatchMode = Literal["exact", "canonical", "shape"]


class CassetteError(RuntimeError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _sha(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_strings(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("\r\n", "\n").rstrip()
    if isinstance(value, list):
        return [_normalize_strings(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_strings(child) for key, child in value.items()}
    return value


def _shape(value: Any) -> Any:
    if isinstance(value, list):
        return [_shape(item) for item in value]
    if isinstance(value, dict):
        return {key: _shape(value[key]) for key in sorted(value)}
    if value is None:
        return "object"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object"


def _request_value(request: dict[str, Any], mode: MatchMode) -> Any:
    request = {key: copy.deepcopy(value) for key, value in request.items() if key != "signal"}
    if mode == "exact":
        return request
    if mode == "canonical":
        return _normalize_strings(request)
    return {
        "model": request.get("model") or None,
        "messages": [
            {
                "role": message.get("role"),
                "contentType": "null" if message.get("content") is None else "string",
                "toolCalls": [
                    {"name": call.get("name"), "argumentKeys": _shape(call.get("arguments", {}))}
                    for call in message.get("toolCalls", [])
                ],
                "toolCallId": "present" if message.get("toolCallId") else "absent",
            }
            for message in request.get("messages", [])
        ],
        "tools": [
            {"name": tool.get("name"), "parameters": tool.get("parameters")}
            for tool in request.get("tools", [])
        ],
        "responseFormat": request.get("responseFormat"),
    }


def match_requests(recorded: dict[str, Any], current: dict[str, Any], mode: MatchMode = "canonical") -> bool:
    left = _request_value(recorded, mode)
    right = _request_value(current, mode)
    if mode == "exact":
        return json.dumps(left, ensure_ascii=False, separators=(",", ":")) == json.dumps(right, ensure_ascii=False, separators=(",", ":"))
    return _canonical(left) == _canonical(right)


def _fingerprint(request: dict[str, Any], mode: MatchMode) -> str:
    value = _request_value(request, mode)
    source = json.dumps(value, ensure_ascii=False, separators=(",", ":")) if mode == "exact" else _canonical(value)
    return _sha(source)


def _validate_interactions(interactions: Any) -> list[dict[str, Any]]:
    if not isinstance(interactions, list):
        raise CassetteError("interactions must be an array")
    for index, interaction in enumerate(interactions):
        if not isinstance(interaction, dict) or not isinstance(interaction.get("request"), dict) or not isinstance(interaction.get("response"), dict):
            raise CassetteError(f"interaction {index + 1} must contain request and response objects")
    return interactions


@dataclass
class CassetteStore:
    file: str | Path

    def load(self, verify_checksum: bool = True) -> dict[str, Any]:
        path = Path(self.file)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except Exception as error:
            raise CassetteError(f'cannot read cassette "{path}": {error}') from error
        if isinstance(value, list):
            return {
                "kind": "dry-run.cassette",
                "version": 2,
                "metadata": {"name": path.stem, "matching": "shape", "source": {"migratedFrom": 1}},
                "interactions": _validate_interactions(value),
                "checksum": _sha(_canonical(value)),
            }
        if not isinstance(value, dict) or value.get("kind") != "dry-run.cassette" or value.get("version") != 2:
            raise CassetteError("expected a dry-run cassette v2 object or legacy interaction array")
        interactions = _validate_interactions(value.get("interactions"))
        if verify_checksum and value.get("checksum") != _sha(_canonical(interactions)):
            raise CassetteError("checksum mismatch; cassette is corrupt or was edited without migration")
        metadata = value.get("metadata")
        if not isinstance(metadata, dict) or metadata.get("matching") not in ("exact", "canonical", "shape"):
            raise CassetteError("cassette metadata or matching policy is invalid")
        for index, interaction in enumerate(interactions):
            fingerprints = interaction.get("fingerprints")
            if not fingerprints:
                continue
            for mode in ("exact", "canonical", "shape"):
                if fingerprints.get(mode) != _fingerprint(interaction["request"], mode):
                    raise CassetteError(f"interaction {index + 1} has an invalid {mode} request fingerprint")
        return value


class Replayer:
    def __init__(self, file: str | Path, matching: MatchMode | None = None):
        self.document = CassetteStore(file).load()
        self.interactions = self.document["interactions"]
        self.matching: MatchMode = matching or self.document.get("metadata", {}).get("matching", "canonical")
        self.index = 0

    async def chat(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.index >= len(self.interactions):
            raise CassetteError(f"cassette exhausted after {self.index} interactions")
        interaction = self.interactions[self.index]
        self.index += 1
        if not match_requests(interaction["request"], request, self.matching):
            raise CassetteError(f"cassette request mismatch at interaction {self.index} ({self.matching} mode)")
        return copy.deepcopy(interaction["response"])
