import {
  AssistantDisclosure,
  AssistantFeaturedResult,
  AssistantResultList,
  AssistantShortAnswer,
  AssistantToolProgress,
  type AssistantResult,
} from "@scalius/ui/assistant";
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

type AssistantMessagePartsProps = {
  parts: AssistantMessagePart[];
  canNavigate: (path: string) => boolean;
  onNavigate: (path: string, label: string) => void;
};

type AssistantProduct = Extract<
  AssistantMessagePart,
  { type: "product_grid" }
>["products"][number];

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${currency} ${value.toString()}`;
  }
}

function availabilityLabel(value: AssistantProduct["availability"]): string {
  switch (value) {
    case "in_stock":
      return "In stock";
    case "out_of_stock":
      return "Out of stock";
    case "limited":
      return "Limited stock";
    case "unknown":
      return "Availability unknown";
  }
}

function productMeta(product: AssistantProduct): string {
  const availability = availabilityLabel(product.availability);
  if (product.price === undefined || !product.currency) return availability;
  const price = formatMoney(product.price, product.currency);
  return `${product.pricePresentation === "starting_at" ? "From " : ""}${price} · ${availability}`;
}

function productDescription(product: AssistantProduct): string | undefined {
  const highlights = product.badges.slice(0, 2).join(" · ");
  return product.rationale || highlights || undefined;
}

function productResult(
  product: AssistantProduct,
  canNavigate: (path: string) => boolean,
  onNavigate: (path: string, label: string) => void,
): AssistantResult {
  const label = `View ${product.title}`;
  return {
    id: product.id,
    title: product.title,
    description: productDescription(product),
    meta: productMeta(product),
    badge: product.badges[0],
    ...(product.imageUrl
      ? { image: { src: product.imageUrl, alt: product.title } }
      : {}),
    ...(canNavigate(product.path)
      ? {
          action: {
            label,
            onSelect: () => onNavigate(product.path, label),
          },
        }
      : {}),
  };
}

function comparisonValue(
  comparison: Extract<AssistantMessagePart, { type: "comparison" }>,
  productId: string,
): string {
  return comparison.rows
    .slice(0, 2)
    .map((row) => {
      const cell = row.cells.find((candidate) =>
        candidate.productId === productId
      );
      const value = cell?.status === "unknown"
        ? "Not provided"
        : cell?.status === "not_applicable"
          ? "Not applicable"
          : cell?.value || "Not provided";
      return `${row.label}: ${value}`;
    })
    .join(" · ");
}

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
        <AssistantShortAnswer
          summary={part.text}
          details={part.text.length > 420
            ? (
                <p className="whitespace-pre-wrap break-words">
                  {part.text}
                </p>
              )
            : undefined}
        />
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
      {
        const results = part.products.map((product) =>
          productResult(product, canNavigate, onNavigate)
        );
        return (
          <section className="grid gap-2" aria-label={part.title ?? "Products"}>
            {part.title ? (
              <h3 className="text-sm font-semibold text-foreground">
                {part.title}
              </h3>
            ) : null}
            {results.length === 1
              ? <AssistantFeaturedResult result={results[0]!} />
              : (
                  <AssistantResultList
                    items={results}
                    label={part.title ?? "Products"}
                    maximumVisible={3}
                  />
                )}
          </section>
        );
      }

    case "comparison":
      {
        const results = part.products.map((product) => ({
          ...productResult(product, canNavigate, onNavigate),
          description: comparisonValue(part, product.id) ||
            productDescription(product),
        }));
        const visibleProducts = part.products.slice(0, 3);
        return (
          <section className="grid gap-2" aria-label={part.title}>
            <h3 className="text-sm font-semibold text-foreground">
              {part.title}
            </h3>
            <AssistantResultList
              items={results}
              label={`${part.title} products`}
              maximumVisible={3}
            />
            <AssistantDisclosure summary="Comparison details">
              <dl className="grid gap-3">
                {part.rows.slice(0, 8).map((row) => (
                  <div key={row.label} className="grid gap-1">
                    <dt className="font-semibold text-foreground">
                      {row.label}
                    </dt>
                    {visibleProducts.map((product) => {
                      const cell = row.cells.find((candidate) =>
                        candidate.productId === product.id
                      );
                      return (
                        <dd key={product.id} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2">
                          <span className="truncate">{product.title}</span>
                          <span className="break-words text-foreground">
                            {cell?.status === "unknown"
                              ? "Not provided"
                              : cell?.status === "not_applicable"
                                ? "Not applicable"
                                : cell?.value || "Not provided"}
                          </span>
                        </dd>
                      );
                    })}
                  </div>
                ))}
                {part.rows.length > 8 || part.products.length > 3 ? (
                  <p>
                    Additional comparison detail was condensed. Narrow the
                    request to inspect a specific product or attribute.
                  </p>
                ) : null}
              </dl>
            </AssistantDisclosure>
          </section>
        );
      }

    case "table":
      return (
        <AssistantShortAnswer
          summary={`${part.title}. ${part.rows.length} ${part.rows.length === 1 ? "result" : "results"}.`}
          details={
            <dl className="grid gap-3">
              {part.rows.slice(0, 8).map((row) => (
                <div key={row.id} className="grid gap-1 border-b border-border pb-2 last:border-0">
                  {part.columns.slice(0, 6).map((column) => (
                    <div key={column.key} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2">
                      <dt>{column.label}</dt>
                      <dd className="break-words text-foreground">
                        {String(row.cells[column.key] ?? "—")}
                      </dd>
                    </div>
                  ))}
                </div>
              ))}
              {part.rows.length > 8 || part.columns.length > 6 || part.truncated
                ? <p>Additional rows were condensed. Refine the request for a narrower answer.</p>
                : null}
            </dl>
          }
          label={part.title}
        />
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
            {part.fields.slice(0, 3).map((field) => (
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
          {part.fields.length > 3 ? (
            <AssistantDisclosure summary={`${part.fields.length - 3} more fields`}>
              <dl className="grid gap-2">
                {part.fields.slice(3).map((field) => (
                  <div key={field.field} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2">
                    <dt>{field.label}</dt>
                    <dd className="break-words font-medium text-foreground">
                      {field.sensitive ? "Hidden for privacy" : field.displayValue}
                    </dd>
                  </div>
                ))}
              </dl>
            </AssistantDisclosure>
          ) : null}
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
            {part.changes.slice(0, 3).map((change) => (
              <li key={`${change.field}-${change.after}`} className="text-xs">
                <p className="font-medium text-foreground">{change.field}</p>
                <p className="break-words text-muted-foreground">
                  {change.before ?? "Not set"} → {change.after ?? "Not set"}
                </p>
              </li>
            ))}
          </ul>
          {part.changes.length > 3 ? (
            <AssistantDisclosure summary={`${part.changes.length - 3} more changes`}>
              <ul className="grid gap-2">
                {part.changes.slice(3).map((change) => (
                  <li key={`${change.field}-${change.after}`}>
                    <p className="font-medium text-foreground">{change.field}</p>
                    <p className="break-words">
                      {change.before ?? "Not set"} → {change.after ?? "Not set"}
                    </p>
                  </li>
                ))}
              </ul>
            </AssistantDisclosure>
          ) : null}
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
      const stepStatus = part.status === "succeeded"
        ? "complete"
        : part.status === "failed" || part.status === "cancelled"
          ? "failed"
          : part.status === "running" || part.status === "retrying" ||
              part.status === "compensating"
            ? "running"
            : "queued";
      const count = part.completed !== undefined && part.total !== undefined
        ? ` (${part.completed} of ${part.total})`
        : "";
      return (
        <AssistantToolProgress
          label={part.label}
          steps={[{
            id: part.workflowId,
            label: `${part.label}${count}`,
            status: stepStatus,
          }]}
        />
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
