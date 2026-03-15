import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Point = {
  date: string;
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjustedClose: number;
  volume: number;
  prediction: number;
  predictionLower: number;
  predictionUpper: number;
  predictionBand: number;
};

type WeeklyResponse = {
  symbol: string;
  displayName: string;
  weekOffset: number;
  weekStart: string;
  weekEnd: string;
  availableWeeks: number;
  hasPrevious: boolean;
  hasNext: boolean;
  cacheStatus: string;
  cachedAt: string | null;
  lastRefreshed: string | null;
  confidenceLevel: number;
  trainingWindow: {
    configuredStart: string;
    effectiveEnd: string;
    sampleCount: number;
  };
  summary: {
    open: number;
    close: number;
    high: number;
    low: number;
    change: number;
    changePercent: number;
    predictedClose: number;
    predictedChange: number;
    predictedChangePercent: number;
  };
  points: Point[];
};

type SimulationPoint = {
  weekStart: string;
  weekEnd: string;
  label: string;
  action: "buy" | "sell" | "hold";
  openingPrice: number;
  closingPrice: number;
  predictedClose: number;
  tradeValue: number;
  sharesTraded: number;
  cash: number;
  sharesHeld: number;
  holdingsValue: number;
  accountValue: number;
  trainingSampleCount: number;
};

type SimulatorResponse = {
  symbol: string;
  displayName: string;
  availableWeeks: number;
  weeksRequested: number;
  weeksSimulated: number;
  confidenceLevel: number;
  startingCash: number;
  tradeBudget: number;
  endingCash: number;
  endingHoldingsValue: number;
  endingAccountValue: number;
  netProfit: number;
  netProfitPercent: number;
  buyTrades: number;
  sellTrades: number;
  cacheStatus: string;
  cachedAt: string | null;
  lastRefreshed: string | null;
  history: SimulationPoint[];
};

type ErrorPayload = {
  detail?: string;
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const sharesFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const longDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatDateLabel(value: string) {
  return shortDateFormatter.format(new Date(`${value}T00:00:00`));
}

function formatLongDate(value: string) {
  return longDateFormatter.format(new Date(`${value}T00:00:00`));
}

function formatWeekRange(start: string, end: string) {
  return `${formatLongDate(start)} to ${formatLongDate(end)}`;
}

function formatVolume(volume: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(volume);
}

function formatConfidence(confidenceLevel: number) {
  return `${Math.round(confidenceLevel * 100)}%`;
}

function formatActionLabel(action: SimulationPoint["action"]) {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

async function fetchJson<T>(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
    throw new Error(payload?.detail ?? "Unable to load market data.");
  }

  return (await response.json()) as T;
}

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function WeeklyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Point }>;
}) {
  const point = payload?.[0]?.payload;

  if (!active || !point) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{`${formatDateLabel(point.date)} (${point.label})`}</strong>
      <span>{`Actual close: ${currencyFormatter.format(point.close)}`}</span>
      <span>{`NGBoost forecast: ${currencyFormatter.format(point.prediction)}`}</span>
      <span>
        {`Band: ${currencyFormatter.format(point.predictionLower)} to ${currencyFormatter.format(
          point.predictionUpper
        )}`}
      </span>
      <span>{`Volume: ${formatVolume(point.volume)}`}</span>
    </div>
  );
}

function SimulationTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: SimulationPoint }>;
}) {
  const point = payload?.[0]?.payload;

  if (!active || !point) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{formatWeekRange(point.weekStart, point.weekEnd)}</strong>
      <span>{`Action: ${formatActionLabel(point.action)}`}</span>
      <span>{`Open: ${currencyFormatter.format(point.openingPrice)}`}</span>
      <span>{`Predicted close: ${currencyFormatter.format(point.predictedClose)}`}</span>
      <span>{`End-of-week account: ${currencyFormatter.format(point.accountValue)}`}</span>
      <span>{`Cash: ${currencyFormatter.format(point.cash)} | Shares: ${sharesFormatter.format(
        point.sharesHeld
      )}`}</span>
    </div>
  );
}

