import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, Save } from "lucide-react";
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

  const issue = taxSettingsIssue(form);
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
          <div className="grid gap-5 md:grid-cols-2">
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
                <SelectTrigger><SelectValue /></SelectTrigger>
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
                <SelectTrigger><SelectValue /></SelectTrigger>
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
            <div className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
              Configuration version <span className="font-mono text-foreground">{form.expectedVersion}</span> prevents a stale tab from overwriting newer rules.
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
            <CheckCircle2 className="h-4 w-4 text-primary" />
            Release-safe behavior
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>Disabled or missing configuration produces zero tax.</p>
          <p>Checkout resolves current SKU price, class, destination, discounts, and shipping on the server.</p>
          <p>Every order stores an immutable minor-unit calculation snapshot.</p>
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
