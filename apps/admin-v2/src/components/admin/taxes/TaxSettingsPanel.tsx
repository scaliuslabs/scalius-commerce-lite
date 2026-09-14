import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleOff } from "lucide-react";
import { toast } from "sonner";

import { ContextualSaveBar } from "~/components/admin/shell/ContextualSaveBar";
import { FieldError } from "~/components/admin/shell/FieldError";
import { InlineHelp } from "~/components/admin/shell/InlineHelp";
import { SettingsSection } from "~/components/admin/shell/SettingsSection";
import { StatusBadge } from "~/components/admin/shell/StatusBadge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  saveTaxSettings,
  type TaxConfigurationPayload,
  type UpdateTaxSettingsInput,
} from "~/lib/api-functions/taxes";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import {
  buildTaxSettingsDraft,
  taxSettingsFieldIssues,
  taxSettingsSaveBarState,
} from "./tax-form";
import { getTaxReadiness } from "./tax-readiness";
import type { TaxWorkspaceRouteSection } from "./tax-workspace-sections";

const NO_CLASS = "__none__";

export function TaxSettingsPanel({
  configuration,
  canManage,
  onOpenTarget,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
  /** Sends the merchant to the workspace destination readiness points at. */
  onOpenTarget: (target: TaxWorkspaceRouteSection) => void;
}) {
  const queryClient = useQueryClient();
  const savedForm: UpdateTaxSettingsInput = buildTaxSettingsDraft(configuration.settings);
  const [form, setForm] = useState<UpdateTaxSettingsInput>(() => savedForm);

  useEffect(() => {
    setForm(buildTaxSettingsDraft(configuration.settings));
    // The settings object is the versioned authority. A refetch only resets the
    // draft after the saved state itself changes.
  }, [configuration.settings]);

  const fieldIssues = taxSettingsFieldIssues(form, configuration);
  const saveBar = taxSettingsSaveBarState(form, savedForm, configuration, { canManage });
  const readiness = getTaxReadiness(configuration);
  const saveMutation = useMutation({
    mutationFn: () => saveTaxSettings({ data: form }),
    onSuccess: async () => {
      toast.success("Saved");
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Tax settings could not be saved."));
    },
  });

  return (
    <div className="space-y-8">
      <ContextualSaveBar
        isDirty={saveBar.visible}
        saving={saveMutation.isPending}
        canSave={saveBar.canSave}
        saveDisabled={saveBar.saveDisabled}
        saveDisabledReason={saveBar.disabledReason ?? undefined}
        onSave={() => saveMutation.mutate()}
        onDiscard={() => setForm(savedForm)}
      >
        {saveBar.disabledReason ? (
          <span className="truncate text-xs leading-5 text-muted-foreground">
            {saveBar.disabledReason}
          </span>
        ) : null}
      </ContextualSaveBar>

      <SettingsSection
        id="tax-calculation"
        title="Calculation policy"
        description="Decides whether checkout charges tax at all, and whether your listed prices already contain it."
      >
        <div className="space-y-4">
          <ToggleRow
            id="tax-enabled"
            label="Calculate tax at checkout"
            help={form.enabled
              ? "Checkout applies the saved classes and rates to every new order."
              : "Checkout records zero tax on every new order."}
            checked={form.enabled}
            disabled={!canManage}
            onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))}
          />
          <ToggleRow
            id="tax-inclusive"
            label="Prices include tax"
            help={form.pricesIncludeTax
              ? "Tax is extracted from the listed price, so the buyer pays the price shown."
              : "Tax is added after discounts, on top of the listed price."}
            checked={form.pricesIncludeTax}
            disabled={!canManage}
            onCheckedChange={(pricesIncludeTax) => setForm((current) => ({
              ...current,
              pricesIncludeTax,
            }))}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        id="tax-default-class"
        title="Default product class"
        description="The class checkout uses for any product or SKU without its own class."
      >
        <div className="space-y-1.5">
          <Label htmlFor="tax-default-class-select">Default product class</Label>
          <Select
            disabled={!canManage}
            value={form.defaultTaxClassId ?? NO_CLASS}
            onValueChange={(value) => setForm((current) => ({
              ...current,
              defaultTaxClassId: value === NO_CLASS ? null : value,
            }))}
          >
            <SelectTrigger
              id="tax-default-class-select"
              className="min-h-11 sm:min-h-9"
              aria-label="Default product tax class"
              aria-invalid={fieldIssues.defaultTaxClassId ? true : undefined}
              aria-describedby="tax-default-class-help"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CLASS} className="min-h-11 sm:min-h-9">Not configured</SelectItem>
              {configuration.classes.map((taxClass) => (
                <SelectItem key={taxClass.id} value={taxClass.id} className="min-h-11 sm:min-h-9">
                  {taxClass.name}{taxClass.isExempt ? " · exempt" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <InlineHelp id="tax-default-class-help">
            Products keep their own class when one is assigned in Classification.
          </InlineHelp>
          <FieldError>{fieldIssues.defaultTaxClassId}</FieldError>
        </div>
      </SettingsSection>

      <SettingsSection
        id="tax-shipping"
        title="Shipping tax"
        description="Applies a class to the delivery charge, separately from the items in the order."
      >
        <div className="space-y-4">
          <ToggleRow
            id="tax-shipping-toggle"
            label="Tax shipping"
            help={form.taxShipping
              ? "The delivery charge is taxed with the class selected below."
              : "Delivery charges are never taxed."}
            checked={form.taxShipping}
            disabled={!canManage}
            onCheckedChange={(taxShipping) => setForm((current) => ({ ...current, taxShipping }))}
          />
          {form.taxShipping ? (
            <div className="space-y-1.5 border-t border-border pt-4">
              <Label htmlFor="tax-shipping-class-select">Shipping class</Label>
              <Select
                disabled={!canManage}
                value={form.shippingTaxClassId ?? NO_CLASS}
                onValueChange={(value) => setForm((current) => ({
                  ...current,
                  shippingTaxClassId: value === NO_CLASS ? null : value,
                }))}
              >
                <SelectTrigger
                  id="tax-shipping-class-select"
                  className="min-h-11 sm:min-h-9"
                  aria-label="Shipping tax class"
                  aria-invalid={fieldIssues.shippingTaxClassId ? true : undefined}
                  aria-describedby="tax-shipping-class-help"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CLASS} className="min-h-11 sm:min-h-9">Use default class</SelectItem>
                  {configuration.classes.map((taxClass) => (
                    <SelectItem key={taxClass.id} value={taxClass.id} className="min-h-11 sm:min-h-9">
                      {taxClass.name}{taxClass.isExempt ? " · exempt" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <InlineHelp id="tax-shipping-class-help">
                Leaving this on the default class taxes delivery at the same rate as
                unclassified products.
              </InlineHelp>
              <FieldError>{fieldIssues.shippingTaxClassId}</FieldError>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        id="tax-label"
        title="Buyer-facing label"
        description="The word buyers see beside the tax amount at checkout and on receipts."
      >
        <div className="space-y-1.5">
          <Label htmlFor="tax-display-label">Buyer-facing label</Label>
          <Input
            className="min-h-11 sm:min-h-9 sm:max-w-xs"
            id="tax-display-label"
            value={form.displayLabel}
            maxLength={80}
            aria-invalid={fieldIssues.displayLabel ? true : undefined}
            aria-describedby="tax-display-label-help"
            onChange={(event) => setForm((current) => ({
              ...current,
              displayLabel: event.target.value,
            }))}
            placeholder="Tax"
            disabled={!canManage}
          />
          <InlineHelp id="tax-display-label-help">
            Use the term your buyers expect, such as VAT or GST.
          </InlineHelp>
          <FieldError>{fieldIssues.displayLabel}</FieldError>
        </div>
      </SettingsSection>

      <SettingsSection
        id="tax-outcome"
        title="Checkout outcome"
        description="What the settings above do to a new order, before any per-product class is applied."
      >
        <ul className="space-y-2 text-sm">
          <li className="font-medium">
            {!form.enabled
              ? "Checkout does not charge tax."
              : form.pricesIncludeTax
                ? "Matching tax is included in the displayed price."
                : "Matching tax is added after discounts at checkout."}
          </li>
          <li className="text-muted-foreground">
            {form.taxShipping
              ? "Delivery charges use the selected shipping class."
              : "Delivery charges are not taxed."}
          </li>
          <li className="text-muted-foreground">
            Existing orders keep the tax totals they had when customers placed them.
          </li>
        </ul>
      </SettingsSection>

      <SettingsSection
        id="tax-setup-checks"
        title="Setup checks"
        description="Saved state only. Rates are merchant-entered, and Scalius never invents a legal rate."
        footer={(
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{readiness.description}</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() => onOpenTarget(readiness.nextTab)}
            >
              {readiness.nextAction}
            </Button>
          </div>
        )}
      >
        <dl className="space-y-3">
          {readiness.steps.map((step) => (
            <div key={step.id} className="flex items-start gap-2.5">
              {step.ready ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <CircleOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <div className="min-w-0">
                <dt className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {step.label}
                  <StatusBadge tone={step.ready ? "success" : "attention"} srLabel="Check:">
                    {step.ready ? "Ready" : "Needs attention"}
                  </StatusBadge>
                </dt>
                <dd className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
                  {step.detail}
                </dd>
              </div>
            </div>
          ))}
        </dl>
      </SettingsSection>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  help,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={id} className="text-sm">{label}</Label>
        <Switch
          className="relative shrink-0 after:absolute after:-inset-x-1.5 after:-inset-y-3"
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={`${id}-help`}
          onCheckedChange={onCheckedChange}
        />
      </div>
      <InlineHelp id={`${id}-help`} className="mt-1 max-w-prose">{help}</InlineHelp>
    </div>
  );
}
