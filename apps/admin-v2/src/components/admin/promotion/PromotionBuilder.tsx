import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  Check,
  Clock3,
  Eye,
  Info,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  TicketPercent,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PromotionCodesEditor } from "./PromotionCodesEditor";
import { PromotionEffectRail } from "./PromotionEffectRail";
import { PromotionPreviewDrawer } from "./PromotionPreviewDrawer";
import { PromotionStatusBadge } from "./PromotionStatusBadge";
import {
  buildPromotionPayload,
  buildPromotionUpdateInput,
  createPromotionDraft,
  draftsEqual,
  hydratePromotionDraft,
  promotionUsageSummary,
  summarizePromotionDraft,
  type PromotionEditorDraft,
  type PromotionTarget,
} from "./promotion-editor-model";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useCurrency } from "~/hooks/use-currency";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { readPromotionRevisionConflict } from "~/lib/admin-api-error";
import type { PromotionAggregate } from "~/lib/api-functions/promotions";
import {
  useActivatePromotion,
  useArchivePromotion,
  useCreatePromotion,
  usePausePromotion,
  useUpdatePromotion,
} from "~/lib/api-mutations/promotions";
import { promotionDetailQueryOptions } from "~/lib/api-query-options/promotions";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function FieldHeader({
  title,
  description,
  information,
}: {
  title: string;
  description?: string;
  information?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {information ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`About ${title}`}>
              <Info className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{information}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function OptionalAmountInput({
  id,
  label,
  value,
  prefix,
  placeholder,
  integer = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  prefix?: string;
  placeholder: string;
  integer?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        {prefix ? <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span> : null}
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode={integer ? "numeric" : "decimal"}
          className={`h-9 ${prefix ? "pl-8" : ""}`}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}

export function PromotionBuilder({
  promotion,
}: {
  promotion?: PromotionAggregate;
}) {
  const { symbol, code: storeCurrencyCode } = useCurrency();
  const { hasPermission } = usePermissions();
  const canSave = hasPermission(
    promotion ? ADMIN_PERMISSIONS.DISCOUNTS_EDIT : ADMIN_PERMISSIONS.DISCOUNTS_CREATE,
  );
  const canToggleStatus = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_TOGGLE_STATUS);
  const canArchive = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_DELETE);
  const initialDraft = useMemo(
    () => promotion
      ? hydratePromotionDraft(promotion, storeCurrencyCode)
      : createPromotionDraft(storeCurrencyCode),
    // The editor owns a revision snapshot. Query revalidation must not replace
    // unsaved merchant work; explicit reload below is the only rebase action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [promotion?.id],
  );
  const [draft, setDraft] = useState(initialDraft);
  const [baseline, setBaseline] = useState(initialDraft);
  const [serverRevision, setServerRevision] = useState(promotion?.revision ?? null);
  const [serverStatus, setServerStatus] = useState<PromotionAggregate["status"]>(
    promotion?.status ?? "draft",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [leavingAfterSave, setLeavingAfterSave] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createMutation = useCreatePromotion();
  const updateMutation = useUpdatePromotion();
  const activateMutation = useActivatePromotion();
  const pauseMutation = usePausePromotion();
  const archiveMutation = useArchivePromotion();

  const payload = useMemo(() => buildPromotionPayload(draft), [draft]);
  const isDirty = !draftsEqual(draft, baseline);
  const isArchived = serverStatus === "archived";
  const isSaving = createMutation.isPending || updateMutation.isPending || leavingAfterSave;
  const isLifecyclePending = activateMutation.isPending || pauseMutation.isPending || archiveMutation.isPending;
  const readyToActivate = payload.readiness.saveIssues.length === 0
    && payload.readiness.activationIssues.length === 0
    && !isDirty
    && Boolean(promotion);
  const outcomeSummary = summarizePromotionDraft(draft, symbol);
  const usageSummary = promotion ? promotionUsageSummary(promotion, symbol) : null;
  const displayPromotion = promotion
    ? { ...promotion, status: serverStatus, revision: serverRevision ?? promotion.revision }
    : null;

  useEffect(() => {
    if (promotion || draft.currencyCode === storeCurrencyCode) return;
    const hasCurrencyValues = Boolean(
      draft.minimumSubtotal
      || draft.maxDiscountSpend
      || Object.values(draft.effects).some(
        (effect) => effect.enabled && effect.kind === "fixed_amount_off",
      ),
    );
    if (hasCurrencyValues) return;
    setDraft((current) => ({ ...current, currencyCode: storeCurrencyCode }));
    setBaseline((current) => ({ ...current, currencyCode: storeCurrencyCode }));
  }, [draft.currencyCode, draft.effects, draft.maxDiscountSpend, draft.minimumSubtotal, promotion, storeCurrencyCode]);

  function updateDraft(patch: Partial<PromotionEditorDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setSaveError(null);
  }

  async function saveDraft() {
    if (!payload.input || isArchived) return;
    setSaveError(null);
    setRevisionConflict(false);
    try {
      if (!promotion) {
        const result = await createMutation.mutateAsync(payload.input);
        setLeavingAfterSave(true);
        await navigate({
          to: "/admin/promotions/$promotionId/edit",
          params: { promotionId: result.id },
          replace: true,
        });
        return;
      }
      const expectedRevision = serverRevision ?? promotion.revision;
      const input = buildPromotionUpdateInput(draft, expectedRevision);
      if (!input) return;
      const result = await updateMutation.mutateAsync({ id: promotion.id, input });
      const saved = { ...draft, codeEntry: "" };
      setDraft(saved);
      setBaseline(saved);
      setServerRevision(result.revision);
      setServerStatus(result.status);
    } catch (error) {
      setLeavingAfterSave(false);
      if (readPromotionRevisionConflict(error)) {
        setRevisionConflict(true);
        return;
      }
      setSaveError(errorMessage(error, "Promotion draft could not be saved."));
    }
  }

  async function reloadLatest() {
    if (!promotion) return;
    try {
      const latest = await queryClient.fetchQuery({
        ...promotionDetailQueryOptions(promotion.id),
        staleTime: 0,
      });
      const nextDraft = hydratePromotionDraft(latest, storeCurrencyCode);
      setDraft(nextDraft);
      setBaseline(nextDraft);
      setServerRevision(latest.revision);
      setServerStatus(latest.status);
      setRevisionConflict(false);
      setSaveError(null);
    } catch (error) {
      setSaveError(errorMessage(error, "Latest promotion version could not be loaded."));
    }
  }

  async function changeLifecycle(action: "activate" | "pause") {
    if (!promotion || serverRevision === null || isDirty) return;
    setSaveError(null);
    setRevisionConflict(false);
    try {
      const result = action === "activate"
        ? await activateMutation.mutateAsync({ id: promotion.id, expectedRevision: serverRevision })
        : await pauseMutation.mutateAsync({ id: promotion.id, expectedRevision: serverRevision });
      setServerRevision(result.revision);
      setServerStatus(result.status);
    } catch (error) {
      if (readPromotionRevisionConflict(error)) {
        setRevisionConflict(true);
      } else {
        setSaveError(errorMessage(error, `Promotion could not be ${action === "activate" ? "activated" : "paused"}.`));
      }
    }
  }

  async function archivePromotion() {
    if (!promotion || serverRevision === null) return;
    try {
      await archiveMutation.mutateAsync({ id: promotion.id, expectedRevision: serverRevision });
      setBaseline(draft);
      setArchiveOpen(false);
      await navigate({ to: "/admin/promotions" });
    } catch (error) {
      setArchiveOpen(false);
      if (readPromotionRevisionConflict(error)) setRevisionConflict(true);
      else setSaveError(errorMessage(error, "Promotion could not be archived."));
    }
  }

  const issueFor = (field: string) => payload.readiness.saveIssues.find((issue) => issue.field === field)?.message;

  return (
    <div className="space-y-4">
      <UnsavedChangesGuard isDirty={isDirty} isSubmitting={isSaving || isLifecyclePending} />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Button asChild variant="ghost" size="icon" className="mt-0.5 size-8 shrink-0">
            <Link
              to="/admin/promotions"
              aria-label="Back to promotions"
            ><ArrowLeft className="size-4" /></Link>
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight">
                {promotion ? draft.name || "Edit promotion" : "New promotion"}
              </h1>
              {displayPromotion ? <PromotionStatusBadge promotion={displayPromotion} /> : <Badge variant="outline">Draft</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {promotion ? "Changes affect future checkouts only." : "Save a draft, test a cart, then activate."}
            </p>
          </div>
        </div>
        {canSave ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void saveDraft()}
            disabled={!isDirty || !payload.input || isSaving || isArchived}
            className="w-full sm:w-auto"
          >
            {isSaving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            {promotion ? "Save changes" : "Save draft"}
          </Button>
        ) : null}
      </header>

      {revisionConflict ? (
        <Alert className="border-amber-500/40 bg-amber-500/5">
          <AlertCircle className="size-4 text-amber-600" />
          <AlertTitle>Another version was saved</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>Your changes are still here. Reload the latest version only when you are ready to replace this draft.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void reloadLatest()}
            >
              <RotateCcw className="mr-2 size-3.5" />Reload latest
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {saveError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Promotion was not changed</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}
      {isArchived ? (
        <Alert>
          <Archive className="size-4" />
          <AlertTitle>Archived promotion</AlertTitle>
          <AlertDescription>This rule and its reserved codes are read-only.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <fieldset disabled={isArchived} className="min-w-0 space-y-4 disabled:opacity-75">
          <Card className="shadow-sm">
            <CardHeader className="p-4 pb-3">
              <FieldHeader title="Identity and codes" description="Name the rule and define what customers enter." />
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="promotion-name">Internal name</Label>
                  <Input
                    id="promotion-name"
                    value={draft.name}
                    onChange={(event) => updateDraft({ name: event.target.value })}
                    className="h-9"
                    placeholder="Weekend delivery offer"
                    maxLength={161}
                    aria-invalid={issueFor("name") ? true : undefined}
                  />
                  {issueFor("name") ? <p className="text-xs text-destructive">{issueFor("name")}</p> : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="promotion-title">Customer title <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <Input
                    id="promotion-title"
                    value={draft.title}
                    onChange={(event) => updateDraft({ title: event.target.value })}
                    className="h-9"
                    placeholder="Weekend savings"
                    maxLength={201}
                    aria-invalid={issueFor("title") ? true : undefined}
                  />
                  {issueFor("title") ? <p className="text-xs text-destructive">{issueFor("title")}</p> : null}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/25 px-3 py-2">
                <div className="flex items-center gap-2">
                  <TicketPercent className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Method</span>
                </div>
                <Badge variant="secondary">Checkout code</Badge>
              </div>

              <div className="space-y-1.5">
                <Label>Codes</Label>
                <PromotionCodesEditor
                  codes={draft.codes}
                  entry={draft.codeEntry}
                  onCodesChange={(codes) => updateDraft({ codes })}
                  onEntryChange={(codeEntry) => updateDraft({ codeEntry })}
                />
                {issueFor("codes") ? <p className="text-xs text-destructive">{issueFor("codes")}</p> : null}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="p-4 pb-3">
              <FieldHeader
                title="Customer outcome"
                description="Turn on each part of the cart this code should reduce."
                information="Item savings apply to every merchandise line. Order savings use the remaining subtotal. Delivery savings use the checkout delivery charge."
              />
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <PromotionEffectRail
                effects={draft.effects}
                currencySymbol={symbol}
                onChange={(target: PromotionTarget, effect) => updateDraft({
                  effects: { ...draft.effects, [target]: effect },
                })}
              />
              {issueFor("effects") ? <p className="mt-2 text-xs text-destructive">{issueFor("effects")}</p> : null}
              {Object.entries(draft.effects).map(([target]) => {
                const issue = issueFor(`effects.${target}`);
                return issue ? <p key={target} className="mt-2 text-xs text-destructive">{issue}</p> : null;
              })}
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="p-4 pb-3">
              <FieldHeader
                title="Purchase requirements"
                description="Leave either field empty when it should not limit eligibility."
                information="When both fields are set, checkout requires both. Subtotal excludes delivery; quantity counts all merchandise units."
              />
            </CardHeader>
            <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-2">
              <div>
                <OptionalAmountInput
                  id="promotion-minimum-subtotal"
                  label="Minimum subtotal"
                  value={draft.minimumSubtotal}
                  prefix={symbol}
                  placeholder="No minimum"
                  onChange={(minimumSubtotal) => updateDraft({ minimumSubtotal })}
                />
                {issueFor("minimumSubtotal") ? <p className="mt-1 text-xs text-destructive">{issueFor("minimumSubtotal")}</p> : null}
              </div>
              <div>
                <OptionalAmountInput
                  id="promotion-minimum-quantity"
                  label="Minimum item quantity"
                  value={draft.minimumQuantity}
                  placeholder="No minimum"
                  integer
                  onChange={(minimumQuantity) => updateDraft({ minimumQuantity })}
                />
                {issueFor("minimumQuantity") ? <p className="mt-1 text-xs text-destructive">{issueFor("minimumQuantity")}</p> : null}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="p-4 pb-3">
              <FieldHeader title="Schedule and budgets" description="Control when the code runs and how much it can consume." />
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="promotion-start">Starts <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <Input id="promotion-start" type="datetime-local" value={draft.startsAtLocal} onChange={(event) => updateDraft({ startsAtLocal: event.target.value })} className="h-9" />
                  {issueFor("startsAtLocal") ? <p className="text-xs text-destructive">{issueFor("startsAtLocal")}</p> : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="promotion-end">Ends <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <Input id="promotion-end" type="datetime-local" value={draft.endsAtLocal} onChange={(event) => updateDraft({ endsAtLocal: event.target.value })} className="h-9" />
                  {issueFor("endsAtLocal") ? <p className="text-xs text-destructive">{issueFor("endsAtLocal")}</p> : null}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promotion-timezone">Schedule timezone</Label>
                <Input
                  id="promotion-timezone"
                  list="promotion-timezones"
                  value={draft.timezone}
                  onChange={(event) => updateDraft({ timezone: event.target.value })}
                  className="h-9"
                  placeholder="Asia/Dhaka"
                />
                <datalist id="promotion-timezones">
                  <option value="Asia/Dhaka" />
                  <option value="UTC" />
                  <option value="Asia/Kolkata" />
                  <option value="Europe/London" />
                  <option value="America/New_York" />
                </datalist>
                {issueFor("timezone") ? <p className="text-xs text-destructive">{issueFor("timezone")}</p> : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <OptionalAmountInput id="promotion-max-redemptions" label="Total uses" value={draft.maxRedemptions} placeholder="Unlimited" integer onChange={(maxRedemptions) => updateDraft({ maxRedemptions })} />
                  {issueFor("maxRedemptions") ? <p className="mt-1 text-xs text-destructive">{issueFor("maxRedemptions")}</p> : null}
                </div>
                <div>
                  <OptionalAmountInput id="promotion-customer-redemptions" label="Uses per customer" value={draft.maxRedemptionsPerCustomer} placeholder="Unlimited" integer onChange={(maxRedemptionsPerCustomer) => updateDraft({ maxRedemptionsPerCustomer })} />
                  {issueFor("maxRedemptionsPerCustomer") ? <p className="mt-1 text-xs text-destructive">{issueFor("maxRedemptionsPerCustomer")}</p> : null}
                </div>
                <div>
                  <OptionalAmountInput id="promotion-spend-budget" label="Discount spend" value={draft.maxDiscountSpend} prefix={symbol} placeholder="Unlimited" onChange={(maxDiscountSpend) => updateDraft({ maxDiscountSpend })} />
                  {issueFor("maxDiscountSpend") ? <p className="mt-1 text-xs text-destructive">{issueFor("maxDiscountSpend")}</p> : null}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Confirmed order claims consume these budgets permanently, including later cancellations and refunds.
              </p>
            </CardContent>
          </Card>
        </fieldset>

        <aside className="space-y-3 xl:sticky xl:top-4">
          <Card className="overflow-hidden shadow-sm">
            <div className={`h-1 ${payload.readiness.saveIssues.length > 0 ? "bg-amber-500" : readyToActivate ? "bg-emerald-500" : "bg-foreground"}`} />
            <CardHeader className="p-4 pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-sm">Readiness</CardTitle>
                {payload.readiness.saveIssues.length === 0 ? (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300"><Check className="size-3.5" />Draft valid</span>
                ) : (
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-300">{payload.readiness.saveIssues.length} to fix</span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0">
              <div className="space-y-2">
                {outcomeSummary.length > 0 ? outcomeSummary.map((summary) => (
                  <div key={summary} className="flex items-center gap-2 text-sm">
                    <span className="size-1.5 rounded-full bg-foreground" />{summary}
                  </div>
                )) : <p className="text-sm text-muted-foreground">No outcome selected</p>}
              </div>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border text-center">
                <div className="bg-background px-2 py-2.5">
                  <div className="text-base font-semibold tabular-nums">{draft.codes.filter(({ isActive }) => isActive).length}</div>
                  <div className="text-[11px] text-muted-foreground">active codes</div>
                </div>
                <div className="bg-background px-2 py-2.5">
                  <div className="text-base font-semibold tabular-nums">{serverRevision ?? "—"}</div>
                  <div className="text-[11px] text-muted-foreground">revision</div>
                </div>
                {usageSummary ? (
                  <>
                    <div className="bg-background px-2 py-2.5">
                      <div className="truncate text-sm font-semibold tabular-nums">{usageSummary.uses.replace(/ uses?$/u, "")}</div>
                      <div className="text-[11px] text-muted-foreground">committed uses</div>
                    </div>
                    <div className="bg-background px-2 py-2.5">
                      <div className="truncate text-sm font-semibold tabular-nums">{usageSummary.spend ?? `${symbol}0`}</div>
                      <div className="text-[11px] text-muted-foreground">discount spend</div>
                    </div>
                  </>
                ) : null}
              </div>
              {payload.readiness.saveIssues.length > 0 ? (
                <ul className="space-y-1.5 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  {payload.readiness.saveIssues.slice(0, 4).map((issue) => <li key={`${issue.field}:${issue.message}`}>• {issue.message}</li>)}
                </ul>
              ) : payload.readiness.activationIssues.length > 0 ? (
                <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  {payload.readiness.activationIssues[0].message}
                </p>
              ) : isDirty ? (
                <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">Save changes before previewing or activating.</p>
              ) : (
                <p className="flex items-start gap-2 rounded-lg bg-emerald-500/10 p-3 text-xs text-emerald-800 dark:text-emerald-200">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />Ready for evaluator preview and activation.
                </p>
              )}

              <div className="space-y-2 border-t pt-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={!promotion || isDirty || isArchived}
                  onClick={() => setPreviewOpen(true)}
                >
                  <Eye className="mr-2 size-4" />Test cart
                </Button>
                {promotion && canToggleStatus && serverStatus === "active" ? (
                  <Button type="button" variant="outline" className="w-full" disabled={isDirty || isLifecyclePending} onClick={() => void changeLifecycle("pause")}>
                    {pauseMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Pause className="mr-2 size-4" />}Pause promotion
                  </Button>
                ) : promotion && canToggleStatus && !isArchived ? (
                  <Button type="button" className="w-full" disabled={!readyToActivate || isLifecyclePending} onClick={() => void changeLifecycle("activate")}>
                    {activateMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}Activate promotion
                  </Button>
                ) : null}
                {promotion && canArchive && !isArchived ? (
                  <Button type="button" variant="ghost" className="w-full text-muted-foreground hover:text-destructive" disabled={isDirty || isLifecyclePending} onClick={() => setArchiveOpen(true)}>
                    <Archive className="mr-2 size-4" />Archive
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" />All schedule times use {draft.timezone || "the selected timezone"}.
          </div>
        </aside>
      </div>

      {promotion && serverRevision !== null ? (
        <PromotionPreviewDrawer
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          promotionId={promotion.id}
          revision={serverRevision}
          codes={draft.codes}
          currencyCode={draft.currencyCode}
          currencySymbol={symbol}
        />
      ) : null}

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this promotion?</AlertDialogTitle>
            <AlertDialogDescription>
              Checkout stops accepting its codes. Saved redemption history and code identities remain reserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep promotion</AlertDialogCancel>
            <AlertDialogAction onClick={() => void archivePromotion()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {archiveMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}Archive promotion
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
