import { useId, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { analyticsMessages } from "~/i18n/analytics";

export interface TrendPoint {
  key: string;
  /** The bucket as words ("5 Aug", "Week of 2 Aug"). */
  label: string;
  current: number;
  /** The comparison bucket's value and words, when there is one. */
  previous: number | null;
  previousLabel: string | null;
}

const WIDTH = 720;
const HEIGHT = 200;
const TOP = 8;

/** A clean axis top (1, 2, 2.5 or 5 × 10ⁿ) at or above the largest value. */
export function niceMaximum(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

function x(index: number, count: number): number {
  return count <= 1 ? WIDTH / 2 : (index / (count - 1)) * WIDTH;
}

function y(value: number, max: number): number {
  return HEIGHT - (Math.max(0, value) / max) * (HEIGHT - TOP);
}

function path(values: Array<number | null>, max: number): string {
  let d = "";
  values.forEach((value, index) => {
    if (value === null) return;
    d += `${d ? "L" : "M"}${x(index, values.length).toFixed(1)},${y(value, max).toFixed(1)}`;
  });
  return d;
}

/**
 * Sales over time: the period as a 2px line over a 10% wash (the accent),
 * the comparison period as a dashed grey line, three clean ticks on one
 * axis. A crosshair follows the pointer to the nearest bucket and one
 * readout lists both periods; the chart is one tab stop read with the arrow
 * keys, Home and End. Two series always carry a legend.
 */
export function SalesTrendChart({
  points,
  format,
  label,
  currentName,
  previousName,
}: {
  points: TrendPoint[];
  format: (value: number) => string;
  label: string;
  currentName: string;
  previousName: string | null;
}) {
  const t = useMessages(analyticsMessages);
  const [active, setActive] = useState<number | null>(null);
  const washId = useId();
  const hasPrevious = previousName !== null && points.some((point) => point.previous !== null);
  const max = niceMaximum(Math.max(0, ...points.map((point) => Math.max(point.current, point.previous ?? 0))));
  const ticks = [max, max / 2, 0];
  const current = points.map((point) => point.current);
  const previous = points.map((point) => point.previous);
  const currentPath = path(current, max);
  const last = points.length - 1;
  const shown = active === null ? null : points[active];
  // The readout follows the crosshair and flips to its left past the middle.
  const flipTooltip = active !== null && active > last / 2;
  const crosshair = active === null ? 0 : (x(active, points.length) / WIDTH) * 100;
  const tipEdge = flipTooltip ? 100 - crosshair + 2 : crosshair + 2;

  const onKeyDown = (event: KeyboardEvent) => {
    const from = active ?? last;
    const next = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(Math.min(last, Math.max(0, next)));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || points.length === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    setActive(Math.min(last, Math.max(0, Math.round(ratio * last))));
  };

  return (
    <figure className="space-y-3">
      {hasPrevious ? (
        <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-muted-foreground">
          <span className="flex items-center gap-2">
            <svg width="16" height="8" aria-hidden><line x1="0" x2="16" y1="4" y2="4" className="stroke-chart-1" strokeWidth={2} strokeLinecap="round" /></svg>
            {currentName}
          </span>
          <span className="flex items-center gap-2">
            <svg width="16" height="8" aria-hidden><line x1="0" x2="16" y1="4" y2="4" className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="4 3" /></svg>
            {previousName}
          </span>
        </figcaption>
      ) : null}
      <div className="flex gap-2">
        {/* One axis: three clean ticks, in text tokens. */}
        <div className="flex h-48 shrink-0 flex-col justify-between py-0 text-end text-caption text-muted-foreground tabular-nums" aria-hidden>
          {ticks.map((tick) => <span key={tick} className="-my-2">{format(tick)}</span>)}
        </div>
        <div
          className="relative h-48 min-w-0 flex-1"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="size-full overflow-visible rounded-sm"
            role="img"
            tabIndex={0}
            aria-label={`${label}. ${t("chartKeys")}`}
            onKeyDown={onKeyDown}
            onFocus={() => setActive((value) => value ?? last)}
            onBlur={() => setActive(null)}
          >
            <defs>
              <linearGradient id={washId} x1="0" x2="0" y1="0" y2="1" className="text-chart-1">
                <stop offset="0" stopColor="currentColor" stopOpacity={0.12} />
                <stop offset="1" stopColor="currentColor" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={WIDTH}
                y1={y(tick, max)}
                y2={y(tick, max)}
                className="stroke-border"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hasPrevious ? (
              <path
                d={path(previous, max)}
                fill="none"
                className="stroke-muted-foreground"
                strokeWidth={2}
                strokeDasharray="5 4"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {currentPath && points.length > 1 ? (
              <path d={`${currentPath}L${WIDTH},${HEIGHT}L0,${HEIGHT}Z`} fill={`url(#${washId})`} />
            ) : null}
            <path
              d={currentPath}
              fill="none"
              className="stroke-chart-1"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {shown && active !== null ? (
              <line
                x1={x(active, points.length)}
                x2={x(active, points.length)}
                y1={0}
                y2={HEIGHT}
                className="stroke-muted-foreground"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          {/* Dots drawn in HTML so they stay round on a stretched chart: 8px with a 2px surface ring. */}
          {points.length > 0 ? (
            <span
              aria-hidden
              className="pointer-events-none absolute top-(--dot-y) left-(--dot-x) size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-chart-1"
              style={{
                "--dot-x": `${(x(active ?? last, points.length) / WIDTH) * 100}%`,
                "--dot-y": `${(y(current[active ?? last] ?? 0, max) / HEIGHT) * 100}%`,
              } as CSSProperties}
            />
          ) : null}
          {shown ? (
            <div
              role="status"
              aria-live="polite"
              className={cn(
                "pointer-events-none absolute top-0 z-10 min-w-40 rounded-lg bg-popover px-3 py-2 text-body shadow-popover",
                flipTooltip ? "right-(--tip-edge)" : "left-(--tip-edge)",
              )}
              style={{ "--tip-edge": `${tipEdge}%` } as CSSProperties}
            >
              <p className="flex items-center gap-2">
                <svg width="12" height="8" aria-hidden><line x1="0" x2="12" y1="4" y2="4" className="stroke-chart-1" strokeWidth={2} /></svg>
                <span className="font-semibold tabular-nums">{format(shown.current)}</span>
                <span className="text-muted-foreground">{shown.label}</span>
              </p>
              {hasPrevious && shown.previous !== null ? (
                <p className="flex items-center gap-2">
                  <svg width="12" height="8" aria-hidden><line x1="0" x2="12" y1="4" y2="4" className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="3 2" /></svg>
                  <span className="font-semibold tabular-nums">{format(shown.previous)}</span>
                  <span className="text-muted-foreground">{shown.previousLabel}</span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="ms-14 flex justify-between text-caption text-muted-foreground" aria-hidden>
        <span>{points[0]?.label}</span>
        {points.length > 2 ? <span>{points[Math.floor(last / 2)]?.label}</span> : null}
        <span>{points.length > 1 ? points[last]?.label : null}</span>
      </div>
    </figure>
  );
}
