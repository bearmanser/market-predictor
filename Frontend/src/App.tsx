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

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
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

function formatVolume(volume: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(volume);
}

function formatConfidence(confidenceLevel: number) {
  return `${Math.round(confidenceLevel * 100)}%`;
}

function CustomTooltip({
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
      <span>{`NGBoost forecast: ${currencyFormatter.format(
        point.prediction
      )}`}</span>
      <span>
        {`Band: ${currencyFormatter.format(
          point.predictionLower
        )} to ${currencyFormatter.format(point.predictionUpper)}`}
      </span>
      <span>{`Volume: ${formatVolume(point.volume)}`}</span>
    </div>
  );
}

function App() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [confidencePercent, setConfidencePercent] = useState(80);
  const [data, setData] = useState<WeeklyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadWeeklyData() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/sp500/weekly?week_offset=${weekOffset}&confidence_level=${
            confidencePercent / 100
          }`,
          {
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            detail?: string;
          } | null;
          throw new Error(payload?.detail ?? "Unable to load market data.");
        }

        const payload = (await response.json()) as WeeklyResponse;
        setData(payload);
      } catch (fetchError) {
        if (
          fetchError instanceof DOMException &&
          fetchError.name === "AbortError"
        ) {
          return;
        }

        const message =
          fetchError instanceof Error
            ? fetchError.message
            : "Unable to load market data.";
        setError(message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadWeeklyData();

    return () => controller.abort();
  }, [confidencePercent, weekOffset]);

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
  const chartPadding =
    chartValues.length > 0 ? Math.max((chartMax - chartMin) * 0.12, 4) : 4;

  console.log(chartPoints);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Weekly market pulse</p>
          <h1>{data?.displayName ?? "S&P 500"} NGBoost forecast</h1>
          <p className="hero-text">
            Train the backend model on a configurable historical window, select
            the confidence band from the frontend, and compare actual closes
            with the projected range for any trading week.
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
              onChange={(event) =>
                setConfidencePercent(Number(event.target.value))
              }
              step="5"
              type="range"
              value={confidencePercent}
            />
          </div>
          <div className="hero-button-row">
            <button
              className="nav-button"
              onClick={() => setWeekOffset((current) => current + 1)}
              disabled={loading || !data?.hasPrevious}
              type="button"
            >
              Previous week
            </button>
            <button
              className="nav-button nav-button-primary"
              onClick={() =>
                setWeekOffset((current) => Math.max(current - 1, 0))
              }
              disabled={loading || !data?.hasNext}
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
          <strong>
            {data
              ? `${formatLongDate(data.weekStart)} to ${formatLongDate(
                  data.weekEnd
                )}`
              : "Loading"}
          </strong>
        </div>
        <div className="status-card">
          <span className="status-label">Model training</span>
          <strong>
            {data
              ? `${formatLongDate(
                  data.trainingWindow.configuredStart
                )} to ${formatLongDate(data.trainingWindow.effectiveEnd)}`
              : "Loading"}
          </strong>
        </div>
        <div className="status-card">
          <span className="status-label">Training samples</span>
          <strong>
            {data ? `${data.trainingWindow.sampleCount} days` : "..."}
          </strong>
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
            <p
              className={`chart-change ${
                actualIsPositive ? "positive" : "negative"
              }`}
            >
              {summary
                ? `Actual: ${currencyFormatter.format(
                    summary.change
                  )} (${percentFormatter.format(summary.changePercent)}%)`
                : "Loading"}
            </p>
            <p
              className={`chart-subchange ${
                projectedIsPositive ? "positive" : "negative"
              }`}
            >
              {summary
                ? `Forecast: ${currencyFormatter.format(
                    summary.predictedChange
                  )} (${percentFormatter.format(
                    summary.predictedChangePercent
                  )}%)`
                : ""}
            </p>
          </div>
          <div className="chart-note">
            <span>{data?.symbol ?? "SPY"}</span>
            <span>
              {data
                ? `${formatConfidence(
                    data.confidenceLevel
                  )} band with recursive weekly forecast`
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
              <ComposedChart
                data={chartPoints}
                margin={{ top: 10, right: 18, left: -12, bottom: 0 }}
              >
                <defs></defs>
                <CartesianGrid
                  stroke="rgba(148, 163, 184, 0.16)"
                  vertical={false}
                />
                <XAxis
                  axisLine={false}
                  dataKey="label"
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickLine={false}
                />
                <YAxis
                  axisLine={false}
                  domain={[chartMin - chartPadding, chartMax + chartPadding]}
                  allowDataOverflow
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickFormatter={(value: number) => `$${value.toFixed(0)}`}
                  tickLine={false}
                  width={64}
                />
                <Tooltip content={<CustomTooltip />} />
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
            <div className="loading-overlay" aria-live="polite">
              <div className="spinner" />
            </div>
          ) : null}
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <span>Open</span>
          <strong>
            {summary ? currencyFormatter.format(summary.open) : "..."}
          </strong>
        </article>
        <article className="stat-card">
          <span>Close</span>
          <strong>
            {summary ? currencyFormatter.format(summary.close) : "..."}
          </strong>
        </article>
        <article className="stat-card">
          <span>Projected close</span>
          <strong>
            {summary ? currencyFormatter.format(summary.predictedClose) : "..."}
          </strong>
        </article>
        <article className="stat-card">
          <span>Projected band</span>
          <strong>
            {chartPoints.length > 0
              ? `${currencyFormatter.format(
                  chartPoints[chartPoints.length - 1].predictionLower
                )} to ${currencyFormatter.format(
                  chartPoints[chartPoints.length - 1].predictionUpper
                )}`
              : "..."}
          </strong>
        </article>
      </section>
    </main>
  );
}

export default App;
