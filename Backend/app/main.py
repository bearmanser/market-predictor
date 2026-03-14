from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from math import pi
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from ngboost import NGBRegressor
from ngboost.distns import Normal
from sklearn.tree import DecisionTreeRegressor

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
MODEL_TRAINING_START_DATE = os.getenv("MODEL_TRAINING_START_DATE", "2014-01-01")
MODEL_TRAINING_END_DATE = os.getenv("MODEL_TRAINING_END_DATE", "")
MODEL_LOOKBACK_DAYS = int(os.getenv("MODEL_LOOKBACK_DAYS", "10"))
MODEL_MIN_TRAINING_SAMPLES = int(os.getenv("MODEL_MIN_TRAINING_SAMPLES", "90"))

MODEL_CACHE: dict[tuple[date, date], "TrainedNgboostModel"] = {}


@dataclass(slots=True)
class TrainedNgboostModel:
    model: NGBRegressor
    sample_count: int


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


def parse_optional_iso_date(raw_value: str, *, setting_name: str) -> date | None:
    stripped_value = raw_value.strip()
    if not stripped_value:
        return None

    try:
        return date.fromisoformat(stripped_value)
    except ValueError as exc:
        raise RuntimeError(f"{setting_name} must be an ISO date formatted like YYYY-MM-DD.") from exc


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


def build_close_series(
    trading_days: list[date],
    parsed_series: dict[date, dict[str, str]],
) -> list[float]:
    return [float(parsed_series[trading_day]["close"]) for trading_day in trading_days]


def create_feature_vector(
    target_day: date,
    recent_closes: list[float],
    series_position: int,
    total_points: int,
) -> list[float]:
    last_5 = recent_closes[-5:]
    last_10 = recent_closes[-MODEL_LOOKBACK_DAYS:]
    day_of_year = target_day.timetuple().tm_yday
    annual_angle = (2 * pi * day_of_year) / 366.0
    weekday = target_day.weekday()
    weekly_angle = (2 * pi * weekday) / 5.0
    position = series_position / max(total_points - 1, 1)

    lag_1 = recent_closes[-1]
    lag_2 = recent_closes[-2]
    lag_3 = recent_closes[-3]
    lag_5 = recent_closes[-5]
    lag_10 = recent_closes[-10]
    sma_5 = sum(last_5) / len(last_5)
    sma_10 = sum(last_10) / len(last_10)
    std_5 = float(np.std(last_5))
    std_10 = float(np.std(last_10))
    return_1 = (lag_1 / lag_2) - 1 if lag_2 else 0.0
    return_5 = (lag_1 / lag_5) - 1 if lag_5 else 0.0

    return [
        lag_1,
        lag_2,
        lag_3,
        lag_5,
        lag_10,
        sma_5,
        sma_10,
        std_5,
        std_10,
        lag_1 - lag_2,
        lag_1 - lag_5,
        return_1,
        return_5,
        float(weekday),
        float(target_day.month),
        float(np.sin(annual_angle)),
        float(np.cos(annual_angle)),
        float(np.sin(weekly_angle)),
        float(np.cos(weekly_angle)),
        position,
    ]


def get_configured_training_dates(trading_days: list[date]) -> tuple[date, date]:
    configured_start = parse_optional_iso_date(
        MODEL_TRAINING_START_DATE,
        setting_name="MODEL_TRAINING_START_DATE",
    )
    configured_end = parse_optional_iso_date(
        MODEL_TRAINING_END_DATE,
        setting_name="MODEL_TRAINING_END_DATE",
    )

    training_start = configured_start or trading_days[0]
    training_end = configured_end or trading_days[-1]

    if training_end < training_start:
        raise HTTPException(
            status_code=500,
            detail="Backend training period is invalid because the end date is before the start date.",
        )

    return training_start, training_end


def train_ngboost_model(
    trading_days: list[date],
    close_series: list[float],
    training_start: date,
    training_end: date,
) -> TrainedNgboostModel:
    cache_key = (training_start, training_end)
    cached_model = MODEL_CACHE.get(cache_key)
    if cached_model is not None:
        return cached_model

    feature_rows: list[list[float]] = []
    targets: list[float] = []

    for index in range(MODEL_LOOKBACK_DAYS, len(trading_days)):
        trading_day = trading_days[index]
        if trading_day < training_start or trading_day > training_end:
            continue

        recent_closes = close_series[index - MODEL_LOOKBACK_DAYS : index]
        feature_rows.append(
            create_feature_vector(
                trading_day,
                recent_closes,
                series_position=index,
                total_points=len(trading_days),
            )
        )
        targets.append(close_series[index])

    if len(feature_rows) < MODEL_MIN_TRAINING_SAMPLES:
        raise HTTPException(
            status_code=422,
            detail=(
                "Not enough training data is available for the configured backend training period. "
                "Widen the training dates or lower MODEL_MIN_TRAINING_SAMPLES."
            ),
        )

    model = NGBRegressor(
        Dist=Normal,
        Base=DecisionTreeRegressor(
            criterion="friedman_mse",
            max_depth=3,
            min_samples_leaf=5,
            random_state=7,
        ),
        natural_gradient=True,
        learning_rate=0.03,
        minibatch_frac=1.0,
        n_estimators=300,
        verbose=False,
        random_state=7,
    )
    model.fit(np.asarray(feature_rows, dtype=float), np.asarray(targets, dtype=float))

    trained_model = TrainedNgboostModel(model=model, sample_count=len(feature_rows))
    MODEL_CACHE[cache_key] = trained_model
    return trained_model


