from __future__ import annotations

import asyncio
import contextlib
import contextvars
import functools
import hashlib
import inspect
import json
import os
import re
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

from .client import TeamClient


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000):x}_{uuid.uuid4().hex[:16]}"


class TraceExporter(Protocol):
    def export(self, trace: dict[str, Any]) -> Any: ...
    def shutdown(self) -> Any: ...


@dataclass
class _TraceState:
    id: str
    name: str
    started_at: str
    started_ns: int
    root_span_id: str = ""
    spans: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)


@dataclass
class _Context:
    tracer: "Tracer"
    trace: _TraceState
    span_id: str


_active: contextvars.ContextVar[_Context | None] = contextvars.ContextVar("dryrun_active_span", default=None)


class Span:
    def __init__(self, tracer: "Tracer", state: _TraceState, record: dict[str, Any]):
        self.tracer, self.state, self.record = tracer, state, record
        self.started_ns = time.perf_counter_ns()
        self.ended = False
        self._token: contextvars.Token[_Context | None] | None = None

    def set_input(self, value: Any) -> "Span": self.record["input"] = _safe(value); return self
    def set_output(self, value: Any) -> "Span": self.record["output"] = _safe(value); return self
    def set_attribute(self, key: str, value: Any) -> "Span": self.record["attributes"][key] = _safe(value); return self
    def set_metric(self, key: str, value: float) -> "Span":
        if not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
            raise ValueError("Trace metrics must be finite")
        self.record["metrics"][key] = float(value)
        return self
    def add_event(self, name: str, attributes: dict[str, Any] | None = None) -> "Span":
        self.record["events"].append({"name": name, "timestamp": _now(), **({"attributes": _safe(attributes)} if attributes else {})})
        return self
    def record_error(self, error: BaseException) -> "Span":
        self.record["status"] = "error"
        self.record["error"] = {"name": type(error).__name__, "message": _redact(str(error))[:2_000]}
        return self
    def __enter__(self) -> "Span":
        self._token = _active.set(_Context(self.tracer, self.state, self.record["id"]))
        return self
    def __exit__(self, kind, value, tb) -> None:  # type: ignore[no-untyped-def]
        if value is not None: self.record_error(value)
        if self._token is not None: _active.reset(self._token)
        self.end()
    async def __aenter__(self) -> "Span": return self.__enter__()
    async def __aexit__(self, kind, value, tb) -> None: self.__exit__(kind, value, tb)  # type: ignore[no-untyped-def]
    def end(self, output: Any = None) -> dict[str, Any] | None:
        if self.ended: return None
        self.ended = True
        if output is not None: self.set_output(output)
        if self.record["status"] == "running": self.record["status"] = "ok"
        self.record["endedAt"] = _now()
        self.record["durationMs"] = (time.perf_counter_ns() - self.started_ns) / 1_000_000
        return self.tracer._finish(self.state) if self.record["id"] == self.state.root_span_id else None


