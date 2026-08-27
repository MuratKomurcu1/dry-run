from __future__ import annotations

import asyncio
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class TeamClientError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise TeamClientError("Refusing to forward a bearer token through an HTTP redirect", code)


@dataclass(frozen=True)
class TeamClientOptions:
    endpoint: str
    token: str
    project: str = "default"
    timeout: float = 30.0
    allow_insecure_http: bool = False
    verify_tls: bool = True


class TeamClient:
    """Dependency-free synchronous/async client for the Dry Run team API."""

    def __init__(self, options: TeamClientOptions):
        parsed = urllib.parse.urlsplit(options.endpoint)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Team endpoint must be an absolute HTTP(S) origin without credentials, query, or fragment")
        if parsed.scheme == "http" and not options.allow_insecure_http and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("Plaintext remote team endpoints require allow_insecure_http=True")
        if not options.token.startswith("drk_") or len(options.token) < 20:
            raise ValueError("A Dry Run team token is required")
        if not options.project or "/" in options.project:
            raise ValueError("Project is invalid")
        self.options = options
        self.endpoint = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
        handlers: list[Any] = [_NoRedirect()]
        if parsed.scheme == "https":
            context = ssl.create_default_context() if options.verify_tls else ssl._create_unverified_context()  # noqa: SLF001
            handlers.append(urllib.request.HTTPSHandler(context=context))
        self._opener = urllib.request.build_opener(*handlers)

    def request(self, method: str, path: str, body: Any = None, *, expected: tuple[int, ...] = (200,)) -> Any:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("API path must be origin-relative")
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self.endpoint}{path}",
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.options.token}", "Accept": "application/json", **({"Content-Type": "application/json"} if data is not None else {})},
        )
        try:
            with self._opener.open(request, timeout=self.options.timeout) as response:
                payload = response.read()
                parsed = _json_or_none(payload)
                if response.status not in expected:
                    raise TeamClientError(_error_message(parsed, response.status), response.status, parsed)
                return parsed
        except urllib.error.HTTPError as error:
            payload = _json_or_none(error.read())
            raise TeamClientError(_error_message(payload, error.code), error.code, payload) from None
        except TeamClientError:
            raise
        except Exception as error:
            raise TeamClientError(f"Team request failed: {_safe_error(error)}") from error

    async def arequest(self, method: str, path: str, body: Any = None, *, expected: tuple[int, ...] = (200,)) -> Any:
        return await asyncio.to_thread(self.request, method, path, body, expected=expected)

    def me(self) -> dict[str, Any]:
        return self.request("GET", "/api/v1/me")

    def put_trace(self, trace: dict[str, Any]) -> dict[str, Any]:
        trace_id = _required_id(trace.get("id"), "trace id")
        return self.request("PUT", f"{self._project_path()}/traces/{_quote(trace_id)}", trace, expected=(202,))

    def ingest_traces(self, traces: list[dict[str, Any]]) -> dict[str, Any]:
        if not 1 <= len(traces) <= 500:
            raise ValueError("Trace batch must contain 1-500 documents")
        return self.request("POST", f"{self._project_path()}/traces", {"traces": traces}, expected=(202,))

    def traces(self, *, limit: int = 100, cursor: str | None = None, query: str | None = None) -> dict[str, Any]:
        params = {"limit": str(limit), **({"cursor": cursor} if cursor else {}), **({"q": query} if query else {})}
        return self.request("GET", f"{self._project_path()}/traces?{urllib.parse.urlencode(params)}")

    def trace(self, trace_id: str) -> dict[str, Any]:
        return self.request("GET", f"{self._project_path()}/traces/{_quote(_required_id(trace_id, 'trace id'))}")

    def ingest_experiment(self, experiment: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", f"{self._project_path()}/experiments", experiment, expected=(202,))

    def organization(self) -> dict[str, Any]:
        return self.request("GET", "/api/v1/admin/organization")

    def groups(self) -> dict[str, Any]:
        return self.request("GET", "/api/v1/admin/groups")

    def roles(self) -> dict[str, Any]:
        return self.request("GET", "/api/v1/admin/roles")

    def create_group(self, definition: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/api/v1/admin/groups", definition, expected=(201,))

    def create_role(self, definition: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/api/v1/admin/roles", definition, expected=(201,))

    def monitor_results(self, monitor_id: str, limit: int = 100) -> dict[str, Any]:
        return self.request("GET", f"{self._project_path()}/monitors/{_quote(_required_id(monitor_id, 'monitor id'))}/results?limit={int(limit)}")

    def _project_path(self) -> str:
        return f"/api/v1/projects/{_quote(self.options.project)}"


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _required_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 512 or any(ord(char) < 32 for char in value):
        raise ValueError(f"{label} is invalid")
    return value


def _json_or_none(value: bytes) -> Any:
    if not value:
        return None
    try:
        return json.loads(value.decode("utf-8"))
    except Exception:
        return None


def _error_message(value: Any, status: int) -> str:
    if isinstance(value, dict) and isinstance(value.get("error"), str):
        return value["error"][:500]
    return f"Team API returned HTTP {status}"


def _safe_error(error: Exception) -> str:
    text = str(error)
    if "@" in text and "://" in text:
        return "remote endpoint error"
    return text[:500]


__all__ = ["TeamClient", "TeamClientOptions", "TeamClientError"]