def find_last_trading_day_on_or_before(trading_days: list[date], target_day: date) -> date | None:
    for trading_day in reversed(trading_days):
        if trading_day <= target_day:
            return trading_day
    return None


def build_weekly_predictions(
    trading_days: list[date],
    close_series: list[float],
    selected_days: list[date],
    confidence_level: float,
) -> tuple[list[dict[str, float]], date, date, int]:
    configured_start, configured_end = get_configured_training_dates(trading_days)
    cutoff_day = selected_days[0] - timedelta(days=1)
    effective_training_end = min(configured_end, cutoff_day)

    if effective_training_end < configured_start:
        raise HTTPException(
            status_code=422,
            detail=(
                "The selected week starts before the configured training window has usable data. "
                "Move the backend training start earlier or choose a later week."
            ),
        )

    effective_training_day = find_last_trading_day_on_or_before(trading_days, effective_training_end)
    if effective_training_day is None:
        raise HTTPException(status_code=422, detail="No trading data exists before the selected week.")

    trained_model = train_ngboost_model(
        trading_days,
        close_series,
        training_start=configured_start,
        training_end=effective_training_day,
    )

    first_selected_index = trading_days.index(selected_days[0])
    recent_history = close_series[:first_selected_index]
    if len(recent_history) < MODEL_LOOKBACK_DAYS:
        raise HTTPException(
            status_code=422,
            detail="Not enough prior daily closes exist to build prediction features for the selected week.",
        )

    predictions: list[dict[str, float]] = []
    recursive_history = list(recent_history)

    for selected_day in selected_days:
        feature_vector = create_feature_vector(
            selected_day,
            recursive_history[-MODEL_LOOKBACK_DAYS:],
            series_position=len(recursive_history),
            total_points=len(trading_days) + len(selected_days),
        )
        predicted_distribution = trained_model.model.pred_dist(np.asarray([feature_vector], dtype=float))
        lower_percentile = (1.0 - confidence_level) / 2.0
        upper_percentile = 1.0 - lower_percentile
        predicted_mean = float(predicted_distribution.mean()[0])
        predicted_lower = float(predicted_distribution.ppf(lower_percentile)[0])
        predicted_upper = float(predicted_distribution.ppf(upper_percentile)[0])

        predictions.append(
            {
                "prediction": predicted_mean,
                "predictionLower": predicted_lower,
                "predictionUpper": predicted_upper,
                "predictionBand": predicted_upper - predicted_lower,
            }
        )
        recursive_history.append(predicted_mean)

    return predictions, configured_start, effective_training_day, trained_model.sample_count


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
    confidence_level: float = Query(default=0.8, gt=0.5, lt=0.999),
) -> dict[str, Any]:
    payload = await fetch_daily_series()
    values = payload["values"]
    trading_days, parsed_series = parse_daily_series(values)
    close_series = build_close_series(trading_days, parsed_series)
    weekly_groups = group_weeks(trading_days)

    if not weekly_groups:
        raise HTTPException(status_code=404, detail="No trading data is available.")

    if week_offset >= len(weekly_groups):
        raise HTTPException(status_code=404, detail="That week is outside the available history.")

    week_start, selected_days = weekly_groups[week_offset]
    week_end = selected_days[-1]
    weekly_predictions, training_start, training_end, training_sample_count = build_weekly_predictions(
        trading_days,
        close_series,
        selected_days,
        confidence_level,
    )
    points: list[dict[str, Any]] = []

    for trading_day, prediction in zip(selected_days, weekly_predictions, strict=True):
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
                **prediction,
            }
        )

    opening_price = points[0]["open"]
    closing_price = points[-1]["close"]
    high_price = max(point["high"] for point in points)
    low_price = min(point["low"] for point in points)
    change = closing_price - opening_price
    change_percent = (change / opening_price) * 100 if opening_price else 0.0
    predicted_close = points[-1]["prediction"]
    predicted_change = predicted_close - opening_price
    predicted_change_percent = (predicted_change / opening_price) * 100 if opening_price else 0.0
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
        "confidenceLevel": confidence_level,
        "trainingWindow": {
            "configuredStart": training_start.isoformat(),
            "effectiveEnd": training_end.isoformat(),
            "sampleCount": training_sample_count,
        },
        "summary": {
            "open": opening_price,
            "close": closing_price,
            "high": high_price,
            "low": low_price,
            "change": change,
            "changePercent": change_percent,
            "predictedClose": predicted_close,
            "predictedChange": predicted_change,
            "predictedChangePercent": predicted_change_percent,
        },
        "points": points,
    }