function App() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [confidencePercent, setConfidencePercent] = useState(80);
  const [simulationWeeks, setSimulationWeeks] = useState(52);
  const [data, setData] = useState<WeeklyResponse | null>(null);
  const [simulationData, setSimulationData] = useState<SimulatorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [simulationLoading, setSimulationLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadWeeklyData() {
      setLoading(true);
      setError(null);

      try {
        const payload = await fetchJson<WeeklyResponse>(
          `/api/sp500/weekly?week_offset=${weekOffset}&confidence_level=${confidencePercent / 100}`,
          controller.signal
        );
        setData(payload);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          return;
        }

        setError(toErrorMessage(fetchError, "Unable to load market data."));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadWeeklyData();

    return () => controller.abort();
  }, [confidencePercent, weekOffset]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSimulationData() {
      setSimulationLoading(true);
      setSimulationError(null);

      try {
        const payload = await fetchJson<SimulatorResponse>(
          `/api/sp500/simulator?weeks_to_simulate=${simulationWeeks}&confidence_level=${
            confidencePercent / 100
          }`,
          controller.signal
        );
        setSimulationData(payload);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          return;
        }

        setSimulationError(toErrorMessage(fetchError, "Unable to load simulation."));
      } finally {
        if (!controller.signal.aborted) {
          setSimulationLoading(false);
        }
      }
    }

    void loadSimulationData();

    return () => controller.abort();
  }, [confidencePercent, simulationWeeks]);

  const maxSimulationWeeks = Math.min(
    simulationData?.availableWeeks ?? data?.availableWeeks ?? 520,
    520
  );

  useEffect(() => {
    if (simulationWeeks > maxSimulationWeeks) {
      setSimulationWeeks(maxSimulationWeeks);
    }
  }, [maxSimulationWeeks, simulationWeeks]);

  const summary = data?.summary;
  const actualIsPositive = (summary?.change ?? 0) >= 0;
  const projectedIsPositive = (summary?.predictedChange ?? 0) >= 0;
  const chartPoints = data?.points ?? [];
  const chartValues = chartPoints.flatMap((point) => [
    point.low,
    point.high,
    point.close,
    point.prediction,
    point.predictionLower,
    point.predictionUpper,
  ]);
  const chartMin = chartValues.length > 0 ? Math.min(...chartValues) : 0;
  const chartMax = chartValues.length > 0 ? Math.max(...chartValues) : 0;
  const chartPadding = chartValues.length > 0 ? Math.max((chartMax - chartMin) * 0.12, 4) : 4;

  const simulationPoints = simulationData?.history ?? [];
  const simulationIsPositive = (simulationData?.netProfit ?? 0) >= 0;
  const accountValues = simulationPoints.map((point) => point.accountValue);
  const accountMin = accountValues.length > 0 ? Math.min(...accountValues) : 0;
  const accountMax = accountValues.length > 0 ? Math.max(...accountValues) : 0;
  const accountPadding = accountValues.length > 0 ? Math.max((accountMax - accountMin) * 0.18, 40) : 40;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Weekly market pulse</p>
          <h1>{data?.displayName ?? "S&P 500"} forecast and trader simulator</h1>
          <p className="hero-text">
            Step through any historical week, then replay a trader who resets the model before each
            decision, buys $100 at the weekly open on bullish forecasts, and exits fully when the
            model turns bearish.
          </p>
        </div>

        <div className="hero-actions">
          <div className="confidence-card">
            <div>
              <span className="status-label">Confidence band</span>
              <strong>{confidencePercent}% interval</strong>
            </div>
            <input
              aria-label="Confidence band percentage"
              className="confidence-slider"
              max="95"
              min="60"
              onChange={(event) => setConfidencePercent(Number(event.target.value))}
              step="5"
              type="range"
              value={confidencePercent}
            />
          </div>

          <div className="confidence-card">
            <div>
              <span className="status-label">Simulation horizon</span>
              <strong>{simulationWeeks} weeks</strong>
            </div>
            <label className="number-field">
              <span>Weeks to simulate</span>
              <input
                aria-label="Weeks to simulate"
                className="weeks-input"
                max={maxSimulationWeeks}
                min="1"
                onChange={(event) => {
                  const nextValue = Number(event.target.value);
                  const safeValue = Number.isFinite(nextValue) ? Math.floor(nextValue) : 1;
                  setSimulationWeeks(Math.max(1, Math.min(maxSimulationWeeks, safeValue)));
                }}
                step="1"
                type="number"
                value={simulationWeeks}
              />
            </label>
            <p className="helper-text">
              The trader starts with $10,000, buys only at the start of a bullish week, and sells
              everything at the start of a bearish week.
            </p>
          </div>

          <div className="hero-button-row">
            <button
              className="nav-button"
              disabled={loading || !data?.hasPrevious}
              onClick={() => setWeekOffset((current) => current + 1)}
              type="button"
            >
              Previous week
            </button>
            <button
              className="nav-button nav-button-primary"
              disabled={loading || !data?.hasNext}
              onClick={() => setWeekOffset((current) => Math.max(current - 1, 0))}
              type="button"
            >
              Next week
            </button>
          </div>
        </div>
      </section>

      <section className="status-row">
        <div className="status-card">
          <span className="status-label">Week range</span>
          <strong>{data ? formatWeekRange(data.weekStart, data.weekEnd) : "Loading"}</strong>
        </div>
        <div className="status-card">
          <span className="status-label">Model training</span>
          <strong>
            {data
              ? `${formatLongDate(data.trainingWindow.configuredStart)} to ${formatLongDate(
                  data.trainingWindow.effectiveEnd
                )}`
              : "Loading"}
          </strong>
        </div>
        <div className="status-card">
          <span className="status-label">Training samples</span>
          <strong>{data ? `${data.trainingWindow.sampleCount} days` : "..."}</strong>
        </div>
        <div className="status-card">
          <span className="status-label">Cache</span>
          <strong>{data ? data.cacheStatus : "..."}</strong>
        </div>
      </section>

      <section className="chart-panel">
        <div className="chart-header">
          <div>
            <p className="chart-title">Actual close vs NGBoost prediction</p>
            <p className={`chart-change ${actualIsPositive ? "positive" : "negative"}`}>
              {summary
                ? `Actual: ${currencyFormatter.format(summary.change)} (${percentFormatter.format(
                    summary.changePercent
                  )}%)`
                : "Loading"}
            </p>
            <p className={`chart-subchange ${projectedIsPositive ? "positive" : "negative"}`}>
              {summary
                ? `Forecast: ${currencyFormatter.format(
                    summary.predictedChange
                  )} (${percentFormatter.format(summary.predictedChangePercent)}%)`
                : ""}
            </p>
          </div>
          <div className="chart-note">
            <span>{data?.symbol ?? "SPY"}</span>
            <span>
              {data
                ? `${formatConfidence(data.confidenceLevel)} band with recursive weekly forecast`
                : "Loading model signal..."}
            </span>
            <span>
              {data?.lastRefreshed
                ? `Last market day: ${formatLongDate(data.lastRefreshed)}`
                : ""}
            </span>
          </div>
        </div>

        <div className="chart-wrap">
          {error ? (
            <div className="empty-state">
              <div>
                <h2>Could not load this week</h2>
                <p>{error}</p>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={380}>
              <ComposedChart data={chartPoints} margin={{ top: 10, right: 18, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="label"
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickLine={false}
                />
                <YAxis
                  allowDataOverflow
                  axisLine={false}
                  domain={[chartMin - chartPadding, chartMax + chartPadding]}
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickFormatter={(value: number) => `$${value.toFixed(0)}`}
                  tickLine={false}
                  width={64}
                />
                <Tooltip content={<WeeklyTooltip />} />
                <Area
                  dataKey="predictionLower"
                  fill="transparent"
                  isAnimationActive={false}
                  stackId="prediction-band"
                  stroke="transparent"
                />
                <Area
                  dataKey="predictionBand"
                  fill="#f59e0b33"
                  isAnimationActive={false}
                  stackId="prediction-band"
                  stroke="transparent"
                />
                <Line
                  activeDot={{
                    fill: "#f8fafc",
                    r: 5,
                    stroke: "#f97316",
                    strokeWidth: 2,
                  }}
                  dataKey="prediction"
                  dot={false}
                  isAnimationActive={false}
                  name="NGBoost forecast"
                  stroke="#f59e0b"
                  strokeDasharray="6 6"
                  strokeWidth={3}
                  type="monotone"
                />
                <Line
                  activeDot={{
                    fill: "#f8fafc",
                    r: 5,
                    stroke: "#14b8a6",
                    strokeWidth: 2,
                  }}
                  dataKey="close"
                  dot={false}
                  name="Actual close"
                  stroke="#2dd4bf"
                  strokeWidth={3}
                  type="monotone"
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}

          {loading && !error ? (
            <div aria-live="polite" className="loading-overlay">
              <div className="spinner" />
            </div>
          ) : null}
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <span>Open</span>
          <strong>{summary ? currencyFormatter.format(summary.open) : "..."}</strong>
        </article>
        <article className="stat-card">
          <span>Close</span>
          <strong>{summary ? currencyFormatter.format(summary.close) : "..."}</strong>
        </article>
        <article className="stat-card">
          <span>Projected close</span>
          <strong>{summary ? currencyFormatter.format(summary.predictedClose) : "..."}</strong>
        </article>
        <article className="stat-card">
          <span>Projected band</span>
          <strong>
            {chartPoints.length > 0
              ? `${currencyFormatter.format(chartPoints[chartPoints.length - 1].predictionLower)} to ${currencyFormatter.format(
                  chartPoints[chartPoints.length - 1].predictionUpper
                )}`
              : "..."}
          </strong>
        </article>
      </section>

      <section className="chart-panel">
        <div className="chart-header">
          <div>
            <p className="chart-title">Trader account simulator</p>
            <p className={`chart-change ${simulationIsPositive ? "positive" : "negative"}`}>
              {simulationData
                ? `Ending account: ${currencyFormatter.format(simulationData.endingAccountValue)}`
                : "Loading"}
            </p>
            <p className={`chart-subchange ${simulationIsPositive ? "positive" : "negative"}`}>
              {simulationData
                ? `Net: ${currencyFormatter.format(simulationData.netProfit)} (${percentFormatter.format(
                    simulationData.netProfitPercent
                  )}%) over ${simulationData.weeksSimulated} weeks`
                : ""}
            </p>
          </div>
          <div className="chart-note">
            <span>{simulationData?.symbol ?? data?.symbol ?? "SPY"}</span>
            <span>
              {simulationData
                ? `${simulationData.buyTrades} buys, ${simulationData.sellTrades} full exits, ${currencyFormatter.format(
                    simulationData.tradeBudget
                  )} per bullish week`
                : "Replaying weekly trade decisions..."}
            </span>
            <span>
              {simulationData?.lastRefreshed
                ? `Last market day: ${formatLongDate(simulationData.lastRefreshed)}`
                : ""}
            </span>
          </div>
        </div>

        <div className="chart-wrap">
          {simulationError ? (
            <div className="empty-state">
              <div>
                <h2>Could not run the simulator</h2>
                <p>{simulationError}</p>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart
                data={simulationPoints}
                margin={{ top: 10, right: 18, left: -12, bottom: 0 }}
              >
                <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="label"
                  minTickGap={24}
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickLine={false}
                />
                <YAxis
                  allowDataOverflow
                  axisLine={false}
                  domain={[accountMin - accountPadding, accountMax + accountPadding]}
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickFormatter={(value: number) => `$${value.toFixed(0)}`}
                  tickLine={false}
                  width={72}
                />
                <Tooltip content={<SimulationTooltip />} />
                <Area
                  dataKey="accountValue"
                  fill="rgba(45, 212, 191, 0.14)"
                  isAnimationActive={false}
                  stroke="transparent"
                  type="monotone"
                />
                <Line
                  activeDot={{
                    fill: "#f8fafc",
                    r: 5,
                    stroke: "#2dd4bf",
                    strokeWidth: 2,
                  }}
                  dataKey="accountValue"
                  dot={false}
                  isAnimationActive={false}
                  name="Account value"
                  stroke="#2dd4bf"
                  strokeWidth={3}
                  type="monotone"
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}

          {simulationLoading && !simulationError ? (
            <div aria-live="polite" className="loading-overlay">
              <div className="spinner" />
            </div>
          ) : null}
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <span>Starting cash</span>
          <strong>
            {simulationData ? currencyFormatter.format(simulationData.startingCash) : "..."}
          </strong>
        </article>
        <article className="stat-card">
          <span>Ending cash</span>
          <strong>{simulationData ? currencyFormatter.format(simulationData.endingCash) : "..."}</strong>
        </article>
        <article className="stat-card">
          <span>Holdings value</span>
          <strong>
            {simulationData
              ? currencyFormatter.format(simulationData.endingHoldingsValue)
              : "..."}
          </strong>
        </article>
        <article className="stat-card">
          <span>Ending account</span>
          <strong>
            {simulationData
              ? currencyFormatter.format(simulationData.endingAccountValue)
              : "..."}
          </strong>
        </article>
      </section>
    </main>
  );
}

export default App;
