import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Download,
  FileDiff,
  FileText,
  ImageIcon,
  Loader2,
  LockKeyhole,
  PackageSearch,
  RotateCcw,
  ShieldAlert,
  Table2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { AssistantMessagePart } from "@scalius/shared/assistant-contracts";
import { cn } from "@scalius/shared/utils";

import { Button } from "../../ui/button";
import { Progress } from "../../ui/progress";
import { safeAdminAssistantNavigationPath } from "./assistant-navigation";
import { AdminAssistantMessageContent } from "./AdminAssistantMessageContent";

interface AdminAssistantRichPartsProps {
  parts: AssistantMessagePart[];
  onNavigate?: (path: string) => void;
  onConfirm?: (actionId: string) => void;
  onRetry?: (actionId: string) => void;
  onUndo?: (actionId: string) => void;
}

export function AdminAssistantRichParts({
  parts,
  onNavigate,
  onConfirm,
  onRetry,
  onUndo,
}: AdminAssistantRichPartsProps) {
  const nextConfirmationExpiry = useMemo(
    () =>
      parts.reduce(
        (next, part) =>
          part.type === "confirmation" && part.expiresAt < next
            ? part.expiresAt
            : next,
        Number.POSITIVE_INFINITY,
      ),
    [parts],
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!Number.isFinite(nextConfirmationExpiry) || nextConfirmationExpiry <= now) {
      return undefined;
    }
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, nextConfirmationExpiry - now + 20),
    );
    return () => window.clearTimeout(timer);
  }, [nextConfirmationExpiry, now]);

  return (
    <div className="mt-3 space-y-2.5" data-assistant-rich-parts>
      {parts.map((part, index) => (
        <div key={getPartKey(part, index)}>
          {renderPart(part, { onNavigate, onConfirm, onRetry, onUndo }, now)}
        </div>
      ))}
    </div>
  );
}

type RichPartCallbacks = Omit<AdminAssistantRichPartsProps, "parts">;

