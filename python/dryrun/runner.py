from __future__ import annotations

import asyncio
import inspect
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

Agent = Callable[..., Awaitable[dict[str, Any]]]


@dataclass
class Scenario:
    name: str
    agent: Agent
    input: str
    expect: list[dict[str, Any]] = field(default_factory=list)
    timeout: float = 30.0
    tags: list[str] = field(default_factory=list)
    retries: int = 0


async def run_scenarios(
    scenarios: list[Scenario], *, concurrency: int = 1, trials: int = 1, allow_skipped: bool = False
) -> dict[str, Any]:
    semaphore = asyncio.Semaphore(concurrency)

    async def run(scenario: Scenario, trial: int) -> dict[str, Any]:
        async with semaphore:
            last: dict[str, Any] | None = None
            for attempt in range(1, scenario.retries + 2):
                last = await _run_one(scenario, trial, allow_skipped)
                last["attempts"] = attempt
                if last["passed"]:
                    break
            return last or {}

    started = time.perf_counter()
    results = await asyncio.gather(*[
        run(scenario, trial)
        for scenario in scenarios
        for trial in range(1, trials + 1)
    ])
    passed = sum(1 for result in results if result["passed"])
    return {
        "results": results,
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "durationMs": round((time.perf_counter() - started) * 1000),
    }


async def _run_one(scenario: Scenario, trial: int, allow_skipped: bool) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        parameters = inspect.signature(scenario.agent).parameters
        call = scenario.agent(scenario.input, {"trial": trial}) if len(parameters) > 1 else scenario.agent(scenario.input)
        trajectory = await asyncio.wait_for(call, timeout=scenario.timeout)
        duration = round((time.perf_counter() - started) * 1000)
        assertions = [_assert(expect, trajectory, duration) for expect in scenario.expect]
        passed = all(item["passed"] for item in assertions) and (allow_skipped or not any(item.get("skipped") for item in assertions))
        return {"name": scenario.name, "passed": passed, "assertions": assertions, "durationMs": duration, "trial": trial, "tags": scenario.tags}
    except Exception as error:
        return {"name": scenario.name, "passed": False, "assertions": [], "durationMs": round((time.perf_counter() - started) * 1000), "trial": trial, "tags": scenario.tags, "error": str(error)}


def _assert(expect: dict[str, Any], trajectory: dict[str, Any], duration: int) -> dict[str, Any]:
    kind = expect.get("type")
    output = str(trajectory.get("output", ""))
    steps = trajectory.get("steps", [])
    tools = [step.get("toolCall", {}).get("name") for step in steps if step.get("kind") == "tool"]
    label = kind or "assertion"
    if kind == "outputEquals":
        return _result(label, output.strip() == str(expect.get("value", "")).strip(), output)
    if kind == "outputContains":
        return _result(label, str(expect.get("value", "")) in output, output)
    if kind == "outputMatches":
        return _result(label, re.search(str(expect.get("pattern", "")), output) is not None, output)
    if kind == "toolCalled":
        count = tools.count(expect.get("tool"))
        return _result(label, count > 0 and (expect.get("times") is None or count == expect["times"]), f"got {count} calls")
    if kind == "noToolErrors":
        errors = [step.get("error") for step in steps if step.get("kind") == "tool" and step.get("error")]
        return _result(label, not errors, "; ".join(errors))
    if kind == "maxSteps":
        return _result(label, len(steps) <= int(expect["count"]), f"took {len(steps)} steps")
    if kind == "maxDuration":
        return _result(label, duration <= int(expect["ms"]), f"took {duration}ms")
    if kind == "trajectory":
        expected = expect.get("tools", [])
        mode = expect.get("mode", "strict")
        ok = tools == expected if mode == "strict" else sorted(tools) == sorted(expected) if mode == "unordered" else _subsequence(expected, tools) if mode == "subset" else _subsequence(tools, expected)
        return _result(label, ok, f"actual path: {tools}")
    return {"label": label, "passed": True, "skipped": True, "message": "unsupported by Python runtime"}


def _subsequence(needle: list[str], haystack: list[str]) -> bool:
    iterator = iter(haystack)
    return all(any(value == candidate for candidate in iterator) for value in needle)


def _result(label: str, passed: bool, message: str) -> dict[str, Any]:
    return {"label": label, "passed": passed, **({} if passed else {"message": message})}
