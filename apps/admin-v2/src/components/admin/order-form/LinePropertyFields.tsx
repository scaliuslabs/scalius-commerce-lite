import type { CustomizationSchema } from "@scalius/shared/line-properties";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";

export const linePropertyFieldId = (key: string) => `line-property-${key}`;

/**
 * The product's buyer inputs for a line added by staff, as the buyer sees
 * them on the product page: labelled fields with character counts, choices
 * showing "+৳200", a box to tick. Values are buyer content: they go in the
 * request body only.
 */
export function LinePropertyFields({ schema, values, onChange, error, surcharge }: {
  schema: CustomizationSchema;
  values: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
  /** The field the last Add was refused for, with why. */
  error: { key: string | null; message: string } | null;
  /** Formats a surcharge in minor units. */
  surcharge: (priceMinor: number) => string;
}) {
  const t = useMessages(orderFormMessages);
  const extra = (priceMinor: number) => (priceMinor > 0 ? ` (+${surcharge(priceMinor)})` : "");
  return (
    <fieldset className="space-y-3">
      <legend className="text-body font-medium">{t("buyerInputs")}</legend>
      {schema.fields.map((field) => {
        const id = linePropertyFieldId(field.key);
        const value = values[field.key] ?? "";
        const invalid = error?.key === field.key;
        const describedBy = [field.help ? `${id}-help` : null, invalid ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
        const label = `${field.label}${field.required ? "" : ` ${t("optional")}`}`;
        const help = field.help ? <p id={`${id}-help`} className="text-body text-muted-foreground">{field.help}</p> : null;
        const message = invalid ? <p id={`${id}-error`} className="text-body text-destructive">{error!.message}</p> : null;
        if (field.type === "checkbox") {
          return (
            <div key={field.key} className="space-y-1">
              <div className="flex items-start gap-3">
                <span className="flex h-lh items-center">
                  <Checkbox
                    id={id}
                    checked={value === "true"}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    onCheckedChange={(checked) => onChange(field.key, checked === true ? "true" : "")}
                  />
                </span>
                <Label htmlFor={id}>{label}{extra(field.priceMinor)}</Label>
              </div>
              {help}
              {message}
            </div>
          );
        }
        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={id}>
              {field.type === "select" ? label : `${label}${extra(field.priceMinor)}`}
            </Label>
            {field.type === "select" ? (
              <SearchableSelect
                id={id}
                value={value}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onValueChange={(next) => onChange(field.key, next)}
                triggerClassName="w-full"
                placeholder={t("chooseOption")}
                options={[
                  { value: "", label: t("chooseOption") },
                  ...field.options.map((option) => ({ value: option.value, label: `${option.label}${extra(option.priceMinor)}` })),
                ]}
              />
            ) : field.type === "textarea" ? (
              <Textarea
                id={id}
                rows={3}
                value={value}
                maxLength={field.maxLength}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            ) : (
              <Input
                id={id}
                value={value}
                maxLength={field.maxLength}
                autoComplete="off"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            )}
            {field.type === "select" ? null : (
              <p className="text-right text-body text-muted-foreground tabular-nums" aria-live="polite">
                {t("characterCount", { count: [...value].length, max: field.maxLength })}
              </p>
            )}
            {help}
            {message}
          </div>
        );
      })}
    </fieldset>
  );
}
