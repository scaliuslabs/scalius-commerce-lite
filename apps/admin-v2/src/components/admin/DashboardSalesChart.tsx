import { useState, type KeyboardEvent } from "react";
import { formatDateTime, useMessages } from "~/i18n";
import { homeMessages } from "~/i18n/home";

export interface DailySales {
  date: string; // YYYY-MM-DD (store time)
  orders: number;
  revenue: number;
}

const WIDTH = 600;
const HEIGHT = 160;
const GAP = 2;
// Bars use the primary token until the design system exposes chart colours.

function dayLabel(date: string, options: Intl.DateTimeFormatOptions) {
  return formatDateTime(new Date(`${date}T12:00:00+06:00`), options);
}

/**
 * Daily sales as thin bars (one series, so no legend: the card title names it)
 * under a line marking the best day's value. The chart is one tab stop: arrow
 * keys, Home and End move between days, and the readout above names the day.
 */
export function DashboardSalesChart({ days, money }: { days: DailySales[]; money: (value: number) => string }) {
  const t = useMessages(homeMessages);
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => day.revenue));
  const slot = WIDTH / Math.max(1, days.length);
  const barWidth = Math.max(2, slot * 0.6 - GAP);
  const describe = (day: DailySales) =>
    t("salesOn", { date: dayLabel(day.date, { day: "numeric", month: "short" }), sales: money(day.revenue), orders: day.orders });
  const shown = active === null ? null : days[active];

  const onKeyDown = (event: KeyboardEvent) => {
    const last = days.length - 1;
    const current = active ?? last;
    const next = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(Math.min(last, Math.max(0, next)));
  };

  return (
    <figure className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <p className="min-h-5 text-body text-muted-foreground" aria-live="polite">
          {shown ? describe(shown) : null}
        </p>
        {/* The scale: the dashed line under it is the best day's sales. */}
        <span className="shrink-0 text-caption text-muted-foreground tabular-nums" title={t("chartMax")}>
          {money(max)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-40 w-full rounded-sm"
        role="img"
        tabIndex={0}
        aria-label={`${t("salesChart")}. ${t("chartKeys")}`}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((current) => current ?? days.length - 1)}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        <line x1={0} x2={WIDTH} y1={8.5} y2={8.5} strokeDasharray="4 4" className="stroke-border" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-border" vectorEffect="non-scaling-stroke" />
        {days.map((day, index) => {
          const height = day.revenue > 0 ? Math.max(3, (day.revenue / max) * (HEIGHT - 8)) : 0;
          return (
            <g key={day.date} onMouseEnter={() => setActive(index)}>
              <rect x={index * slot} y={0} width={slot} height={HEIGHT} className="fill-transparent" />
              {height > 0 ? (
                <rect
                  x={index * slot + (slot - barWidth) / 2}
                  y={HEIGHT - height}
                  width={barWidth}
                  height={height}
                  rx={Math.min(4, barWidth / 2)}
                  className={active === index ? "fill-primary" : "fill-primary opacity-70"}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex justify-between text-body text-muted-foreground">
        <span>{days[0] ? dayLabel(days[0].date, { day: "numeric", month: "short" }) : null}</span>
        <span>{days.length ? dayLabel(days[days.length - 1]!.date, { day: "numeric", month: "short" }) : null}</span>
      </figcaption>
    </figure>
  );
}
