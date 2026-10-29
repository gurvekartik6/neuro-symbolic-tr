
"""Allowlisted HTTP API execution with automatic evidence capture.

Configure named tools in NSCR_HTTP_TOOLS_JSON. Browser/model inputs may choose a
configured tool name and parameters, but can never supply an arbitrary URL.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit, parse_qsl
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_RESPONSE_CHARS = 4000
MAX_BODY_BYTES = 1_000_000
ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = build_opener(NoRedirect())


def _load_tools() -> dict[str, dict[str, Any]]:
    raw = os.getenv("NSCR_HTTP_TOOLS_JSON", "").strip()

    if not raw:
        return {}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"NSCR_HTTP_TOOLS_JSON is invalid JSON: {exc.msg}"
        ) from exc

    if not isinstance(data, dict):
        raise RuntimeError(
            "NSCR_HTTP_TOOLS_JSON must be a JSON object keyed by tool name."
        )

    tools = {}

    for name, config in data.items():
        if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", name):
            raise RuntimeError(f"Invalid configured tool name: {name!r}")

        if not isinstance(config, dict):
            raise RuntimeError(
                f"Tool {name} configuration must be an object."
            )

        method = str(config.get("method", "GET")).upper()
        url = config.get("url")

        if method not in ALLOWED_METHODS:
            raise RuntimeError(
                f"Tool {name}: unsupported HTTP method {method}."
            )

        if not isinstance(url, str):
            raise RuntimeError(f"Tool {name} must define a fixed URL.")

        parsed = urlsplit(url)

        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise RuntimeError(
                f"Tool {name} URL must be a fixed HTTPS URL "
                "without embedded credentials."
            )

        if any(char in url for char in "\r\n"):
            raise RuntimeError(
                f"Tool {name} URL contains invalid characters."
            )

        try:
            timeout = float(config.get("timeout_seconds", 20))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                f"Tool {name} timeout_seconds must be numeric."
            ) from exc

        if timeout < 1 or timeout > 60:
            raise RuntimeError(
                f"Tool {name} timeout_seconds must be between 1 and 60."
            )

        headers = config.get("headers", {})

        if not isinstance(headers, dict) or any(
            not isinstance(k, str) or not isinstance(v, str)
            for k, v in headers.items()
        ):
            raise RuntimeError(
                f"Tool {name} headers must be string key/value pairs."
            )

        query_fields = config.get("query_fields", [])
        body_fields = config.get("body_fields", [])
        success_statuses = config.get(
            "success_statuses",
            list(range(200, 300)),
        )

        if not isinstance(query_fields, list) or not all(
            isinstance(value, str) for value in query_fields
        ):
            raise RuntimeError(
                f"Tool {name} query_fields must be an array of strings."
            )

        if not isinstance(body_fields, list) or not all(
            isinstance(value, str) for value in body_fields
        ):
            raise RuntimeError(
                f"Tool {name} body_fields must be an array of strings."
            )

        if not isinstance(success_statuses, list) or not all(
            isinstance(value, int) for value in success_statuses
        ):
            raise RuntimeError(
                f"Tool {name} success_statuses must be an array of HTTP codes."
            )

        tools[name] = {
            "name": name,
            "description": str(
                config.get("description", "Configured external API")
            )[:300],
            "method": method,
            "url": url,
            "headers": headers,
            "timeout_seconds": timeout,
            "query_fields": query_fields,
            "body_fields": body_fields,
            "success_statuses": success_statuses,
        }

    return tools


def list_tools() -> list[dict[str, str]]:
    """Return safe tool metadata without credentials or full URLs."""
    output = []

    for name, tool in _load_tools().items():
        host = urlsplit(tool["url"]).hostname or "configured host"

        output.append({
            "name": name,
            "description": tool["description"],
            "method": tool["method"],
            "host": host,
            "requires_external_confirmation": (
                tool["method"] in MUTATING_METHODS
            ),
        })

    return output


def _substitute_env(value: str) -> str:
    """Expand ${ENV_VAR} in server-side HTTP header values."""
    pattern = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")

    def replace(match):
        env_value = os.getenv(match.group(1))

        if not env_value:
            raise RuntimeError(
                f"Required environment variable {match.group(1)} is not set."
            )

        return env_value

    return pattern.sub(replace, value)


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except (TypeError, ValueError):
        return str(value)


def _redact(text: str) -> str:
    """Avoid saving common configured credential values in traces."""
    for key, value in os.environ.items():
        sensitive_name = any(
            word in key.upper()
            for word in (
                "TOKEN",
                "SECRET",
                "API_KEY",
                "PASSWORD",
                "AUTH",
            )
        )

        if sensitive_name and value and len(value) >= 4:
            text = text.replace(value, "[REDACTED]")

    return text[:MAX_RESPONSE_CHARS]


def _make_url(
    template: str,
    params: dict[str, Any],
    query_fields: list[str],
) -> str:
    """Fill configured path placeholders and approved query parameters."""

    def path_replace(match):
        key = match.group(1)

        if key not in params:
            raise ValueError(
                f"Missing required path parameter: {key}"
            )

        return quote(str(params[key]), safe="")

    url = re.sub(
        r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}",
        path_replace,
        template,
    )

    parsed = urlsplit(url)
    existing = list(
        parse_qsl(parsed.query, keep_blank_values=True)
    )

    for field in query_fields:
        if field in params:
            value = params[field]

            if isinstance(value, (dict, list)):
                value = _safe_json(value)

            existing.append((field, str(value)))

    return urlunsplit((
        parsed.scheme,
        parsed.netloc,
        parsed.path,
        urlencode(existing),
        parsed.fragment,
    ))


def _event(
    step_id: str,
    status: str,
    source: str,
    input_text: str,
    output_text: str,
    started: datetime,
    preconditions: bool | None,
    postconditions: bool | None,
) -> dict[str, Any]:
    return {
        "event_id": f"api_{uuid.uuid4().hex[:16]}",
        "step_id": step_id,
        "timestamp": started.isoformat(),
        "status": status,
        "input_observation": input_text[:5000],
        "output_observation": output_text[:5000],
        "source": source,
        "preconditions_met": preconditions,
        "postconditions_met": postconditions,
    }


def execute_plan(
    plan: dict[str, Any],
    bindings: list[dict[str, Any]],
    confirm_external_actions: bool = False,
) -> list[dict[str, Any]]:
    """Execute explicitly bound APIs and return actual HTTP-result events.

    Binding example:
    {
        "step_id": "step_1",
        "tool_name": "lookup_item",
        "parameters": {"item_id": "123"}
    }

    API URLs and credentials come only from server-side configuration.
    """
    tools = _load_tools()

    if not tools:
        raise RuntimeError(
            "No HTTP tools are configured. "
            "Set NSCR_HTTP_TOOLS_JSON in .env first."
        )

    if not isinstance(bindings, list) or len(bindings) > 20:
        raise ValueError(
            "bindings must be a JSON array with at most 20 items."
        )

    by_step = {}

    for binding in bindings:
        if not isinstance(binding, dict):
            raise ValueError("Each binding must be an object.")

        step_id = binding.get("step_id")
        tool_name = binding.get("tool_name")
        parameters = binding.get("parameters", {})

        if not isinstance(step_id, str) or not step_id:
            raise ValueError("Every binding needs a step_id.")

        if step_id in by_step:
            raise ValueError(
                f"Only one API tool binding is allowed per step: {step_id}"
            )

        if tool_name not in tools:
            raise ValueError(
                f"Tool {tool_name!r} is not in the server allowlist."
            )

        if not isinstance(parameters, dict):
            raise ValueError(
                f"parameters for {step_id} must be a JSON object."
            )

        by_step[step_id] = {
            "tool_name": tool_name,
            "parameters": parameters,
        }

    steps = plan.get("steps", [])
    valid_ids = {
        step.get("id")
        for step in steps
    }

    unknown = set(by_step) - valid_ids

    if unknown:
        raise ValueError(
            f"Bindings reference unknown plan step IDs: {sorted(unknown)}"
        )

    outcomes: dict[str, str] = {}
    events = []

    for step in steps:
        step_id = step["id"]
        started = datetime.now(timezone.utc)
        binding = by_step.get(step_id)
        dependencies = step.get("depends_on", [])

        blocked = [
            dep for dep in dependencies
            if outcomes.get(dep) != "succeeded"
        ]

        if blocked:
            outcomes[step_id] = "skipped"

            events.append(_event(
                step_id,
                "skipped",
                "nscr_dependency_guard",
                f"Step dependencies: {dependencies}",
                (
                    "Skipped because prerequisite step(s) did not "
                    f"succeed: {blocked}"
                ),
                started,
                False,
                False,
            ))
            continue

        if binding is None:
            outcomes[step_id] = "skipped"

            events.append(_event(
                step_id,
                "skipped",
                "nscr_no_tool_binding",
                f"Planned action: {step.get('action', '')}",
                (
                    "No configured API tool binding was supplied "
                    "for this step; no external action was attempted."
                ),
                started,
                None,
                None,
            ))
            continue

        tool = tools[binding["tool_name"]]
        method = tool["method"]

        if (
            method in MUTATING_METHODS
            and not confirm_external_actions
        ):
            outcomes[step_id] = "skipped"

            events.append(_event(
                step_id,
                "skipped",
                "nscr_safety_guard",
                f"Tool: {tool['name']}; method: {method}",
                (
                    "Skipped: this API method can change external state. "
                    "Tick the explicit confirmation checkbox before running it."
                ),
                started,
                False,
                False,
            ))
            continue

        params = binding["parameters"]
        allowed_query = tool["query_fields"]
        allowed_body = tool["body_fields"]

        permitted = (
            set(allowed_query)
            | set(allowed_body)
            | set(re.findall(
                r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}",
                tool["url"],
            ))
        )

        extras = set(params) - permitted

        if extras:
            outcomes[step_id] = "failed"

            events.append(_event(
                step_id,
                "failed",
                "nscr_parameter_guard",
                (
                    f"Tool: {tool['name']}; "
                    f"parameter names: {sorted(params)}"
                ),
                f"Rejected unconfigured parameter(s): {sorted(extras)}",
                started,
                True,
                False,
            ))
            continue

        try:
            url = _make_url(
                tool["url"],
                params,
                allowed_query,
            )

            headers = {
                key: _substitute_env(value)
                for key, value in tool["headers"].items()
            }

            headers.setdefault("Accept", "application/json")
            body = None

            if method in {"POST", "PUT", "PATCH"}:
                payload = {
                    field: params[field]
                    for field in allowed_body
                    if field in params
                }

                body = json.dumps(
                    payload,
                    ensure_ascii=False,
                ).encode("utf-8")

                headers.setdefault(
                    "Content-Type",
                    "application/json",
                )

            request = Request(
                url,
                data=body,
                headers=headers,
                method=method,
            )

            started_monotonic = time.monotonic()

            try:
                with _OPENER.open(
                    request,
                    timeout=tool["timeout_seconds"],
                ) as response:
                    status_code = response.status
                    raw_body = response.read(MAX_BODY_BYTES + 1)

            except HTTPError as exc:
                status_code = exc.code
                raw_body = exc.read(MAX_BODY_BYTES + 1)

            duration = round(
                time.monotonic() - started_monotonic,
                3,
            )

            if len(raw_body) > MAX_BODY_BYTES:
                raw_body = (
                    raw_body[:MAX_BODY_BYTES]
                    + b"[TRUNCATED]"
                )

            decoded = raw_body.decode(
                "utf-8",
                errors="replace",
            )
            response_excerpt = _redact(decoded)

            success = status_code in tool["success_statuses"]
            outcomes[step_id] = (
                "succeeded" if success else "failed"
            )

            input_text = _safe_json({
                "tool": tool["name"],
                "method": method,
                "parameters": params,
            })

            output_text = (
                f"HTTP {status_code}; duration={duration}s; "
                f"response={response_excerpt}"
            )

            events.append(_event(
                step_id,
                outcomes[step_id],
                f"http_api:{tool['name']}",
                _redact(input_text),
                output_text,
                started,
                True,
                success,
            ))

        except (
            URLError,
            TimeoutError,
            OSError,
            ValueError,
            RuntimeError,
        ) as exc:
            outcomes[step_id] = "failed"

            events.append(_event(
                step_id,
                "failed",
                f"http_api:{tool['name']}",
                _redact(_safe_json({
                    "tool": tool["name"],
                    "method": method,
                    "parameter_names": sorted(params),
                })),
                _redact(f"{type(exc).__name__}: {exc}"),
                started,
                True,
                False,
            ))

    return events
