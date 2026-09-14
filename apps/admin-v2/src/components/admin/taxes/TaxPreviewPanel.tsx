import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Calculator, Loader2 } from "lucide-react";

import { FieldError } from "~/components/admin/shell/FieldError";
import { InlineHelp } from "~/components/admin/shell/InlineHelp";
import { StatusBadge } from "~/components/admin/shell/StatusBadge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  previewTaxConfiguration,
  type TaxConfigurationPayload,
} from "~/lib/api-functions/taxes";
import { getServerFnError } from "~/lib/api-helpers";
import { formatTaxMoney } from "./tax-form";

const DEFAULT_CLASS = "__default__";
const NO_AREA = "__none__";

export function TaxPreviewPanel({
  configuration,
}: {
  configuration: TaxConfigurationPayload;
}) {
  const [amount, setAmount] = useState("1000");
  const [quantity, setQuantity] = useState("1");
  const [shippingAmount, setShippingAmount] = useState("0");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [taxClassId, setTaxClassId] = useState(DEFAULT_CLASS);
  const [city, setCity] = useState("");
  const [zone, setZone] = useState("");
  const [area, setArea] = useState(NO_AREA);

  const cities = useMemo(
    () => configuration.jurisdictions.filter((option) => option.type === "city"),
    [configuration.jurisdictions],
  );
  const zones = useMemo(
    () => configuration.jurisdictions.filter((option) => option.type === "zone" && (!city || option.parentId === city)),
    [city, configuration.jurisdictions],
  );
  const areas = useMemo(
    () => configuration.jurisdictions.filter((option) => option.type === "area" && (!zone || option.parentId === zone)),
    [configuration.jurisdictions, zone],
  );
  const cityOptions = useMemo(
    () => cities.map((option) => ({ value: option.id, label: option.name })),
    [cities],
  );
  const zoneOptions = useMemo(
    () => zones.map((option) => ({ value: option.id, label: option.name })),
    [zones],
  );
  const areaOptions = useMemo(
    () => [
      { value: NO_AREA, label: "No area" },
      ...areas.map((option) => ({ value: option.id, label: option.name })),
    ],
    [areas],
  );

  const parsed = {
    amount: Number(amount),
    quantity: Number(quantity),
    shippingAmount: Number(shippingAmount),
    discountAmount: Number(discountAmount),
  };
  const amountsValid = Number.isFinite(parsed.amount) && parsed.amount >= 0 &&
    Number.isInteger(parsed.quantity) && parsed.quantity >= 1 && parsed.quantity <= 99 &&
    Number.isFinite(parsed.shippingAmount) && parsed.shippingAmount >= 0 &&
    Number.isFinite(parsed.discountAmount) && parsed.discountAmount >= 0;
  const destinationValid = Boolean(city && zone);
  const inputValid = amountsValid && destinationValid;

  const previewMutation = useMutation({
    mutationFn: () => previewTaxConfiguration({ data: {
      ...parsed,
      taxClassId: taxClassId === DEFAULT_CLASS ? null : taxClassId,
      city,
      zone,
      area: area === NO_AREA ? null : area,
    } }),
  });
  const preview = previewMutation.data;

  return (
    <form
      method="post"
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (inputValid) previewMutation.mutate();
      }}
    >
      <section className="space-y-4" aria-label="Order amounts">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField id="preview-amount" label="Unit price" value={amount} onChange={setAmount} />
          <NumberField id="preview-quantity" label="Quantity" value={quantity} onChange={setQuantity} integer />
          <NumberField id="preview-shipping" label="Shipping" value={shippingAmount} onChange={setShippingAmount} />
          <NumberField id="preview-discount" label="Discount" value={discountAmount} onChange={setDiscountAmount} />
        </div>
        {!amountsValid ? (
          <FieldError>
            Enter non-negative amounts and a quantity from 1 to 99.
          </FieldError>
        ) : null}
      </section>

      <section className="space-y-4" aria-label="Destination">
        <div className="space-y-1.5">
          <Label htmlFor="preview-class">Tax class</Label>
          <Select value={taxClassId} onValueChange={setTaxClassId}>
            <SelectTrigger id="preview-class" className="min-h-11 sm:min-h-9" aria-label="Preview tax class">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_CLASS} className="min-h-11 sm:min-h-9">Store default</SelectItem>
              {configuration.classes.map((taxClass) => (
                <SelectItem key={taxClass.id} value={taxClass.id} className="min-h-11 sm:min-h-9">
                  {taxClass.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="preview-city">City</Label>
            <SearchableSelect
              id="preview-city"
              value={city}
              options={cityOptions}
              onValueChange={(value) => { setCity(value); setZone(""); setArea(NO_AREA); }}
              placeholder="Choose city"
              searchPlaceholder="Search cities…"
              emptyMessage="No matching cities."
              ariaLabel="Preview city"
              required
              maxVisibleOptions={100}
              triggerClassName="w-full"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="preview-zone">Zone</Label>
            <SearchableSelect
              id="preview-zone"
              value={zone}
              options={zoneOptions}
              onValueChange={(value) => { setZone(value); setArea(NO_AREA); }}
              placeholder="Choose zone"
              searchPlaceholder="Search zones…"
              emptyMessage="No matching zones."
              ariaLabel="Preview zone"
              disabled={!city}
              required
              maxVisibleOptions={100}
              triggerClassName="w-full"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="preview-area">Area (optional)</Label>
            <SearchableSelect
              id="preview-area"
              value={area}
              options={areaOptions}
              onValueChange={setArea}
              placeholder="No area"
              searchPlaceholder="Search areas…"
              emptyMessage="No matching areas."
              ariaLabel="Preview area"
              disabled={!zone}
              maxVisibleOptions={100}
              triggerClassName="w-full"
            />
            <InlineHelp>
              Area narrows the match when an area rate is saved for this zone.
            </InlineHelp>
          </div>
        </div>
        {cities.length === 0 ? (
          <FieldError>
            Import or create delivery locations before running a destination preview.
          </FieldError>
        ) : null}
      </section>

      <Button type="submit" className="min-h-11 w-full sm:min-h-9" disabled={!inputValid || previewMutation.isPending}>
        {previewMutation.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Calculator className="h-4 w-4" aria-hidden="true" />
        )}
        Calculate preview
      </Button>
      {previewMutation.isError ? (
        <FieldError>
          {getServerFnError(previewMutation.error, "Preview could not be calculated.")}
        </FieldError>
      ) : null}

      <section
        aria-label="Preview result"
        aria-live="polite"
        className="rounded-lg border border-border bg-muted/30 p-4"
      >
        {preview ? (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  {preview.displayLabel}
                </p>
                <p className="mt-1 text-3xl font-semibold tracking-tight">
                  {formatTaxMoney(preview.taxAmount, preview.currencyCode)}
                </p>
              </div>
              <StatusBadge tone="info" dot={false} srLabel="Pricing:">
                {preview.pricesIncludeTax ? "Tax included" : "Tax added"}
              </StatusBadge>
            </div>
            <div className="flex items-end justify-between border-t border-border pt-4">
              <span className="text-sm text-muted-foreground">Order total</span>
              <span className="text-xl font-semibold">
                {formatTaxMoney(preview.totalAmount, preview.currencyCode)}
              </span>
            </div>
            <div className="space-y-2">
              {preview.components.map((component, index) => (
                <div key={`${component.name}:${index}`} className="flex justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate">{component.name} · {(component.rateBps / 100).toFixed(2)}%</span>
                  <span className="shrink-0 tabular-nums">
                    {formatTaxMoney(component.amountMinor / 10 ** preview.decimalPlaces, preview.currencyCode)}
                  </span>
                </div>
              ))}
              {preview.components.length === 0 ? (
                <p className="text-xs text-muted-foreground">No matching rate components.</p>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Choose a destination and calculate to see the result.
          </p>
        )}
      </section>

      <p className="text-xs leading-5 text-muted-foreground">
        The preview runs the saved configuration against a hypothetical order. It does
        not change catalog or checkout data.
      </p>
    </form>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  integer = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  integer?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        className="min-h-11 sm:min-h-9"
        id={id}
        type="number"
        min="0"
        step={integer ? "1" : "0.01"}
        inputMode={integer ? "numeric" : "decimal"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
