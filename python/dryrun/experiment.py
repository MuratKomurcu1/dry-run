from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import math
import os
import platform
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from .client import TeamClient
from .tracing import Tracer

Task = Callable[[Any, dict[str, Any]], Any | Awaitable[Any]]
Metric = Callable[[dict[str, Any]], Any | Awaitable[Any]]


@dataclass(frozen=True)
class ExperimentCase:
    input: Any
    expected: Any = None
    id: str | None = None
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ExperimentDefinition:
    name: str
    cases: list[ExperimentCase]
    task: Task
    metrics: list[Metric]


async def run_experiment(definition: ExperimentDefinition, *, trials: int = 1, concurrency: int = 4, tracer: Tracer | None = None, store: str | Path | None = ".dryrun/experiments", client: TeamClient | None = None) -> dict[str, Any]:
    if not definition.name.strip() or not definition.cases or not definition.metrics: raise ValueError("Experiment requires a name, cases, and metrics")
    if not 1 <= trials <= 100 or not 1 <= concurrency <= 256: raise ValueError("trials/concurrency is out of range")
    experiment_id = f"experiment_{int(time.time() * 1000):x}_{uuid.uuid4().hex[:16]}"
    created = _now()
    semaphore = asyncio.Semaphore(concurrency)
    runtime_tracer = tracer or Tracer()

    async def execute(case: ExperimentCase, index: int, trial: int) -> dict[str, Any]:
        case_id = case.id or hashlib.sha256(json.dumps(case.input, sort_keys=True, default=repr).encode()).hexdigest()[:16]
        started = time.perf_counter()
        async with semaphore:
            try:
                with runtime_tracer.start_span(f"{definition.name}:{case_id}", span_type="task", input=case.input, trace_metadata={"experimentId": experiment_id, "caseId": case_id, "trial": trial}) as span:
                    output = await _await(definition.task(case.input, {"case": case, "trial": trial, "experimentId": experiment_id}))
                    span.set_output(output)
                duration = (time.perf_counter() - started) * 1_000
                metric_results = [await _metric(metric, {"case": case, "output": output, "expected": case.expected, "durationMs": duration, "trial": trial}) for metric in definition.metrics]
                return {"key": f"{case_id}#{trial}", "caseId": case_id, "trial": trial, "input": case.input, "expected": case.expected, "output": output, "scores": metric_results, "passed": all(score["passed"] for score in metric_results), "durationMs": duration, "attempts": 1, "tags": case.tags, "metadata": case.metadata}
            except Exception as error:
                return {"key": f"{case_id}#{trial}", "caseId": case_id, "trial": trial, "input": case.input, "expected": case.expected, "scores": [], "passed": False, "durationMs": (time.perf_counter() - started) * 1_000, "attempts": 1, "error": str(error)[:2_000]}

    results = await asyncio.gather(*(execute(case, index, trial) for index, case in enumerate(definition.cases) for trial in range(1, trials + 1)))
    aggregates = _aggregates(results)
    document = {"kind": "dry-run.experiment", "version": 1, "id": experiment_id, "name": definition.name, "status": "completed", "createdAt": created, "updatedAt": _now(), "dataset": {"name": definition.name, "version": 1, "checksum": _checksum_cases(definition.cases), "cases": [_case_dict(case, index) for index, case in enumerate(definition.cases)]}, "config": {"trials": trials, "concurrency": concurrency, "runtime": f"python {platform.python_version()}"}, "results": results, "aggregates": aggregates, "summary": {"total": len(results), "passed": sum(1 for result in results if result["passed"]), "failed": sum(1 for result in results if not result["passed"]), "durationMs": sum(result["durationMs"] for result in results), "tokens": 0, "costUsd": 0}, "feedback": []}
    if store: _atomic_json(Path(store) / f"{experiment_id}.json", document)
    if client: client.ingest_experiment(document)
    return document


async def _metric(metric: Metric, context: dict[str, Any]) -> dict[str, Any]:
    raw = await _await(metric(context))
    name = getattr(metric, "__name__", "metric").replace("_", "-")
    if isinstance(raw, bool): score, passed, details = float(raw), raw, {}
    elif isinstance(raw, (int, float)): score, passed, details = float(raw), float(raw) >= 0.5, {}
    elif isinstance(raw, dict):
        score = float(raw.get("score", 1 if raw.get("passed") else 0)); passed = bool(raw.get("passed", score >= float(raw.get("threshold", 0.5)))); details = {key: value for key, value in raw.items() if key not in ("score", "passed", "name")}; name = str(raw.get("name", name))
    else: raise ValueError(f"Metric {name} returned an unsupported value")
    if not math.isfinite(score): raise ValueError(f"Metric {name} returned a non-finite score")
    return {"name": name, "score": score, "threshold": float(details.pop("threshold", 0.5)), "passed": passed, **({"details": details} if details else {})}


def _aggregates(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    names = sorted({score["name"] for result in results for score in result["scores"]})
    values = []
    for name in names:
        scores = [score for result in results for score in result["scores"] if score["name"] == name]
        passed = sum(1 for score in scores if score["passed"]); total = len(scores); low, high = _wilson(passed, total)
        values.append({"name": name, "mean": sum(score["score"] for score in scores) / total, "passRate": passed / total, "passed": passed, "failed": total - passed, "total": total, "confidence95": {"low": low, "high": high}})
    return values


def _wilson(successes: int, total: int) -> tuple[float, float]:
    if total == 0: return 0.0, 0.0
    z = 1.959963984540054; p = successes / total; denominator = 1 + z * z / total; center = (p + z * z / (2 * total)) / denominator; margin = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator
    return max(0.0, center - margin), min(1.0, center + margin)


async def _await(value: Any) -> Any: return await value if inspect.isawaitable(value) else value
def _now() -> str: return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
def _case_dict(case: ExperimentCase, index: int) -> dict[str, Any]: return {"id": case.id or f"case_{index + 1}", "input": case.input, "expected": case.expected, "tags": case.tags, "metadata": case.metadata}
def _checksum_cases(cases: list[ExperimentCase]) -> str: return "sha256:" + hashlib.sha256(json.dumps([_case_dict(case, index) for index, case in enumerate(cases)], sort_keys=True, separators=(",", ":"), default=repr).encode()).hexdigest()
def _atomic_json(target: Path, value: Any) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700); descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream: json.dump(value, stream, indent=2); stream.write("\n")
        os.chmod(temporary, 0o600); os.replace(temporary, target)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


__all__ = ["ExperimentCase", "ExperimentDefinition", "run_experiment"]
