import {
  AlertTriangle,
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  CircleDashed,
  FileText,
  HandHelping,
  LockKeyhole,
  Route,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import type { AssistantMessagePart } from "@scalius/shared/assistant-contracts";
import { cn } from "@scalius/shared/utils";

import { AssistantComparison } from "./AssistantComparison";
import { AssistantProductCard } from "./AssistantProductCard";

type AssistantMessagePartsProps = {
  parts: AssistantMessagePart[];
  canNavigate: (path: string) => boolean;
  onNavigate: (path: string, label: string) => void;
};

type NavigateButtonProps = {
  path: string;
  label: string;
  canNavigate: (path: string) => boolean;
  onNavigate: (path: string, label: string) => void;
  subdued?: boolean;
};

function NavigateButton({
  path,
  label,
  canNavigate,
  onNavigate,
  subdued = false,
}: NavigateButtonProps) {
  if (!canNavigate(path)) return null;

  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        subdued
          ? "border border-border bg-background text-foreground hover:bg-muted"
          : "bg-foreground text-background hover:opacity-90",
      )}
      onClick={() => onNavigate(path, label)}
    >
      <span className="truncate">{label}</span>
      <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}

function partKey(part: AssistantMessagePart, index: number): string {
  switch (part.type) {
    case "source":
      return `source-${part.sourceId}`;
    case "product_grid":
      return `products-${part.products.map((product) => product.id).join("-")}`;
    case "comparison":
      return `comparison-${part.title}`;
    case "confirmation":
      return `confirmation-${part.actionId}`;
    case "progress":
      return `progress-${part.workflowId}`;
    case "navigation":
      return `navigation-${part.path}`;
    case "error":
      return `error-${part.code}-${index}`;
    default:
      return `${part.type}-${index}`;
  }
}

function resultIcon(
  status: Extract<AssistantMessagePart, { type: "result" }>["status"],
) {
  if (status === "succeeded") {
    return <CheckCircle2 className="size-4" aria-hidden="true" />;
  }
  if (status === "failed") {
    return <XCircle className="size-4" aria-hidden="true" />;
  }
  return <AlertTriangle className="size-4" aria-hidden="true" />;
}

