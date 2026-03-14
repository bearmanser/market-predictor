from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

BASE_DIR = Path(__file__).resolve().parent.parent
DOTENV_PATH = BASE_DIR / ".env"
CACHE_DIR = BASE_DIR / "cache"
CACHE_FILE = CACHE_DIR / "twelve_data_daily.json"
TWELVE_DATA_URL = "https://api.twelvedata.com/time_series"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue

        key, value = stripped.split("=", 1)
        cleaned_value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), cleaned_value)


load_dotenv(DOTENV_PATH)

TWELVE_DATA_API_KEY = os.getenv("TWELVE_DATA_API_KEY", "")
TWELVE_DATA_SYMBOL = os.getenv("TWELVE_DATA_SYMBOL", "SPY")
TWELVE_DATA_DISPLAY_NAME = os.getenv("TWELVE_DATA_DISPLAY_NAME", "S&P 500 (SPY)")
CACHE_TTL_SECONDS = int(os.getenv("TWELVE_DATA_CACHE_TTL_SECONDS", "21600"))

app = FastAPI(title="Market Predictor API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def read_cache() -> dict[str, Any] | None:
    if not CACHE_FILE.exists():
        return None

    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_cache(payload: dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def parse_trading_date(raw_value: str) -> date:
    return date.fromisoformat(raw_value.split(" ")[0])


def parse_daily_series(values: list[dict[str, str]]) -> tuple[list[date], dict[date, dict[str, str]]]:
    parsed: dict[date, dict[str, str]] = {}
    for entry in values:
        trading_day = parse_trading_date(entry["datetime"])
        parsed[trading_day] = entry

    trading_days = sorted(parsed.keys())
    return trading_days, parsed


def group_weeks(trading_days: list[date]) -> list[tuple[date, list[date]]]:
    buckets: dict[date, list[date]] = {}

    for trading_day in trading_days:
        week_start = trading_day - timedelta(days=trading_day.weekday())
        buckets.setdefault(week_start, []).append(trading_day)

    return sorted(buckets.items(), key=lambda item: item[0], reverse=True)


async def fetch_daily_series() -> dict[str, Any]:
    if not TWELVE_DATA_API_KEY:
        raise HTTPException(status_code=500, detail="Twelve Data API key is not configured.")

    cached_payload = read_cache()
    now = datetime.now(timezone.utc)

    if cached_payload and "fetched_at" in cached_payload:
        try:
            fetched_at = datetime.fromisoformat(cached_payload["fetched_at"])
            if (now - fetched_at).total_seconds() < CACHE_TTL_SECONDS:
                return {**cached_payload, "cache_status": "fresh"}
        except ValueError:
            pass

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(
                TWELVE_DATA_URL,
                params={
                    "apikey": TWELVE_DATA_API_KEY,
                    "symbol": TWELVE_DATA_SYMBOL,
                    "interval": "1day",
                    "order": "ASC",
                    "outputsize": 5000,
                    "timezone": "America/New_York",
                },
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        if cached_payload:
            return {**cached_payload, "cache_status": "stale"}
        raise HTTPException(status_code=502, detail=f"Unable to reach Twelve Data: {exc}") from exc

    payload = response.json()

    if payload.get("status") == "error" or payload.get("code"):
        if cached_payload:
            return {**cached_payload, "cache_status": "stale"}
        message = payload.get("message", "Twelve Data returned an error.")
        raise HTTPException(status_code=502, detail=message)

    values = payload.get("values")
    metadata = payload.get("meta", {})

    if not isinstance(values, list) or not values:
        if cached_payload:
            return {**cached_payload, "cache_status": "stale"}
        raise HTTPException(status_code=502, detail="Twelve Data returned an unexpected payload.")

    normalized_payload = {
        "fetched_at": now.isoformat(),
        "metadata": metadata,
        "values": values,
    }
    write_cache(normalized_payload)
    return {**normalized_payload, "cache_status": "miss"}


@app.get("/api/health")
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/sp500/weekly")
async def get_weekly_sp500_data(
    week_offset: int = Query(default=0, ge=0, le=520),
) -> dict[str, Any]:
    payload = await fetch_daily_series()
    values = payload["values"]
    metadata = payload.get("metadata", {})
    trading_days, parsed_series = parse_daily_series(values)
    weekly_groups = group_weeks(trading_days)

    if not weekly_groups:
        raise HTTPException(status_code=404, detail="No trading data is available.")

    if week_offset >= len(weekly_groups):
        raise HTTPException(status_code=404, detail="That week is outside the available history.")

    week_start, selected_days = weekly_groups[week_offset]
    week_end = selected_days[-1]
    points: list[dict[str, Any]] = []

    for trading_day in selected_days:
        values_for_day = parsed_series[trading_day]
        close = float(values_for_day["close"])
        points.append(
            {
                "date": trading_day.isoformat(),
                "label": trading_day.strftime("%a"),
                "open": float(values_for_day["open"]),
                "high": float(values_for_day["high"]),
                "low": float(values_for_day["low"]),
                "close": close,
                "adjustedClose": close,
                "volume": int(float(values_for_day.get("volume", "0"))),
            }
        )

    opening_price = points[0]["open"]
    closing_price = points[-1]["close"]
    high_price = max(point["high"] for point in points)
    low_price = min(point["low"] for point in points)
    change = closing_price - opening_price
    change_percent = (change / opening_price) * 100 if opening_price else 0.0
    last_refreshed = trading_days[-1].isoformat() if trading_days else None

    return {
        "symbol": TWELVE_DATA_SYMBOL,
        "displayName": TWELVE_DATA_DISPLAY_NAME,
        "weekOffset": week_offset,
        "weekStart": week_start.isoformat(),
        "weekEnd": week_end.isoformat(),
        "availableWeeks": len(weekly_groups),
        "hasPrevious": week_offset < len(weekly_groups) - 1,
        "hasNext": week_offset > 0,
        "cacheStatus": payload.get("cache_status", "unknown"),
        "cachedAt": payload.get("fetched_at"),
        "lastRefreshed": last_refreshed,
        "summary": {
            "open": opening_price,
            "close": closing_price,
            "high": high_price,
            "low": low_price,
            "change": change,
            "changePercent": change_percent,
        },
        "points": points,
    }