class Tracer:
    def __init__(self, exporters: list[TraceExporter] | None = None):
        self.exporters = exporters or []
        self.completed: dict[str, dict[str, Any]] = {}

    def start_span(self, name: str, *, span_type: str = "custom", input: Any = None, attributes: dict[str, Any] | None = None, metrics: dict[str, float] | None = None, trace_name: str | None = None, trace_metadata: dict[str, Any] | None = None, tags: list[str] | None = None) -> Span:
        if not name.strip() or span_type not in ("agent", "task", "llm", "tool", "retriever", "scorer", "custom"):
            raise ValueError("Span name/type is invalid")
        current = _active.get()
        if current and current.tracer is not self: raise RuntimeError("Cannot nest spans from different tracers")
        state = current.trace if current else _TraceState(_id("trace"), trace_name or name, _now(), time.perf_counter_ns(), metadata=_safe(trace_metadata or {}), tags=list(tags or []))
        span_id = _id("span")
        if not state.root_span_id: state.root_span_id = span_id
        record = {"id": span_id, "traceId": state.id, **({"parentId": current.span_id} if current else {}), "name": name, "type": span_type, "status": "running", "startedAt": _now(), **({"input": _safe(input)} if input is not None else {}), "attributes": _safe(attributes or {}), "metrics": dict(metrics or {}), "events": []}
        state.spans.append(record)
        return Span(self, state, record)

    @contextlib.contextmanager
    def span(self, name: str, **options: Any) -> Iterator[Span]:
        with self.start_span(name, **options) as span: yield span

    def observe(self, name: str | None = None, *, span_type: str = "agent", capture_input: bool = True, capture_output: bool = True) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def decorate(function: Callable[..., Any]) -> Callable[..., Any]:
            label = name or function.__qualname__
            if inspect.iscoroutinefunction(function):
                @functools.wraps(function)
                async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                    async with self.start_span(label, span_type=span_type, input={"args": args, "kwargs": kwargs} if capture_input else None) as span:
                        result = await function(*args, **kwargs)
                        if capture_output: span.set_output(result)
                        return result
                return async_wrapper
            @functools.wraps(function)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                with self.start_span(label, span_type=span_type, input={"args": args, "kwargs": kwargs} if capture_input else None) as span:
                    result = function(*args, **kwargs)
                    if capture_output: span.set_output(result)
                    return result
            return wrapper
        return decorate

    def current_span(self) -> dict[str, Any] | None:
        current = _active.get()
        if not current or current.tracer is not self: return None
        return next((span for span in current.trace.spans if span["id"] == current.span_id), None)

    def _finish(self, state: _TraceState) -> dict[str, Any]:
        root = next(span for span in state.spans if span["id"] == state.root_span_id)
        trace = {"kind": "dry-run.trace", "version": 1, "id": state.id, "name": state.name, "status": "error" if any(span["status"] == "error" for span in state.spans) else "ok", "startedAt": state.started_at, "endedAt": root["endedAt"], "durationMs": (time.perf_counter_ns() - state.started_ns) / 1_000_000, "rootSpanId": state.root_span_id, "spans": state.spans, **({"metadata": state.metadata} if state.metadata else {}), **({"tags": state.tags} if state.tags else {}), "feedback": []}
        self.completed[trace["id"]] = trace
        for exporter in self.exporters:
            result = exporter.export(trace)
            if inspect.isawaitable(result):
                try: asyncio.get_running_loop().create_task(result)
                except RuntimeError: asyncio.run(result)
        return trace

    async def shutdown(self) -> None:
        for exporter in self.exporters:
            result = exporter.shutdown()
            if inspect.isawaitable(result): await result


class FileTraceExporter:
    def __init__(self, directory: str | Path = ".dryrun/traces"):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    def export(self, trace: dict[str, Any]) -> None:
        target = self.directory / f"{trace['id']}.json"
        descriptor, temporary = tempfile.mkstemp(prefix=f".{trace['id']}.", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream: json.dump(trace, stream, indent=2); stream.write("\n")
            os.chmod(temporary, 0o600); os.replace(temporary, target)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
    def shutdown(self) -> None: pass


class RemoteTraceExporter:
    def __init__(self, client: TeamClient): self.client = client
    def export(self, trace: dict[str, Any]) -> None: self.client.put_trace(trace)
    def shutdown(self) -> None: pass


def _safe(value: Any) -> Any:
    try: return json.loads(json.dumps(value, default=lambda item: repr(item)))
    except Exception: return repr(value)


_SECRET = re.compile(r"(?i)(bearer\s+|(?:api[_-]?key|token|secret|password)[=:]\s*)[^\s,;]+")
def _redact(value: str) -> str: return _SECRET.sub(lambda match: f"{match.group(1)}[REDACTED]", value)


default_tracer = Tracer()
observe = default_tracer.observe

__all__ = ["Tracer", "Span", "TraceExporter", "FileTraceExporter", "RemoteTraceExporter", "default_tracer", "observe"]
