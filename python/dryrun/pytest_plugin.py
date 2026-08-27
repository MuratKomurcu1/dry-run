from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .client import TeamClient, TeamClientOptions
from .tracing import FileTraceExporter, RemoteTraceExporter, Tracer


def pytest_addoption(parser: Any) -> None:
    group = parser.getgroup("dry-run")
    group.addoption("--dry-run-traces", action="store", default=None, help="Directory for Dry Run trace evidence")
    group.addoption("--dry-run-endpoint", action="store", default=None, help="Optional Dry Run team endpoint")
    group.addoption("--dry-run-project", action="store", default="default", help="Dry Run team project")


def pytest_configure(config: Any) -> None:
    config.addinivalue_line("markers", "dryrun: AI/agent quality test recorded by Dry Run")


def pytest_sessionfinish(session: Any, exitstatus: int) -> None:
    target = session.config.getoption("--dry-run-traces")
    if not target: return
    path = Path(target); path.mkdir(parents=True, exist_ok=True)
    summary = {"schema": "dry-run.pytest-summary.v1", "exitStatus": exitstatus, "passed": exitstatus == 0, "testsCollected": int(getattr(session, "testscollected", 0))}
    (path / "pytest-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


def pytest_report_header(config: Any) -> str:
    endpoint = config.getoption("--dry-run-endpoint")
    return f"dry-run: {'remote ' + endpoint if endpoint else 'local evidence'}"


def pytest_fixture_setup(fixturedef: Any, request: Any) -> None:
    return None


def _tracer(config: Any) -> Tracer:
    exporters: list[Any] = []
    target = config.getoption("--dry-run-traces")
    if target: exporters.append(FileTraceExporter(target))
    endpoint = config.getoption("--dry-run-endpoint")
    token = os.environ.get("DRYRUN_TEAM_TOKEN")
    if endpoint and token:
        client = TeamClient(TeamClientOptions(endpoint=endpoint, token=token, project=config.getoption("--dry-run-project")))
        exporters.append(RemoteTraceExporter(client))
    return Tracer(exporters)


def pytest_generate_tests(metafunc: Any) -> None:
    if "dryrun_tracer" in metafunc.fixturenames: metafunc.parametrize("dryrun_tracer", [_tracer(metafunc.config)], scope="session")


__all__: list[str] = []
