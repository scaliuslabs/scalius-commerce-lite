// Home's setup guide, as Shopify's: a card with a progress count, a short list
// of the steps that matter for a new store, and one action per step. Each
// step is checked from the store's own data (GET /admin/dashboard/setup-guide),
// never because it was clicked. Dismissing hides the card for this staff
// member only. Code-split: Home loads it after its first render.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, Circle, MoreHorizontal } from "lucide-react";
import { postApiV1AdminDashboardSetupGuideDismiss } from "@scalius/api-client/sdk";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "~/components/ui/accordion";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Progress } from "~/components/ui/progress";
import { formatNumber, useMessages } from "~/i18n";
import { setupGuideMessages } from "~/i18n/setup-guide";
import { apiData, type ApiResult } from "~/lib/api";
import { BANGLADESH_PACK_ID } from "~/lib/bangladesh-pack";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import type { getApiV1AdminDashboardSetupGuide } from "@scalius/api-client/sdk";

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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t("options")}>
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => dismiss.mutate()}>{t("dismiss")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={expanded ? t("collapse") : t("expand")}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-body tabular-nums text-muted-foreground">
            {t("progress", { done: formatNumber(done), total: formatNumber(steps.length) })}
          </span>
          <Progress value={(done / steps.length) * 100} className="h-1.5 flex-1" aria-hidden="true" />
        </div>
      </CardHeader>
      {expanded ? (
        <div className="border-t px-4">
          <Accordion type="single" collapsible value={open} onValueChange={setOpen}>
            {steps.map((step) => (
              <AccordionItem key={step.key} value={step.key}>
                <AccordionTrigger>
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-lh shrink-0 items-center">
                      {step.done ? (
                        <Check aria-hidden="true" className="size-4 rounded-full bg-success p-0.5 text-success-foreground" />
                      ) : (
                        <Circle aria-hidden="true" className="size-4 text-muted-foreground" strokeDasharray="3 3" />
                      )}
                    </span>
                    <span className="sr-only">{step.done ? t("stepDone") : t("stepTodo")}:</span>
                    <span>{t(step.key)}</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col items-start gap-3 ps-7">
                    <p className="text-muted-foreground">{t(step.body)}</p>
                    <Button variant={step.done ? "outline" : "default"} size="sm" asChild>
                      <Link to={step.to} params={step.params as never}>{t(`${step.key}Action`)}</Link>
                    </Button>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      ) : null}
    </Card>
  );
}
