import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Calculator, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  previewTaxConfiguration,
  type TaxConfigurationPayload,
} from "@/lib/api-functions/taxes";
import { getServerFnError } from "@/lib/api-helpers";
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

  const parsed = {
    amount: Number(amount),
    quantity: Number(quantity),
    shippingAmount: Number(shippingAmount),
    discountAmount: Number(discountAmount),
  };
  const inputValid = Number.isFinite(parsed.amount) && parsed.amount >= 0 &&
    Number.isInteger(parsed.quantity) && parsed.quantity >= 1 && parsed.quantity <= 99 &&
    Number.isFinite(parsed.shippingAmount) && parsed.shippingAmount >= 0 &&
    Number.isFinite(parsed.discountAmount) && parsed.discountAmount >= 0 &&
    Boolean(city && zone);

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
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card>
        <CardHeader>
          <CardTitle>Calculation preview</CardTitle>
          <CardDescription>Run the saved configuration against a hypothetical order. This does not change catalog or checkout data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField id="preview-amount" label="Unit price" value={amount} onChange={setAmount} />
            <NumberField id="preview-quantity" label="Quantity" value={quantity} onChange={setQuantity} integer />
            <NumberField id="preview-shipping" label="Shipping" value={shippingAmount} onChange={setShippingAmount} />
            <NumberField id="preview-discount" label="Discount" value={discountAmount} onChange={setDiscountAmount} />
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label>Tax class</Label>
              <Select value={taxClassId} onValueChange={setTaxClassId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_CLASS}>Store default</SelectItem>
                  {configuration.classes.map((taxClass) => <SelectItem key={taxClass.id} value={taxClass.id}>{taxClass.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>City</Label>
              <Select value={city} onValueChange={(value) => { setCity(value); setZone(""); setArea(NO_AREA); }}>
                <SelectTrigger><SelectValue placeholder="Choose city" /></SelectTrigger>
                <SelectContent>{cities.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Zone</Label>
              <Select value={zone} disabled={!city} onValueChange={(value) => { setZone(value); setArea(NO_AREA); }}>
                <SelectTrigger><SelectValue placeholder="Choose zone" /></SelectTrigger>
                <SelectContent>{zones.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Area (optional)</Label>
              <Select value={area} disabled={!zone} onValueChange={setArea}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_AREA}>No area</SelectItem>
                  {areas.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {cities.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Import or create delivery locations before running a destination preview.</p>
          ) : null}
          <Button disabled={!inputValid || previewMutation.isPending} onClick={() => previewMutation.mutate()}>
            {previewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
            Calculate preview
          </Button>
          {previewMutation.isError ? (
            <p className="text-sm text-destructive">{getServerFnError(previewMutation.error, "Preview could not be calculated.")}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="h-fit overflow-hidden">
        <CardHeader className="bg-muted/40">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">Preview result</CardTitle>
            {preview ? <Badge variant={preview.pricesIncludeTax ? "secondary" : "outline"}>{preview.pricesIncludeTax ? "Tax included" : "Tax added"}</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-6">
          {preview ? (
            <>
              <div>
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{preview.displayLabel}</p>
                <p className="mt-1 text-3xl font-semibold tracking-tight">{formatTaxMoney(preview.taxAmount, preview.currencyCode)}</p>
              </div>
              <div className="flex items-end justify-between border-t pt-4">
                <span className="text-sm text-muted-foreground">Order total</span>
                <span className="text-xl font-semibold">{formatTaxMoney(preview.totalAmount, preview.currencyCode)}</span>
              </div>
              <div className="space-y-2">
                {preview.components.map((component, index) => (
                  <div key={`${component.name}:${index}`} className="flex justify-between text-xs text-muted-foreground">
                    <span>{component.name} · {(component.rateBps / 100).toFixed(2)}%</span>
                    <span>{formatTaxMoney(component.amountMinor / 10 ** preview.decimalPlaces, preview.currencyCode)}</span>
                  </div>
                ))}
                {preview.components.length === 0 ? <p className="text-xs text-muted-foreground">No matching rate components.</p> : null}
              </div>
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">Choose a destination and calculate to see the server result.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NumberField({ id, label, value, onChange, integer = false }: { id: string; label: string; value: string; onChange: (value: string) => void; integer?: boolean }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Input id={id} type="number" min="0" step={integer ? "1" : "0.01"} inputMode={integer ? "numeric" : "decimal"} value={value} onChange={(event) => onChange(event.target.value)} /></div>;
}
