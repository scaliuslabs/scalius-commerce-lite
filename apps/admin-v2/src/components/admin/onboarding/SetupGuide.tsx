// Home's setup guide, as Shopify's: a card with a progress count, a short list
// of the steps that matter for a new store, and one action per step. Each
// step is checked from the store's own data (GET /admin/dashboard/setup-guide),
// never because it was clicked. Dismissing hides the card for this staff
// member only. Code-split: Home loads it after its first render.
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postApiV1AdminDashboardSetupGuideDismiss } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { formatNumber, useMessages } from "~/i18n";
import { setupGuideMessages } from "~/i18n/setup-guide";
import { apiData, type ApiResult } from "~/lib/api";
import { BANGLADESH_PACK_ID } from "~/lib/bangladesh-pack";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import type { getApiV1AdminDashboardSetupGuide } from "@scalius/api-client/sdk";

/**
 * The card is built from what Home's first download already holds (Button,
 * Card, the router) and draws its few glyphs here. A new importer of the icon
 * library or of a Radix package regroups their shared chunks, and the list
 * screens' first download grows with them (apps/admin-v2/vite.config.ts).
 */
function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className ?? "size-4"}>
      {children}
    </svg>
  );
}

export type SetupGuideData = ApiResult<typeof getApiV1AdminDashboardSetupGuide>;

type StepKey = "details" | "product" | "theme" | "payments" | "shipping" | "pack" | "domain" | "order";

interface Step {
  key: StepKey;
  done: boolean;
  to: string;
  params?: Record<string, string>;
  /** The page the step opens, for the role check (a step the person can't open isn't shown). */
  access: string;
  body: "detailsBody" | "productBody" | "themeBody" | "paymentsBody" | "paymentsBodyBd" | "shippingBody" | "packBody" | "domainBody" | "orderBody";
}

/** The guide's steps for this store, in the order a new store needs them. */
export function setupGuideSteps(guide: SetupGuideData, canOpen: (to: string) => boolean): Step[] {
  const { steps, bangladeshPack, countryCode, setupNeeded } = guide;
  const all: Step[] = [
    { key: "details", done: steps.details, to: setupNeeded ? "/admin/welcome" : "/admin/settings/store", access: "/admin/settings/store", body: "detailsBody" },
    { key: "product", done: steps.product, to: "/admin/products/new", access: "/admin/products/new", body: "productBody" },
    { key: "theme", done: steps.theme, to: "/admin/online-store/theme", access: "/admin/online-store/theme", body: "themeBody" },
    {
      key: "payments", done: steps.payments, to: "/admin/settings/payments", access: "/admin/settings/payments",
      body: countryCode === "BD" ? "paymentsBodyBd" : "paymentsBody",
    },
    { key: "shipping", done: steps.shipping, to: "/admin/settings/shipping", access: "/admin/settings/shipping", body: "shippingBody" },
    ...(bangladeshPack
      ? [{ key: "pack" as const, done: bangladeshPack.active, to: "/admin/apps/$pluginId", params: { pluginId: BANGLADESH_PACK_ID }, access: "/admin/apps", body: "packBody" as const }]
      : []),
    { key: "domain", done: steps.domain, to: "/admin/settings/store", access: "/admin/settings/store", body: "domainBody" },
    { key: "order", done: steps.order, to: "/admin/orders/new", access: "/admin/orders/new", body: "orderBody" },
  ];
  return all.filter((step) => canOpen(step.access));
}

export default function SetupGuide({ guide, canOpen }: { guide: SetupGuideData; canOpen: (to: string) => boolean }) {
  const t = useMessages(setupGuideMessages);
  const queryClient = useQueryClient();
  const steps = setupGuideSteps(guide, canOpen);
  const done = steps.filter((step) => step.done).length;
  const complete = steps.length > 0 && done === steps.length;
  const [expanded, setExpanded] = useState(true);
  const [open, setOpen] = useState(() => steps.find((step) => !step.done)?.key ?? "");

  const dismiss = useMutation({
    mutationFn: () => apiData(postApiV1AdminDashboardSetupGuideDismiss()),
    onSuccess: () => {
      queryClient.setQueryData<SetupGuideData>(queryKeys.dashboard.setupGuide(), (current) => current && { ...current, dismissed: true });
    },
    onError: () => toast.error(t("dismissFailed")),
  });

  if (steps.length === 0) return null;
  return (
    <Card>
      <CardHeader className="gap-3 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>{complete ? t("allDoneTitle") : t("title")}</CardTitle>
            <CardDescription>{complete ? t("allDoneBody") : t("description")}</CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>
              {t("dismiss")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={expanded ? t("collapse") : t("expand")}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              <Glyph>{expanded ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}</Glyph>
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-body tabular-nums text-muted-foreground">
            {t("progress", { done: formatNumber(done), total: formatNumber(steps.length) })}
          </span>
          <div
            role="progressbar"
            aria-label={t("title")}
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={done}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"
          >
            <div className="h-full w-(--progress) rounded-full bg-primary" style={{ "--progress": `${(done / steps.length) * 100}%` } as CSSProperties} />
          </div>
        </div>
      </CardHeader>
      {expanded ? (
        <ul className="border-t px-4">
          {steps.map((step) => {
            const isOpen = open === step.key;
            return (
              <li key={step.key} className="border-b last:border-b-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`setup-step-${step.key}`}
                  onClick={() => setOpen(isOpen ? "" : step.key)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg py-3 text-start text-body font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex h-lh shrink-0 items-center">
                    {step.done ? (
                      <Glyph className="size-4 rounded-full bg-success p-0.5 text-success-foreground"><path d="M20 6 9 17l-5-5" /></Glyph>
                    ) : (
                      <Glyph className="size-4 text-muted-foreground"><circle cx="12" cy="12" r="10" strokeDasharray="3 3" /></Glyph>
                    )}
                  </span>
                  <span className="sr-only">{step.done ? t("stepDone") : t("stepTodo")}:</span>
                  <span className="flex-1">{t(step.key)}</span>
                  <Glyph className="size-4 shrink-0 text-muted-foreground">{isOpen ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}</Glyph>
                </button>
                {isOpen ? (
                  <div id={`setup-step-${step.key}`} className="flex flex-col items-start gap-3 pb-4 ps-7">
                    <p className="text-body text-muted-foreground">{t(step.body)}</p>
                    <Button variant={step.done ? "outline" : "default"} size="sm" asChild>
                      <Link to={step.to} params={step.params as never}>{t(`${step.key}Action`)}</Link>
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}
