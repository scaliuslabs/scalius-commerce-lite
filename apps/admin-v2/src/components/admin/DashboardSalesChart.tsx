import { useState } from "react";
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
 * Daily sales as thin bars (one series, so no legend: the card title names it).
 * Each bar has a hover/focus readout and the whole chart has a text summary.
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

  return (
    <figure className="space-y-2">
      <p className="h-5 text-sm text-muted-foreground" aria-live="polite">
        {shown ? describe(shown) : null}
      </p>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-40 w-full"
        role="img"
        aria-label={t("salesChart")}
        onMouseLeave={() => setActive(null)}
      >
        <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-border" />
        {days.map((day, index) => {
          const height = day.revenue > 0 ? Math.max(3, (day.revenue / max) * (HEIGHT - 8)) : 0;
          return (
            <g key={day.date} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} tabIndex={0} aria-label={describe(day)}>
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
      <figcaption className="flex justify-between text-sm text-muted-foreground">
        <span>{days[0] ? dayLabel(days[0].date, { day: "numeric", month: "short" }) : null}</span>
        <span>{days.length ? dayLabel(days[days.length - 1]!.date, { day: "numeric", month: "short" }) : null}</span>
      </figcaption>
    </figure>
  );
}
