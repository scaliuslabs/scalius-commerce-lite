import * as React from "react";

import { cn } from "@scalius/shared/utils";

/**
 * Polaris IndexTable density: subdued header row, 14px rows, tabular numbers.
 *
 * The header row is sticky. While the table fits its width, the wrapper does
 * not scroll, so the header sticks to the page's scroll container, just
 * under the top bar, as the page scrolls (Polaris). When the columns are
 * wider than the card, the wrapper scrolls both ways inside a viewport-high
 * box and the header sticks to that box, so horizontal scrolling never
 * breaks it. Ancestors between the table and the page must use
 * `overflow-clip`, never `overflow-hidden`, or sticky stops working.
 */
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(({ className, ...props }, ref) => {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = React.useState(false);

  React.useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const table = wrapper?.firstElementChild;
    if (!wrapper || !table || typeof ResizeObserver === "undefined") return;
    const measure = () => setScrolls(table.scrollWidth > wrapper.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    observer.observe(table);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={wrapperRef}
      data-scrolls={scrolls || undefined}
      className="relative w-full data-[scrolls]:max-h-[calc(100svh-8rem)] data-[scrolls]:overflow-auto"
    >
      <table ref={ref} className={cn("w-full caption-bottom text-body", className)} {...props} />
    </div>
  );
});
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn("bg-muted [&_tr]:border-b", className)} {...props} />,
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />,
);
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("group border-b hover:bg-muted data-[state=selected]:bg-accent data-[state=selected]:hover:bg-secondary", className)}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

/*
 * Column layout from the list table (`data-table/column-attributes.ts`):
 * - `data-numeric`: right aligned, tabular, never wrapped.
 * - `data-pin`: when the table scrolls sideways (the wrapper's `data-scrolls`),
 *   the checkbox and title columns stick left and the actions column right,
 *   each with a soft fade over the content passing under it. Body cells then
 *   take the row's background so nothing shows through.
 */
const LAYOUT =
  "data-[numeric]:whitespace-nowrap data-[numeric]:text-right data-[numeric]:tabular-nums data-[pin=actions]:w-px data-[pin=actions]:whitespace-nowrap data-[pin=actions]:text-right data-[pin=primary]:min-w-40 in-data-[scrolls]:data-[pin]:sticky data-[pin=select]:left-0 data-[pin=primary]:left-0 data-[pin=primary]:data-[after-select]:left-10 data-[pin=actions]:right-0 in-data-[scrolls]:data-[pin=primary]:before:pointer-events-none in-data-[scrolls]:data-[pin=primary]:before:absolute in-data-[scrolls]:data-[pin=primary]:before:inset-y-0 in-data-[scrolls]:data-[pin=primary]:before:-right-3 in-data-[scrolls]:data-[pin=primary]:before:w-3 in-data-[scrolls]:data-[pin=primary]:before:bg-linear-to-r in-data-[scrolls]:data-[pin=primary]:before:from-foreground/10 in-data-[scrolls]:data-[pin=primary]:before:to-transparent in-data-[scrolls]:data-[pin=actions]:before:pointer-events-none in-data-[scrolls]:data-[pin=actions]:before:absolute in-data-[scrolls]:data-[pin=actions]:before:inset-y-0 in-data-[scrolls]:data-[pin=actions]:before:-left-3 in-data-[scrolls]:data-[pin=actions]:before:w-3 in-data-[scrolls]:data-[pin=actions]:before:bg-linear-to-l in-data-[scrolls]:data-[pin=actions]:before:from-foreground/10 in-data-[scrolls]:data-[pin=actions]:before:to-transparent";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        // Sticky with its own 1px bottom rule: a collapsed `border-b` would scroll away.
        // eslint-disable-next-line no-restricted-syntax -- the ::after line is the sticky border
        "sticky top-0 z-10 h-9 whitespace-nowrap bg-muted px-3 text-left align-middle text-caption font-medium text-muted-foreground after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border has-[[role=checkbox]]:w-10 has-[[role=checkbox]]:pr-0 in-data-[scrolls]:data-[pin]:z-20",
        LAYOUT,
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        "px-3 py-1.5 align-middle has-[[role=checkbox]]:pr-0 in-data-[scrolls]:data-[pin]:z-10 in-data-[scrolls]:data-[pin]:bg-card in-data-[scrolls]:data-[pin]:group-hover:bg-muted in-data-[scrolls]:data-[pin]:group-data-[state=selected]:bg-accent",
        LAYOUT,
        className,
      )}
      {...props}
    />
  ),
);
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
