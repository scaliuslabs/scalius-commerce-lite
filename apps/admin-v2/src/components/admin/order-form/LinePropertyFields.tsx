import { lineInputConfirmOption, lineInputIssues, lineInputLength, type CustomizationSchema } from "@scalius/shared/line-properties";
import { cn } from "@scalius/shared/utils";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { Field } from "~/components/ui/field";

export const linePropertyFieldId = (key: string) => `line-property-${key}`;

/** A message under one buyer input. */
export interface LinePropertyError {
  key: string;
  message: string;
}

/**
 * What the buyer would be told before the line is added: the shared
 * per-field rule (`lineInputIssues`, as the storefront and the server judge
 * the inputs), one message per field in schema order.
 */
export function linePropertyErrors(
  schema: CustomizationSchema,
  values: Readonly<Record<string, string>>,
  t: (key: "inputRequired" | "inputInvalid" | "inputTooLong" | "agreementRequired", vars: Record<string, string | number>) => string,
  agreed: ReadonlySet<string> = new Set(),
): LinePropertyError[] {
  const entries = schema.fields.map((field) => ({ key: field.key, value: values[field.key] ?? "" }));
  const issues = lineInputIssues(schema, entries).map(({ key, problem }) => {
    const label = schema.fields.find((field) => field.key === key)?.label ?? "";
    const message = problem.kind === "too_long"
      ? t("inputTooLong", { label, max: problem.maxLength })
      : t(problem.kind === "required" ? "inputRequired" : "inputInvalid", { label });
    return { key, message };
  });
  // A choice that needs the buyer's agreement, chosen without the tick: the server would refuse it.
  for (const field of schema.fields) {
    const option = lineInputConfirmOption(field, (values[field.key] ?? "").trim());
    if (option && !agreed.has(field.key) && !issues.some((issue) => issue.key === field.key)) {
      issues.push({ key: field.key, message: t("agreementRequired", { label: option.label }) });
    }
  }
  return schema.fields.flatMap((field) => issues.filter((issue) => issue.key === field.key));
}

/**
 * The product's buyer inputs for a line added by staff, as the buyer sees
 * them on the product page: labelled fields with character counts, choices
 * showing "+৳200", a box to tick. Values are buyer content: they go in the
 * request body only.
 */
export function LinePropertyFields({ schema, values, onChange, errors, surcharge, agreed = new Set(), onAgree }: {
  schema: CustomizationSchema;
  values: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
  /** The choices staff ticked the buyer agrees to (an app's choice that needs agreement), by field key. */
  agreed?: ReadonlySet<string>;
  onAgree?: (key: string, agreed: boolean) => void;
  /** Why the last Add was refused, under each field it names (`linePropertyErrors`). */
  errors: readonly LinePropertyError[];
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
        const fieldError = errors.find((entry) => entry.key === field.key);
        const invalid = Boolean(fieldError);
        const describedBy = [field.help ? `${id}-help` : null, invalid ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
        const label = `${field.label}${field.required ? "" : ` ${t("optional")}`}`;
        const help = field.help ? <p id={`${id}-help`} className="text-body text-muted-foreground">{field.help}</p> : null;
        const message = invalid ? <p id={`${id}-error`} className="text-body text-destructive">{fieldError!.message}</p> : null;
        // An app's file input takes the buyer's own uploads: staff cannot answer it here.
        if (field.type === "file") return null;
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
          <div key={field.key} className="flex flex-col gap-1">
            <Field id={id} label={field.type === "select" ? label : `${label}${extra(field.priceMinor)}`} help={field.help} error={fieldError?.message}>
            {field.type === "select" ? (
              <SearchableSelect
                id={id}
                value={value}
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
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            ) : (
              <Input
                id={id}
                value={value}
                maxLength={field.maxLength}
                autoComplete="off"
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            )}
            </Field>
            {field.type === "select" ? (() => {
              // An app's choice taken only with the buyer's agreement: staff read it out and tick it.
              const option = lineInputConfirmOption(field, value);
              if (!option) return null;
              const agreeId = `${id}-agree`;
              return (
                <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                  {option.confirm.title ? <p className="text-body font-medium">{option.confirm.title}</p> : null}
                  <p id={`${id}-agreement`} className="whitespace-pre-line text-body text-muted-foreground">{option.confirm.text}</p>
                  <div className="flex items-start gap-3">
                    <span className="flex h-lh items-center">
                      <Checkbox
                        id={agreeId}
                        checked={agreed.has(field.key)}
                        aria-describedby={`${id}-agreement`}
                        aria-invalid={invalid || undefined}
                        onCheckedChange={(checked) => onAgree?.(field.key, checked === true)}
                      />
                    </span>
                    <Label htmlFor={agreeId}>{option.confirm.agree ?? t("buyerAgrees")}</Label>
                  </div>
                </div>
              );
            })() : (
              // Over the limit the count turns red, as on the product page.
              <p
                className={cn("text-end text-body tabular-nums", lineInputLength(value) > field.maxLength ? "text-destructive" : "text-muted-foreground")}
                aria-live="polite"
              >
                {t("characterCount", { count: lineInputLength(value), max: field.maxLength })}
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
