from __future__ import annotations

import inspect
import time
from typing import Any, Callable

from .tracing import Span, Tracer, default_tracer


class LangChainCallback:
    """Duck-typed LangChain callback; importing LangChain is not required."""
    def __init__(self, tracer: Tracer = default_tracer): self.tracer, self._spans = tracer, {}
    def on_chain_start(self, serialized: dict[str, Any], inputs: Any, *, run_id: Any, parent_run_id: Any = None, **kwargs: Any) -> None: self._start(run_id, serialized.get("name", "langchain-chain"), "agent", inputs)
    def on_chain_end(self, outputs: Any, *, run_id: Any, **kwargs: Any) -> None: self._end(run_id, outputs)
    def on_chain_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None: self._error(run_id, error)
    def on_llm_start(self, serialized: dict[str, Any], prompts: list[str], *, run_id: Any, **kwargs: Any) -> None: self._start(run_id, serialized.get("name", "langchain-llm"), "llm", prompts)
    def on_llm_end(self, response: Any, *, run_id: Any, **kwargs: Any) -> None: self._end(run_id, _plain(response))
    def on_llm_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None: self._error(run_id, error)
    def on_tool_start(self, serialized: dict[str, Any], input_str: str, *, run_id: Any, **kwargs: Any) -> None: self._start(run_id, serialized.get("name", "langchain-tool"), "tool", input_str)
    def on_tool_end(self, output: Any, *, run_id: Any, **kwargs: Any) -> None: self._end(run_id, output)
    def on_tool_error(self, error: BaseException, *, run_id: Any, **kwargs: Any) -> None: self._error(run_id, error)
    def _start(self, run_id: Any, name: str, kind: str, value: Any) -> None:
        span = self.tracer.start_span(name, span_type=kind, input=value); span.__enter__(); self._spans[str(run_id)] = span
    def _end(self, run_id: Any, output: Any) -> None:
        span = self._spans.pop(str(run_id), None)
        if span: span.set_output(output); span.__exit__(None, None, None)
    def _error(self, run_id: Any, error: BaseException) -> None:
        span = self._spans.pop(str(run_id), None)
        if span: span.__exit__(type(error), error, error.__traceback__)


class LlamaIndexCallback:
    """Dependency-free callback handler compatible with LlamaIndex event hooks."""
    def __init__(self, tracer: Tracer = default_tracer): self.tracer, self._spans = tracer, {}
    def start_trace(self, trace_id: str | None = None) -> None: pass
    def end_trace(self, trace_id: str | None = None, trace_map: dict[str, Any] | None = None) -> None: pass
    def on_event_start(self, event_type: Any, payload: dict[str, Any] | None = None, event_id: str = "", parent_id: str = "", **kwargs: Any) -> str:
        identifier = event_id or f"event-{time.time_ns()}"; kind = _event_kind(str(event_type)); span = self.tracer.start_span(str(event_type), span_type=kind, input=payload or {}); span.__enter__(); self._spans[identifier] = span; return identifier
    def on_event_end(self, event_type: Any, payload: dict[str, Any] | None = None, event_id: str = "", **kwargs: Any) -> None:
        span = self._spans.pop(event_id, None)
        if span: span.set_output(payload or {}); span.__exit__(None, None, None)


def instrument_callable(function: Callable[..., Any], *, tracer: Tracer = default_tracer, name: str | None = None, span_type: str = "llm", input_mapper: Callable[..., Any] | None = None, output_mapper: Callable[[Any], Any] | None = None) -> Callable[..., Any]:
    """Wrap any OpenAI/Anthropic/DSPy/CrewAI-compatible callable without importing its SDK."""
    label = name or getattr(function, "__qualname__", "model-call")
    if inspect.iscoroutinefunction(function):
        async def async_wrapped(*args: Any, **kwargs: Any) -> Any:
            async with tracer.start_span(label, span_type=span_type, input=input_mapper(*args, **kwargs) if input_mapper else {"args": args, "kwargs": kwargs}) as span:
                output = await function(*args, **kwargs); span.set_output(output_mapper(output) if output_mapper else _plain(output)); _record_usage(span, output); return output
        return async_wrapped
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        with tracer.start_span(label, span_type=span_type, input=input_mapper(*args, **kwargs) if input_mapper else {"args": args, "kwargs": kwargs}) as span:
            output = function(*args, **kwargs); span.set_output(output_mapper(output) if output_mapper else _plain(output)); _record_usage(span, output); return output
    return wrapped


def instrument_openai(client: Any, tracer: Tracer = default_tracer) -> Any:
    """Instrument OpenAI chat/responses methods in place and return the client."""
    targets = [("chat", "completions", "create", "openai.chat.completions"), ("responses", None, "create", "openai.responses")]
    for first, second, method, label in targets:
        owner = getattr(client, first, None); owner = getattr(owner, second, None) if owner is not None and second else owner
        if owner is not None and callable(getattr(owner, method, None)):
            setattr(owner, method, instrument_callable(getattr(owner, method), tracer=tracer, name=label, span_type="llm"))
    return client


def instrument_anthropic(client: Any, tracer: Tracer = default_tracer) -> Any:
    owner = getattr(client, "messages", None)
    if owner is not None and callable(getattr(owner, "create", None)): setattr(owner, "create", instrument_callable(owner.create, tracer=tracer, name="anthropic.messages", span_type="llm"))
    return client


def instrument_dspy(module: Any, tracer: Tracer = default_tracer) -> Any:
    if callable(getattr(module, "forward", None)): module.forward = instrument_callable(module.forward, tracer=tracer, name=f"dspy.{type(module).__name__}", span_type="agent")
    return module


def instrument_crewai(crew: Any, tracer: Tracer = default_tracer) -> Any:
    for method in ("kickoff", "kickoff_async"):
        if callable(getattr(crew, method, None)): setattr(crew, method, instrument_callable(getattr(crew, method), tracer=tracer, name=f"crewai.{method}", span_type="agent"))
    return crew


def _record_usage(span: Span, output: Any) -> None:
    usage = getattr(output, "usage", None) or (output.get("usage") if isinstance(output, dict) else None)
    if usage:
        for source, target in (("prompt_tokens", "input_tokens"), ("input_tokens", "input_tokens"), ("completion_tokens", "output_tokens"), ("output_tokens", "output_tokens"), ("total_tokens", "total_tokens")):
            value = getattr(usage, source, None) if not isinstance(usage, dict) else usage.get(source)
            if isinstance(value, (int, float)): span.set_metric(target, float(value))


def _plain(value: Any) -> Any:
    if hasattr(value, "model_dump"): return value.model_dump()
    if hasattr(value, "dict") and callable(value.dict): return value.dict()
    return value
def _event_kind(value: str) -> str:
    text = value.lower()
    if "llm" in text: return "llm"
    if "retrieve" in text or "query" in text: return "retriever"
    if "tool" in text: return "tool"
    return "custom"


__all__ = ["LangChainCallback", "LlamaIndexCallback", "instrument_callable", "instrument_openai", "instrument_anthropic", "instrument_dspy", "instrument_crewai"]
