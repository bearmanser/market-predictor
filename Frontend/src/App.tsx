import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
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
  summary: {
    open: number;
    close: number;
    high: number;
    low: number;
    change: number;
    changePercent: number;
  };
  points: Point[];
};

type TooltipValue = number | string | Array<number | string> | undefined;

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

function formatTooltipValue(value: TooltipValue, name: string) {
  if (typeof value === "number") {
    return [name === "volume" ? formatVolume(value) : currencyFormatter.format(value), name] as const;
  }

  if (typeof value === "string") {
    return [value, name] as const;
  }

  if (Array.isArray(value)) {
    return [value.join(" - "), name] as const;
  }

  return ["--", name] as const;
}

function App() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [data, setData] = useState<WeeklyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadWeeklyData() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/sp500/weekly?week_offset=${weekOffset}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
          throw new Error(payload?.detail ?? "Unable to load market data.");
        }

        const payload = (await response.json()) as WeeklyResponse;
        setData(payload);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          return;
        }

        const message =
          fetchError instanceof Error ? fetchError.message : "Unable to load market data.";
        setError(message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadWeeklyData();

    return () => controller.abort();
  }, [weekOffset]);

  const summary = data?.summary;
  const isPositive = (summary?.change ?? 0) >= 0;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Weekly market pulse</p>
          <h1>{data?.displayName ?? "S&P 500"} weekly graph</h1>
          <p className="hero-text">
            Browse one trading week at a time with cached Twelve Data market data and a responsive
            Recharts view.
          </p>
        </div>

        <div className="hero-actions">
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
            onClick={() => setWeekOffset((current) => Math.max(current - 1, 0))}
            disabled={loading || !data?.hasNext}
            type="button"
          >
            Next week
          </button>
        </div>
      </section>

      <section className="status-row">
        <div className="status-card">
          <span className="status-label">Week range</span>
          <strong>
            {data ? `${formatLongDate(data.weekStart)} to ${formatLongDate(data.weekEnd)}` : "Loading"}
          </strong>
        </div>
        <div className="status-card">
          <span className="status-label">Cache</span>
          <strong>{data ? data.cacheStatus : "..."}</strong>
        </div>
        <div className="status-card">
          <span className="status-label">Last refresh</span>
          <strong>{data?.lastRefreshed ?? "Waiting for data"}</strong>
        </div>
      </section>

      <section className="chart-panel">
        <div className="chart-header">
          <div>
            <p className="chart-title">Closing price</p>
            <p className={`chart-change ${isPositive ? "positive" : "negative"}`}>
              {summary
                ? `${currencyFormatter.format(summary.change)} (${percentFormatter.format(summary.changePercent)}%)`
                : "Loading"}
            </p>
          </div>
          <div className="chart-note">
            <span>{data?.symbol ?? "SPY"}</span>
            <span>{loading ? "Updating..." : "Daily candles summarized by close"}</span>
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
            <ResponsiveContainer width="100%" height={360}>
              <AreaChart data={data?.points ?? []} margin={{ top: 10, right: 18, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="closeGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#5eead4" stopOpacity={0.65} />
                    <stop offset="95%" stopColor="#5eead4" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(148, 163, 184, 0.16)" vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="label"
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickLine={false}
                />
                <YAxis
                  axisLine={false}
                  domain={["dataMin - 5", "dataMax + 5"]}
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickFormatter={(value: number) => `$${value.toFixed(0)}`}
                  tickLine={false}
                  width={64}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(15, 23, 42, 0.96)",
                    border: "1px solid rgba(148, 163, 184, 0.2)",
                    borderRadius: "16px",
                    boxShadow: "0 20px 45px rgba(2, 6, 23, 0.35)",
                  }}
                  formatter={(value, name) => formatTooltipValue(value as TooltipValue, String(name))}
                  itemStyle={{ color: "#e2e8f0", textTransform: "capitalize" }}
                  labelFormatter={(_, payload) => {
                    const point = payload?.[0]?.payload as Point | undefined;
                    return point ? `${formatDateLabel(point.date)} (${point.label})` : "";
                  }}
                />
                <Area
                  activeDot={{ fill: "#f8fafc", r: 5, stroke: "#14b8a6", strokeWidth: 2 }}
                  dataKey="close"
                  fill="url(#closeGradient)"
                  stroke="#2dd4bf"
                  strokeWidth={3}
                  type="monotone"
                />
              </AreaChart>
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
          <strong>{summary ? currencyFormatter.format(summary.open) : "..."}</strong>
        </article>
        <article className="stat-card">
          <span>Close</span>
          <strong>{summary ? currencyFormatter.format(summary.close) : "..."}</strong>
        </article>
        <article className="stat-card">
          <span>Weekly high</span>
          <strong>{summary ? currencyFormatter.format(summary.high) : "..."}</strong>
        </article>
        <article className="stat-card">
          <span>Weekly low</span>
          <strong>{summary ? currencyFormatter.format(summary.low) : "..."}</strong>
        </article>
      </section>
    </main>
  );
}

export default App;
