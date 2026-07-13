import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, ReceiptText, Save } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  saveTaxSettings,
  type TaxConfigurationPayload,
  type UpdateTaxSettingsInput,
} from "@/lib/api-functions/taxes";
import { getServerFnError } from "@/lib/api-helpers";
import { queryKeys } from "@/lib/query-keys";
import { taxSettingsIssue } from "./tax-form";

const NO_CLASS = "__none__";

export function TaxSettingsPanel({
  configuration,
  canManage,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<UpdateTaxSettingsInput>(() => ({
    expectedVersion: configuration.settings.version,
    enabled: configuration.settings.enabled,
    pricesIncludeTax: configuration.settings.pricesIncludeTax,
    taxShipping: configuration.settings.taxShipping,
    defaultTaxClassId: configuration.settings.defaultTaxClassId,
    shippingTaxClassId: configuration.settings.shippingTaxClassId,
    displayLabel: configuration.settings.displayLabel,
  }));

  useEffect(() => {
    setForm({
      expectedVersion: configuration.settings.version,
      enabled: configuration.settings.enabled,
      pricesIncludeTax: configuration.settings.pricesIncludeTax,
      taxShipping: configuration.settings.taxShipping,
      defaultTaxClassId: configuration.settings.defaultTaxClassId,
      shippingTaxClassId: configuration.settings.shippingTaxClassId,
      displayLabel: configuration.settings.displayLabel,
    });
  }, [configuration.settings]);

  const issue = taxSettingsIssue(form, configuration);
  const saveMutation = useMutation({
    mutationFn: () => saveTaxSettings({ data: form }),
    onSuccess: async () => {
      toast.success("Tax settings saved");
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Tax settings could not be saved."));
    },
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
      <Card>
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Calculation policy</CardTitle>
              <CardDescription className="mt-1">
                Rates are merchant-entered. Scalius never invents a legal rate.
              </CardDescription>
            </div>
            <Badge variant={form.enabled ? "default" : "secondary"}>
              {form.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-5 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="tax-display-label">Buyer-facing label</Label>
              <Input
                id="tax-display-label"
                value={form.displayLabel}
                maxLength={80}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  displayLabel: event.target.value,
                }))}
                placeholder="Tax"
                disabled={!canManage}
              />
            </div>
            <div className="space-y-2">
              <Label>Default product class</Label>
              <Select
                disabled={!canManage}
                value={form.defaultTaxClassId ?? NO_CLASS}
                onValueChange={(value) => setForm((current) => ({
                  ...current,
                  defaultTaxClassId: value === NO_CLASS ? null : value,
                }))}
              >
                <SelectTrigger aria-label="Default product tax class"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CLASS}>Not configured</SelectItem>
                  {configuration.classes.map((taxClass) => (
                    <SelectItem key={taxClass.id} value={taxClass.id}>
                      {taxClass.name}{taxClass.isExempt ? " · exempt" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Shipping class</Label>
              <Select
                disabled={!canManage}
                value={form.shippingTaxClassId ?? NO_CLASS}
                onValueChange={(value) => setForm((current) => ({
                  ...current,
                  shippingTaxClassId: value === NO_CLASS ? null : value,
                }))}
              >
                <SelectTrigger aria-label="Shipping tax class"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CLASS}>Use default class</SelectItem>
                  {configuration.classes.map((taxClass) => (
                    <SelectItem key={taxClass.id} value={taxClass.id}>
                      {taxClass.name}{taxClass.isExempt ? " · exempt" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <PolicySwitch
              id="tax-enabled"
              label="Calculate tax"
              description="Apply the saved rules at checkout."
              checked={form.enabled}
              disabled={!canManage}
              onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))}
            />
            <PolicySwitch
              id="tax-inclusive"
              label="Prices include tax"
              description="Extract tax from listed prices instead of adding it."
              checked={form.pricesIncludeTax}
              disabled={!canManage}
              onCheckedChange={(pricesIncludeTax) => setForm((current) => ({
                ...current,
                pricesIncludeTax,
              }))}
            />
            <PolicySwitch
              id="tax-shipping"
              label="Tax shipping"
              description="Apply the selected class to delivery charges."
              checked={form.taxShipping}
              disabled={!canManage}
              onCheckedChange={(taxShipping) => setForm((current) => ({ ...current, taxShipping }))}
            />
          </div>

          {issue ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Configuration needs attention</AlertTitle>
              <AlertDescription>{issue}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex justify-end">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!canManage || Boolean(issue) || saveMutation.isPending}
            >
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save policy
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="h-fit border-primary/20 bg-primary/[0.03]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ReceiptText className="h-4 w-4 text-primary" />
            Checkout outcome
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            {!form.enabled
              ? "Checkout does not charge tax."
              : form.pricesIncludeTax
                ? "Matching tax is included in the displayed price."
                : "Matching tax is added after discounts at checkout."}
          </p>
          <p>{form.taxShipping ? "Delivery charges use the selected shipping class." : "Delivery charges are not taxed."}</p>
          <p>Existing orders keep the tax totals they had when customers placed them.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function PolicySwitch({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}
