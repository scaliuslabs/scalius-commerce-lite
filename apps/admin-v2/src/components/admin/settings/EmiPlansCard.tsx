import { nanoid } from "nanoid";
import { Plus, Trash2 } from "lucide-react";
import { getApiV1AdminSettingsEmi, putApiV1AdminSettingsEmi } from "@scalius/api-client/sdk";
import { EMI_MAX_MONTHS, EMI_MAX_PLANS, EMI_MIN_MONTHS } from "@scalius/shared/emi";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { NumberInput } from "~/components/ui/number-input";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { useCurrency } from "~/hooks/use-currency";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiResult } from "~/lib/api";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { emiMessages } from "~/i18n/settings-emi";
import { SettingsCard, SettingsCardLoading } from "./SettingsPage";
import { SettingsLoadFailure } from "./SettingsLoadFailure";

type EmiDocument = ApiResult<typeof getApiV1AdminSettingsEmi>;
type EmiValues = Omit<EmiDocument, "revision">;
type Plan = EmiValues["plans"][number];

export const emiSettingsQuery = {
  queryKey: ["settings", "emi"] as const,
  queryFn: () => apiData(getApiV1AdminSettingsEmi()),
};

/** Why each plan can't be saved yet, one line per problem. */
export function emiPlanProblems(values: EmiValues, t: (key: "planProvider" | "planMonths" | "planFee" | "planMin", vars: { row: number }) => string): string[] {
  const lines: string[] = [];
  values.plans.forEach((plan, index) => {
    const row = index + 1;
    if (!plan.provider.trim()) lines.push(t("planProvider", { row }));
    if (!Number.isInteger(plan.months) || plan.months < EMI_MIN_MONTHS || plan.months > EMI_MAX_MONTHS) lines.push(t("planMonths", { row }));
    if (!Number.isFinite(plan.feePercentage) || plan.feePercentage < 0 || plan.feePercentage > 50) lines.push(t("planFee", { row }));
    if (!Number.isFinite(plan.minAmount) || plan.minAmount < 0) lines.push(t("planMin", { row }));
  });
  return lines;
}

/**
 * "EMI on card payment": the bank plans whose lowest monthly amount product
 * pages show. Off by default and informational only; checkout takes no EMI.
 */
export function EmiPlansCard() {
  const t = useMessages(emiMessages);
  const common = useMessages(settingsMessages);
  const { code, symbol } = useCurrency();
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const problemsOf = (values: EmiValues) => emiPlanProblems(values, t);
  const { values, setValue, isLoaded, isLoadError, refetch } = useSettingsForm<EmiValues, EmiDocument>({
    label: t("title"),
    queryKey: emiSettingsQuery.queryKey,
    fetchFn: emiSettingsQuery.queryFn,
    saveFn: (draft, expectedRevision) => apiData(putApiV1AdminSettingsEmi({
      body: {
        enabled: draft.enabled,
        plans: draft.plans.map((plan) => ({ ...plan, provider: plan.provider.trim() })),
        expectedRevision,
      },
    })),
    resolveSavedValues: (saved) => saved,
    defaultValues: { enabled: false, plans: [] },
    errorMessage: common("saveFailed"),
    canEdit,
    isValid: (draft) => problemsOf(draft).length === 0,
  });
  if (isLoadError) return <SettingsLoadFailure title={t("loadFailed")} onRetry={refetch} />;
  if (!isLoaded) return <SettingsCardLoading />;

  const problems = problemsOf(values);
  const update = (id: string, patch: Partial<Plan>) =>
    setValue("plans", values.plans.map((plan) => (plan.id === id ? { ...plan, ...patch } : plan)));

  return (
    <SettingsCard title={t("title")} description={t("description")}>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("enabled")}</span>
          <span className="block text-muted-foreground">{t("enabledHelp")}</span>
        </span>
        <Switch checked={values.enabled} disabled={!canEdit} onCheckedChange={(on) => setValue("enabled", on)} />
      </label>
      <div className="space-y-3 border-t border-border pt-4">
        {values.plans.length === 0 ? <p className="text-body text-muted-foreground">{t("noPlans")}</p> : (
          <ul className="divide-y rounded-lg border">
            {values.plans.map((plan, index) => {
              const idFor = (field: string) => `emi-${plan.id}-${field}`;
              return (
                <li key={plan.id} className="grid gap-3 p-3 sm:grid-cols-12">
                  <div className="space-y-1 sm:col-span-4">
                    <Label htmlFor={idFor("provider")}>{t("provider")}</Label>
                    <Input
                      id={idFor("provider")}
                      maxLength={60}
                      placeholder={t("providerPlaceholder")}
                      value={plan.provider}
                      disabled={!canEdit}
                      onChange={(event) => update(plan.id, { provider: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={idFor("months")}>{t("months")}</Label>
                    <NumberInput id={idFor("months")} integer value={plan.months} disabled={!canEdit} onValueChange={(months) => update(plan.id, { months: months ?? Number.NaN })} />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={idFor("fee")}>{t("fee")}</Label>
                    <NumberInput id={idFor("fee")} value={plan.feePercentage} disabled={!canEdit} onValueChange={(fee) => update(plan.id, { feePercentage: fee ?? 0 })} />
                  </div>
                  <div className="space-y-1 sm:col-span-3">
                    <Label htmlFor={idFor("min")}>{t("minAmount", { symbol })}</Label>
                    <MoneyInput id={idFor("min")} currencyCode={code} value={plan.minAmount} disabled={!canEdit} onValueChange={(minAmount) => update(plan.id, { minAmount: minAmount ?? 0 })} />
                  </div>
                  <div className="flex items-end justify-end sm:col-span-1">
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("removePlan", { row: index + 1 })}
                        onClick={() => setValue("plans", values.plans.filter((item) => item.id !== plan.id))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && values.plans.length < EMI_MAX_PLANS ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setValue("plans", [
              ...values.plans,
              { id: `plan-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, "x")}`, provider: "", months: 6, feePercentage: 0, minAmount: 5000 },
            ])}
          >
            <Plus className="h-4 w-4" />
            {t("addPlan")}
          </Button>
        ) : null}
        {problems.map((problem) => <p key={problem} role="alert" className="text-body text-destructive">{problem}</p>)}
      </div>
    </SettingsCard>
  );
}