function renderPart(
  part: AssistantMessagePart,
  callbacks: RichPartCallbacks,
  now: number,
): ReactNode {
  switch (part.type) {
    case "text":
      return <AdminAssistantMessageContent content={part.text} />;
    case "source":
      return (
        <PartFrame icon={<FileText />} title={part.label} tone="neutral">
          {part.description ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {part.description}
            </p>
          ) : null}
          <SafePathButton
            path={part.path}
            label="Open source"
            onNavigate={callbacks.onNavigate}
          />
        </PartFrame>
      );
    case "product_grid":
      return (
        <PartFrame
          icon={<PackageSearch />}
          title={part.title ?? "Products"}
          tone="neutral"
        >
          <div className="grid grid-cols-1 gap-2 min-[430px]:grid-cols-2">
            {part.products.map((product) => (
              <article
                key={product.id}
                className="overflow-hidden rounded-lg border border-border bg-background"
              >
                {product.imageUrl ? (
                  <img
                    src={product.imageUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-24 w-full bg-muted object-cover"
                  />
                ) : (
                  <div className="flex h-20 items-center justify-center bg-muted/60 text-muted-foreground">
                    <ImageIcon className="h-5 w-5" aria-hidden="true" />
                  </div>
                )}
                <div className="space-y-1.5 p-2.5">
                  <h3 className="line-clamp-2 text-xs font-semibold leading-4">
                    {product.title}
                  </h3>
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="text-[10px] capitalize text-muted-foreground">
                      {product.availability.replaceAll("_", " ")}
                    </span>
                    {product.price !== undefined && product.currency ? (
                      <span className="font-mono text-xs font-semibold">
                        {formatMoney(product.price, product.currency)}
                      </span>
                    ) : null}
                  </div>
                  {product.rationale ? (
                    <p className="line-clamp-3 text-[11px] leading-4 text-muted-foreground">
                      {product.rationale}
                    </p>
                  ) : null}
                  <SafePathButton
                    path={product.path}
                    label="Open product"
                    onNavigate={callbacks.onNavigate}
                  />
                </div>
              </article>
            ))}
          </div>
        </PartFrame>
      );
    case "comparison":
      return (
        <PartFrame icon={<Table2 />} title={part.title} tone="neutral">
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[440px] border-collapse text-left text-[11px]">
              <thead className="bg-muted/60">
                <tr>
                  <th scope="col" className="px-2.5 py-2 font-medium text-muted-foreground">
                    Detail
                  </th>
                  {part.products.map((product) => (
                    <th key={product.id} scope="col" className="px-2.5 py-2 font-semibold">
                      {product.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {part.rows.map((row) => (
                  <tr key={row.label} className="border-t border-border align-top">
                    <th scope="row" className="px-2.5 py-2 font-medium text-muted-foreground">
                      {row.label}
                    </th>
                    {part.products.map((product) => {
                      const cell = row.cells.find(
                        (candidate) => candidate.productId === product.id,
                      );
                      return (
                        <td key={product.id} className="px-2.5 py-2">
                          {cell?.status === "unknown"
                            ? "Unknown"
                            : cell?.status === "not_applicable"
                              ? "—"
                              : (cell?.value ?? "—")}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PartFrame>
      );
    case "table":
      return (
        <PartFrame icon={<Table2 />} title={part.title} tone="neutral">
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[360px] border-collapse text-[11px]">
              <thead className="bg-muted/60">
                <tr>
                  {part.columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={cn(
                        "px-2.5 py-2 font-medium text-muted-foreground",
                        column.align === "center" && "text-center",
                        column.align === "end" && "text-right",
                        column.align === "start" && "text-left",
                      )}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {part.rows.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    {part.columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          "px-2.5 py-2",
                          column.align === "center" && "text-center",
                          column.align === "end" && "text-right",
                          column.align === "start" && "text-left",
                        )}
                      >
                        {formatTableCell(row.cells[column.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {part.truncated ? (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Showing a bounded sample. Refine the request for a narrower result.
            </p>
          ) : null}
        </PartFrame>
      );
    case "chart":
      return (
        <PartFrame icon={<BarChart3 />} title={part.title} tone="neutral">
          <div className="space-y-3" role="img" aria-label={part.textSummary}>
            {part.series.map((series) => {
              const maximum = Math.max(...series.points.map((point) => point.value), 1);
              return (
                <div key={series.id} className="space-y-1.5">
                  <p className="text-[11px] font-medium">{series.label}</p>
                  {series.points.slice(0, 12).map((point) => (
                    <div key={point.label} className="grid grid-cols-[5rem_1fr_auto] items-center gap-2 text-[10px]">
                      <span className="truncate text-muted-foreground">{point.label}</span>
                      <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(2, (point.value / maximum) * 100)}%` }}
                        />
                      </span>
                      <span className="font-mono tabular-nums">{formatNumber(point.value)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            {part.textSummary}
          </p>
        </PartFrame>
      );
    case "form_draft":
      return (
        <PartFrame icon={<FileText />} title={part.title} tone="info">
          <dl className="divide-y divide-border rounded-md border border-border bg-background">
            {part.fields.map((field) => (
              <div key={field.field} className="grid grid-cols-[minmax(5rem,0.7fr)_1.3fr] gap-3 px-2.5 py-2 text-[11px]">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="break-words font-medium">
                  {field.sensitive ? "Protected value" : field.displayValue}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Draft only. Review the visible form before saving.
          </p>
        </PartFrame>
      );
    case "diff":
      return (
        <PartFrame icon={<FileDiff />} title={part.title} tone="warning">
          <div className="space-y-2">
            {part.changes.map((change) => (
              <div key={`${change.field}-${change.impact}`} className="rounded-md border border-border bg-background p-2.5 text-[11px]">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-medium">{change.field}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] capitalize text-muted-foreground">
                    {change.impact.replaceAll("_", " ")}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="mb-1 text-[9px] uppercase tracking-wide text-muted-foreground">Before</p>
                    <p className="break-words rounded bg-destructive/5 px-2 py-1.5 text-destructive/90">
                      {change.before ?? "Empty"}
                    </p>
                  </div>
                  <div>
                    <p className="mb-1 text-[9px] uppercase tracking-wide text-muted-foreground">After</p>
                    <p className="break-words rounded bg-emerald-500/10 px-2 py-1.5 text-emerald-800 dark:text-emerald-200">
                      {change.after ?? "Empty"}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </PartFrame>
      );
    case "confirmation": {
      const expired = part.expiresAt <= now;
      const highRisk = part.riskClass === "high_risk";
      return (
        <PartFrame icon={highRisk ? <ShieldAlert /> : <LockKeyhole />} title={part.title} tone={highRisk ? "danger" : "warning"}>
          <p className="text-xs leading-5">{part.summary}</p>
          {part.consequences.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
              {part.consequences.map((consequence) => (
                <li key={consequence}>{consequence}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock3 className="h-3 w-3" aria-hidden="true" />
              {expired ? "Confirmation expired" : `Expires ${formatRelativeExpiry(part.expiresAt, now)}`}
            </span>
            {callbacks.onConfirm ? (
              <Button
                type="button"
                size="sm"
                variant={highRisk ? "destructive" : "default"}
                className="h-8 text-xs"
                disabled={expired}
                onClick={() => {
                  if (part.expiresAt > Date.now()) callbacks.onConfirm?.(part.actionId);
                }}
              >
                {part.confirmLabel}
              </Button>
            ) : (
              <span className="rounded-md border border-border bg-background px-2 py-1 text-[10px] text-muted-foreground">
                Secure confirmation is not connected yet
              </span>
            )}
          </div>
        </PartFrame>
      );
    }
    case "progress": {
      const value =
        part.completed !== undefined && part.total
          ? Math.min(100, Math.round((part.completed / part.total) * 100))
          : undefined;
      return (
        <PartFrame icon={<Loader2 className={part.status === "running" ? "animate-spin motion-reduce:animate-none" : ""} />} title={part.label} tone="info">
          <div role="status" aria-live="polite" className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span className="capitalize">{part.status.replaceAll("_", " ")}</span>
              {part.completed !== undefined && part.total ? (
                <span className="font-mono tabular-nums">{part.completed} / {part.total}</span>
              ) : null}
            </div>
            {value !== undefined ? (
              <Progress value={value} aria-label={`${part.label}: ${value}%`} className="h-1.5" />
            ) : (
              <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
                <span className="block h-full w-1/3 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
              </div>
            )}
          </div>
        </PartFrame>
      );
    }
    case "result": {
      const failed = part.status === "failed";
      const partial = part.status === "partially_succeeded";
      return (
        <PartFrame
          icon={failed ? <XCircle /> : partial ? <AlertTriangle /> : <CheckCircle2 />}
          title={part.title}
          tone={failed ? "danger" : partial ? "warning" : "success"}
        >
          <p className="text-xs leading-5">{part.summary}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <SafePathButton path={part.resourcePath} label="View result" onNavigate={callbacks.onNavigate} />
            {part.undoActionId && callbacks.onUndo ? (
              <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => callbacks.onUndo?.(part.undoActionId!)}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Undo
              </Button>
            ) : null}
          </div>
        </PartFrame>
      );
    }
    case "export":
      return (
        <PartFrame icon={<Download />} title={part.title} tone="success">
          <p className="text-xs leading-5 text-muted-foreground">{part.description}</p>
          <SafePathButton path={part.path} label={`Open ${part.format.toUpperCase()} export`} onNavigate={callbacks.onNavigate} />
        </PartFrame>
      );
    case "error":
      return (
        <PartFrame icon={<XCircle />} title="Action could not finish" tone="danger">
          <p className="text-xs leading-5">{part.message}</p>
          <p className="mt-1 font-mono text-[9px] text-muted-foreground">{part.code}</p>
          {part.retryable && part.retryActionId && callbacks.onRetry ? (
            <Button type="button" size="sm" variant="outline" className="mt-2 h-8 gap-1.5 text-xs" onClick={() => callbacks.onRetry?.(part.retryActionId!)}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry safely
            </Button>
          ) : null}
        </PartFrame>
      );
    case "navigation":
      return (
        <PartFrame icon={<ArrowRight />} title="Suggested destination" tone="info">
          <SafePathButton path={part.path} label={part.label} onNavigate={callbacks.onNavigate} />
          {part.requiresConfirmation ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground">Navigation happens only after you choose it.</p>
          ) : null}
        </PartFrame>
      );
    case "handoff":
      return (
        <PartFrame icon={<ArrowRight />} title={part.title} tone="info">
          <p className="text-xs leading-5 text-muted-foreground">{part.description}</p>
          <SafePathButton path={part.path} label="Continue manually" onNavigate={callbacks.onNavigate} />
        </PartFrame>
      );
    case "auth":
      return (
        <PartFrame icon={<LockKeyhole />} title={part.title} tone={part.authType === "access_denied" ? "danger" : "warning"}>
          <p className="text-xs leading-5">{part.description}</p>
          <SafePathButton path={part.path} label={part.authType === "step_up" ? "Verify identity" : "Continue"} onNavigate={callbacks.onNavigate} />
        </PartFrame>
      );
  }
}

interface PartFrameProps {
  children: ReactNode;
  icon: ReactNode;
  title: string;
  tone: "danger" | "info" | "neutral" | "success" | "warning";
}

function PartFrame({ children, icon, title, tone }: PartFrameProps) {
  return (
    <section
      className={cn(
        "rounded-lg border p-3",
        tone === "neutral" && "border-border bg-muted/25",
        tone === "info" && "border-sky-500/25 bg-sky-500/5",
        tone === "success" && "border-emerald-500/25 bg-emerald-500/5",
        tone === "warning" && "border-amber-500/30 bg-amber-500/5",
        tone === "danger" && "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
        <span className="[&_svg]:h-3.5 [&_svg]:w-3.5" aria-hidden="true">
          {icon}
        </span>
        <h3>{title}</h3>
      </div>
      {children}
    </section>
  );
}

interface SafePathButtonProps {
  label: string;
  path?: string;
  onNavigate?: (path: string) => void;
}

function SafePathButton({ label, path, onNavigate }: SafePathButtonProps) {
  const safePath = path ? safeAdminAssistantNavigationPath(path) : null;
  if (!safePath || !onNavigate) return null;
  return (
    <Button type="button" size="sm" variant="outline" className="mt-2 h-8 max-w-full gap-1.5 text-xs" onClick={() => onNavigate(safePath)}>
      <span className="truncate">{label}</span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </Button>
  );
}

function getPartKey(part: AssistantMessagePart, index: number): string {
  if ("actionId" in part) return `${part.type}-${part.actionId}`;
  if ("workflowId" in part) return `${part.type}-${part.workflowId}`;
  if ("sourceId" in part) return `${part.type}-${part.sourceId}`;
  if ("title" in part) return `${part.type}-${part.title}-${index}`;
  return `${part.type}-${index}`;
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${formatNumber(value)}`;
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatTableCell(value: boolean | number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "number" ? formatNumber(value) : value;
}

function formatRelativeExpiry(expiresAt: number, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  if (remainingSeconds < 60) return `in ${remainingSeconds}s`;
  return `in ${Math.ceil(remainingSeconds / 60)}m`;
}
