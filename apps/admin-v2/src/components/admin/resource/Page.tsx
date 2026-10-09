import type { HTMLAttributes } from "react";
import { cn } from "@scalius/shared/utils";

/**
 * Page widths by kind (DESIGN.md S8, Polaris Page): lists use the full
 * width; a record's detail or form page the default width (main ⅔ and side ⅓
 * from 1024px); settings and one-card tasks are narrow.
 */
export const PAGE_WIDTH = {
  index: "max-w-7xl",
  detail: "max-w-5xl",
  form: "max-w-5xl",
  settings: "max-w-3xl",
  task: "max-w-2xl",
} as const;

export type PageWidth = keyof typeof PAGE_WIDTH;

/** The page's column, centred at the width of its kind. */
export function Page({ width, className, ...props }: HTMLAttributes<HTMLDivElement> & { width: PageWidth }) {
  return <div data-page-width={width} className={cn("mx-auto w-full min-w-0", PAGE_WIDTH[width], className)} {...props} />;
}
