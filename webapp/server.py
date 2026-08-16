#!/usr/bin/env python3
"""Small local API and static server for the battery power dashboard."""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


WEB_ROOT = Path(__file__).resolve().parent
STATE_ROOT = Path.home() / ".local" / "state" / "tomv.battery-usage"
DB_PATH = STATE_ROOT / "power.db"
THEME_COLORS_PATH = STATE_ROOT / "current" / "theme" / "colors.toml"

HOST = os.environ.get("BATTERY_STATS_HOST", "127.0.0.1")
PORT = int(os.environ.get("BATTERY_STATS_PORT", "8090"))
MAX_GAP_SECONDS = 60
MAX_CHART_POINTS = 2400
MAX_HISTORY_ROWS = 1_000_000
MIN_DISCHARGE_WATTS = 1.0
MIN_CHARGE_WATTS = 0.05

_daily_cache: tuple[float, dict[str, float]] | None = None


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def query_all(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    try:
        conn = db_connect()
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return []


def load_history(min_epoch: int | None = None, max_rows: int | None = None) -> list[tuple[int, float, float]]:
    """Fetch recorded samples, oldest first, via the indexed epoch column."""
    conditions = ["(discharge_watts > ? OR charge_watts > ?)"]
    params: list[object] = [MIN_DISCHARGE_WATTS, MIN_CHARGE_WATTS]
    if min_epoch is not None:
        conditions.append("epoch >= ?")
        params.append(min_epoch)
    sql = "SELECT epoch, discharge_watts, charge_watts FROM samples WHERE " + " AND ".join(conditions)
    if max_rows is not None:
        sql += " LIMIT ?"
        params.append(max_rows)
    rows = query_all(sql, tuple(params))
    return [(row[0], row[1], row[2]) for row in rows]


def latest_sample() -> tuple[float, float]:
    rows = query_all("SELECT discharge_watts, charge_watts FROM samples ORDER BY epoch DESC LIMIT 1")
    if not rows:
        return 0.0, 0.0
    return float(rows[0][0]), float(rows[0][1])


def retained_stats() -> dict[str, float | int]:
    rows = query_all(
        "SELECT COUNT(*) AS n, COALESCE(MAX(epoch), 0) - COALESCE(MIN(epoch), 0) AS span "
        "FROM samples WHERE discharge_watts > ?",
        (MIN_DISCHARGE_WATTS,),
    )
    row = rows[0] if rows else None
    return {"count": int(row[0]) if row else 0, "coverageSeconds": int(row[1]) if row else 0}


def load_daily() -> dict[str, float]:
    """Aggregate daily discharge energy from samples, cached briefly."""
    global _daily_cache

    now = time.time()
    if _daily_cache and now - _daily_cache[0] < 60:
        return _daily_cache[1]

    rows = query_all(
        """
        WITH t AS (
          SELECT epoch, discharge_watts,
                 LAG(epoch) OVER (ORDER BY epoch) AS prev,
                 date(epoch, 'unixepoch', 'localtime') AS day
          FROM samples
        )
        SELECT day, SUM(discharge_watts * (epoch - prev) / 3600.0)
        FROM t
        WHERE day IS NOT NULL AND prev IS NOT NULL AND epoch - prev <= ?
        GROUP BY day ORDER BY day
        """,
        (MAX_GAP_SECONDS,),
    )
    days = {row[0]: float(row[1]) for row in rows}
    _daily_cache = (now, days)
    return days


def parse_minutes(query: dict[str, list[str]], default: float | None = 60) -> float | None:
    raw = query.get("minutes", [None])[0]
    if raw is None:
        return default
    if raw.lower() in {"all", "∞"}:
        return None
    try:
        value = float(raw)
    except ValueError:
        return default
    if value <= 0:
        return None
    return value


def downsample(points: list[tuple[int, float, float]], limit: int = MAX_CHART_POINTS) -> list[tuple[int, float, float]]:
    if len(points) <= limit:
        return points

    bucket_count = max(1, (limit - 2) // 4)
    bucket_size = math.ceil(len(points) / bucket_count)
    selected: set[int] = {0, len(points) - 1}

    for start in range(0, len(points), bucket_size):
        end = min(len(points), start + bucket_size)
        bucket = points[start:end]
        if not bucket:
            continue
        maximum_discharge = max(range(len(bucket)), key=lambda index: bucket[index][1])
        maximum_charge = max(range(len(bucket)), key=lambda index: bucket[index][2])
        selected.update({start, start + maximum_discharge, start + maximum_charge, end - 1})

    return [points[index] for index in sorted(selected)]


def discharge_points(points: list[tuple[int, float, float]]) -> list[tuple[int, float]]:
    return [(epoch, discharge_watts) for epoch, discharge_watts, _ in points if discharge_watts > MIN_DISCHARGE_WATTS]


def calculate_stats(points: list[tuple[int, float]]) -> dict[str, float | int]:
    if not points:
        return {
            "count": 0,
            "averageWatts": 0.0,
            "peakWatts": 0.0,
            "minimumWatts": 0.0,
            "energyWh": 0.0,
            "coverageSeconds": 0,
        }

    energy = 0.0
    for previous, current in zip(points, points[1:]):
        delta = current[0] - previous[0]
        if 0 < delta <= MAX_GAP_SECONDS:
            energy += current[1] * delta / 3600

    return {
        "count": len(points),
        "averageWatts": sum(watts for _, watts in points) / len(points),
        "peakWatts": max(watts for _, watts in points),
        "minimumWatts": min(watts for _, watts in points),
        "energyWh": energy,
        "coverageSeconds": max(0, points[-1][0] - points[0][0]),
    }


def read_key_values(command: list[str]) -> dict[str, str]:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}

    values: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if "\t" not in line:
            continue
        key, value = line.split("\t", 1)
        values[key] = value.strip()
    return values


def first_number(value: str) -> float | None:
    match = re.search(r"-?\d+(?:\.\d+)?", value or "")
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def format_duration(hours: float | None) -> str:
    if hours is None or not math.isfinite(hours) or hours < 0:
        return "--"
    total_minutes = round(hours * 60)
    return f"{total_minutes // 60}h {total_minutes % 60:02d}m"


def read_theme() -> dict[str, str]:
    colors = {
        "background": "#0B0C16",
        "foreground": "#ddf7ff",
        "accent": "#82FB9C",
        "muted": "#2d3450",
    }
    pattern = re.compile(r"^\s*(background|foreground|accent|muted)\s*=\s*[\"']?(#[0-9A-Fa-f]{6})")
    try:
        for line in THEME_COLORS_PATH.read_text(encoding="utf-8").splitlines():
            match = pattern.match(line)
            if match:
                colors[match.group(1)] = match.group(2)
    except (FileNotFoundError, OSError):
        pass
    return colors


def build_summary(minutes: float | None) -> dict[str, object]:
    cutoff = int(time.time() - minutes * 60) if minutes is not None else None
    points = load_history(min_epoch=cutoff, max_rows=MAX_HISTORY_ROWS)
    stats = calculate_stats(discharge_points(points))
    retained = retained_stats()
    battery = read_key_values(["omarchy-battery-status", "--shell"])
    profile_values = read_key_values(["omarchy-powerprofiles-list", "--active-state"])
    active_profile = next((key for key, value in profile_values.items() if value == "1"), "")

    latest_discharge, latest_charge = latest_sample()
    battery_rate = first_number(battery.get("rate", "")) or 0.0
    current_watts = latest_discharge if battery.get("state") == "discharging" else 0.0
    if battery.get("state") == "discharging" and current_watts <= MIN_DISCHARGE_WATTS:
        current_watts = battery_rate
    current_charge_watts = latest_charge if battery.get("state") == "charging" else 0.0
    if battery.get("state") == "charging" and current_charge_watts <= 0.05:
        current_charge_watts = battery_rate
    average = float(stats["averageWatts"])
    size = first_number(battery.get("size", ""))
    percentage = first_number(battery.get("percentage", ""))
    runtime = None
    if battery.get("state") == "discharging" and size is not None and percentage is not None and average > MIN_DISCHARGE_WATTS:
        runtime = size * (percentage / 100) / average

    return {
        **stats,
        "rangeMinutes": minutes,
        "currentWatts": current_watts,
        "currentChargeWatts": current_charge_watts,
        "runtime": format_duration(runtime),
        "sampleStart": points[0][0] if points else None,
        "sampleEnd": points[-1][0] if points else None,
        "retainedCount": retained["count"],
        "retainedSeconds": retained["coverageSeconds"],
        "battery": battery,
        "activeProfile": active_profile,
        "serverTime": int(time.time()),
    }


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "BatteryStats/1.0"

    def send_bytes(self, body: bytes, content_type: str, status: int = 200, disposition: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        try:
            if parsed.path == "/api/history":
                minutes = parse_minutes(query, None)
                cutoff = int(time.time() - minutes * 60) if minutes is not None else None
                points = load_history(min_epoch=cutoff, max_rows=MAX_HISTORY_ROWS)
                self.send_json({
                    "minutes": minutes,
                    "count": len(points),
                    "samples": downsample(points),
                })
                return

            if parsed.path == "/api/summary":
                self.send_json(build_summary(parse_minutes(query, 60)))
                return

            if parsed.path == "/api/daily":
                days = load_daily()
                requested_days = query.get("days", [None])[0]
                if requested_days:
                    try:
                        days = dict(sorted(days.items())[-max(1, int(requested_days)):])
                    except ValueError:
                        pass
                self.send_json({"days": [[date, value] for date, value in sorted(days.items())]})
                return

            if parsed.path == "/api/theme":
                self.send_json(read_theme())
                return

            if parsed.path == "/api/health":
                samples = query_all("SELECT COUNT(*) FROM samples")
                self.send_json({
                    "ok": True,
                    "database": DB_PATH.exists(),
                    "samples": int(samples[0][0]) if samples else 0,
                    "serverTime": int(time.time()),
                })
                return

            if parsed.path == "/api/export":
                minutes = parse_minutes(query, None)
                cutoff = int(time.time() - minutes * 60) if minutes is not None else None
                points = load_history(min_epoch=cutoff, max_rows=MAX_HISTORY_ROWS)
                export_format = query.get("format", ["csv"])[0].lower()
                if export_format == "json":
                    body = json.dumps(
                        {"minutes": minutes, "samples": points},
                        indent=2,
                    ).encode("utf-8")
                    self.send_bytes(
                        body,
                        "application/json; charset=utf-8",
                        disposition='attachment; filename="battery-power.json"',
                    )
                    return

                lines = ["epoch,discharge_watts,charge_watts"]
                lines.extend(f"{epoch},{discharge:.3f},{charge:.3f}" for epoch, discharge, charge in points)
                self.send_bytes(
                    ("\n".join(lines) + "\n").encode("utf-8"),
                    "text/csv; charset=utf-8",
                    disposition='attachment; filename="battery-power.csv"',
                )
                return

            self.serve_static(parsed.path)
        except Exception as error:  # Keep the local dashboard alive on bad input.
            self.send_json({"error": str(error)}, 500)

    def serve_static(self, request_path: str) -> None:
        relative = unquote(request_path).lstrip("/") or "index.html"
        candidate = (WEB_ROOT / relative).resolve()
        try:
            candidate.relative_to(WEB_ROOT)
        except ValueError:
            self.send_json({"error": "not found"}, 404)
            return

        if not candidate.is_file():
            self.send_json({"error": "not found"}, 404)
            return

        content_types = {
            ".css": "text/css; charset=utf-8",
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
        }
        content_type = content_types.get(candidate.suffix, "application/octet-stream")
        self.send_bytes(candidate.read_bytes(), content_type)

    def log_message(self, format: str, *args: object) -> None:
        print(f"battery-stats: {format % args}", flush=True)


class ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    server = ReusableServer((HOST, PORT), DashboardHandler)
    print(f"battery-stats listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