function renderPart(
  part: AssistantMessagePart,
  canNavigate: (path: string) => boolean,
  onNavigate: (path: string, label: string) => void,
) {
  switch (part.type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
          {part.text}
        </p>
      );

    case "source":
      return (
        <aside className="rounded-xl border border-border/80 bg-muted/35 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <BookOpenText
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">
                {part.label}
              </p>
              {part.description ? (
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {part.description}
                </p>
              ) : null}
              {part.path ? (
                <div className="mt-2">
                  <NavigateButton
                    path={part.path}
                    label={`Open ${part.label}`}
                    canNavigate={canNavigate}
                    onNavigate={onNavigate}
                    subdued
                  />
                </div>
              ) : null}
            </div>
          </div>
        </aside>
      );

    case "product_grid":
      return (
        <section className="grid gap-2.5">
          {part.title ? (
            <h3 className="text-sm font-semibold text-foreground">
              {part.title}
            </h3>
          ) : null}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2.5">
            {part.products.map((product) => (
              <AssistantProductCard
                key={product.id}
                product={product}
                canNavigate={canNavigate}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </section>
      );

    case "comparison":
      return (
        <AssistantComparison
          comparison={part}
          canNavigate={canNavigate}
          onNavigate={onNavigate}
        />
      );

    case "table":
      return (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {part.title}
          </h3>
          <div className="overflow-x-auto rounded-xl border border-border/90">
            <table className="w-full min-w-[28rem] border-collapse text-left text-xs">
              <thead className="bg-muted/60">
                <tr>
                  {part.columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className="px-3 py-2 font-semibold"
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {part.rows.map((row) => (
                  <tr key={row.id}>
                    {part.columns.map((column) => (
                      <td
                        key={column.key}
                        className="px-3 py-2 text-muted-foreground"
                      >
                        {String(row.cells[column.key] ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {part.truncated ? (
            <p className="text-xs text-muted-foreground">
              Only the first results are shown.
            </p>
          ) : null}
        </section>
      );

    case "chart":
      return (
        <section className="rounded-xl border border-border/90 bg-muted/25 p-3">
          <div className="flex items-center gap-2">
            <CircleDashed className="size-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-foreground">
              {part.title}
            </h3>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {part.textSummary}
          </p>
        </section>
      );

    case "form_draft":
      return (
        <section className="rounded-xl border border-border/90 bg-muted/25 p-3">
          <h3 className="text-sm font-semibold text-foreground">
            {part.title}
          </h3>
          <dl className="mt-2 grid gap-2">
            {part.fields.map((field) => (
              <div
                key={field.field}
                className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2 text-xs"
              >
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="break-words font-medium text-foreground">
                  {field.sensitive ? "Hidden for privacy" : field.displayValue}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Review and enter these details through the page form. The assistant
            has not submitted anything.
          </p>
        </section>
      );

    case "diff":
      return (
        <section className="rounded-xl border border-border/90 bg-muted/25 p-3">
          <h3 className="text-sm font-semibold text-foreground">
            {part.title}
          </h3>
          <ul className="mt-2 grid gap-2">
            {part.changes.map((change) => (
              <li key={`${change.field}-${change.after}`} className="text-xs">
                <p className="font-medium text-foreground">{change.field}</p>
                <p className="break-words text-muted-foreground">
                  {change.before ?? "Not set"} → {change.after ?? "Not set"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      );

    case "confirmation":
      return (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-3 text-amber-950 dark:text-amber-100">
          <div className="flex items-start gap-2">
            <ShieldAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <div>
              <h3 className="text-sm font-semibold">{part.title}</h3>
              <p className="mt-1 text-xs leading-5 opacity-85">
                {part.summary}
              </p>
              {part.consequences.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs opacity-85">
                  {part.consequences.map((consequence) => (
                    <li key={consequence}>{consequence}</li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 text-xs font-medium">
                This storefront assistant cannot approve or execute actions. Use
                the visible page controls to continue manually.
              </p>
            </div>
          </div>
        </section>
      );

    case "progress": {
      const percent =
        part.completed !== undefined && part.total !== undefined
          ? Math.min(100, Math.round((part.completed / part.total) * 100))
          : null;
      return (
        <section className="rounded-xl border border-border/90 bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium text-foreground">{part.label}</span>
            <span className="capitalize text-muted-foreground">
              {part.status.replaceAll("_", " ")}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={part.label}
            aria-valuemin={percent === null ? undefined : 0}
            aria-valuemax={percent === null ? undefined : 100}
            aria-valuenow={percent ?? undefined}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-border"
          >
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none",
                percent === null && "w-1/2 animate-pulse",
              )}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        </section>
      );
    }

    case "result":
      return (
        <section
          className={cn(
            "rounded-xl border p-3",
            part.status === "succeeded"
              ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-950 dark:text-emerald-100"
              : part.status === "failed"
                ? "border-destructive/30 bg-destructive/8 text-destructive"
                : "border-amber-500/30 bg-amber-500/8 text-amber-950 dark:text-amber-100",
          )}
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">{resultIcon(part.status)}</span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">{part.title}</h3>
              <p className="mt-1 text-xs leading-5 opacity-85">
                {part.summary}
              </p>
              {part.resourcePath ? (
                <div className="mt-2">
                  <NavigateButton
                    path={part.resourcePath}
                    label="Review result"
                    canNavigate={canNavigate}
                    onNavigate={onNavigate}
                    subdued
                  />
                </div>
              ) : null}
            </div>
          </div>
        </section>
      );

    case "export":
      return (
        <section className="rounded-xl border border-border/90 bg-muted/25 p-3">
          <div className="flex items-start gap-2">
            <FileText
              className="mt-0.5 size-4 text-primary"
              aria-hidden="true"
            />
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {part.title}
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {part.description}
              </p>
              <div className="mt-2">
                <NavigateButton
                  path={part.path}
                  label={`Open ${part.format.toUpperCase()}`}
                  canNavigate={canNavigate}
                  onNavigate={onNavigate}
                  subdued
                />
              </div>
            </div>
          </div>
        </section>
      );

    case "error":
      return (
        <section
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/8 p-3 text-destructive"
        >
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <h3 className="text-sm font-semibold">Couldn’t finish that</h3>
              <p className="mt-1 text-xs leading-5">{part.message}</p>
              <p className="mt-2 text-xs opacity-85">
                Nothing was changed. Continue with the storefront controls or
                try a new question.
              </p>
            </div>
          </div>
        </section>
      );

    case "navigation":
      return (
        <section className="rounded-xl border border-primary/25 bg-primary/7 p-3">
          <div className="flex items-start gap-2">
            <Route
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-5 text-muted-foreground">
                Review the destination, then choose whether to open it.
              </p>
              <div className="mt-2">
                <NavigateButton
                  path={part.path}
                  label={part.label}
                  canNavigate={canNavigate}
                  onNavigate={onNavigate}
                />
              </div>
            </div>
          </div>
        </section>
      );

    case "handoff": {
      const navigationAvailable = canNavigate(part.path);
      return (
        <section className="rounded-xl border border-primary/25 bg-primary/7 p-3">
          <div className="flex items-start gap-2">
            <HandHelping
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-foreground">
                {part.title}
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {part.description}
              </p>
              {navigationAvailable ? (
                <div className="mt-2">
                  <NavigateButton
                    path={part.path}
                    label="Continue manually"
                    canNavigate={canNavigate}
                    onNavigate={onNavigate}
                  />
                </div>
              ) : (
                <p className="mt-2 text-xs font-medium text-foreground">
                  Use the visible cart or checkout controls to continue
                  manually.
                </p>
              )}
            </div>
          </div>
        </section>
      );
    }

    case "auth":
      return (
        <section className="rounded-xl border border-border/90 bg-muted/30 p-3">
          <div className="flex items-start gap-2">
            <LockKeyhole
              className="mt-0.5 size-4 text-primary"
              aria-hidden="true"
            />
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {part.title}
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {part.description}
              </p>
              <p className="mt-2 text-xs font-medium text-foreground">
                Complete authentication through the storefront’s own controls.
                Never share a password or one-time code here.
              </p>
            </div>
          </div>
        </section>
      );
  }
}

export function AssistantMessageParts({
  parts,
  canNavigate,
  onNavigate,
}: AssistantMessagePartsProps) {
  return (
    <div className="grid gap-3">
      {parts.map((part, index) => (
        <div key={partKey(part, index)}>
          {renderPart(part, canNavigate, onNavigate)}
        </div>
      ))}
    </div>
  );
}
