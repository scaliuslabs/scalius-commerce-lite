import { X } from "lucide-react";
import {
  CUSTOMER_SEGMENT_DAYS_MAX,
  CUSTOMER_TAGS_PER_CUSTOMER_MAX,
  MARKETING_CHANNELS,
  MARKETING_CONSENT_STATUSES,
} from "@scalius/shared/customer-marketing";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { customerMarketingMessages } from "~/i18n/customer-marketing";
import { customersMessages } from "~/i18n/customers";
import { customerSegmentMessages, type CustomerSegmentMessageKey } from "~/i18n/customer-segments";
import type { CustomFieldDefinition } from "~/lib/api-query-options/custom-fields";
import { LocationIdsPicker } from "./LocationIdsPicker";
import { TagInput } from "./TagInput";
import {
  SEGMENT_CUSTOMER_TYPES,
  SEGMENT_DATE_OPS,
  type ConditionDraft,
  type ConditionProblem,
} from "./segment-draft";
import { DateInput } from "~/components/ui/date-input";
import { Field, FieldRow } from "~/components/ui/field";

const FULL = "w-full";

/**
 * One segment filter: its name, the controls for its rule and value(s), a
 * remove button and, once Save was pressed, what is missing.
 */
export function SegmentConditionRow({
  condition,
  onChange,
  onRemove,
  problem,
  showProblem,
  disabled,
  customerFields,
}: {
  condition: ConditionDraft;
  onChange: (next: ConditionDraft) => void;
  onRemove: () => void;
  problem: ConditionProblem | undefined;
  showProblem: boolean;
  disabled: boolean;
  /** Customer custom field definitions (for the Custom data filter). */
  customerFields: readonly CustomFieldDefinition[] | undefined;
}) {
  const t = useMessages(customerSegmentMessages);
  const c = useMessages(customersMessages);
  const m = useMessages(customerMarketingMessages);
  const { code, symbol } = useCurrency();
  const key = condition.key;
  const name = t(`field.${condition.field}` as CustomerSegmentMessageKey);
  const shown = showProblem && problem ? problem : null;
  const noteId = `${key}-problem`;
  const invalid = shown !== null;
  const aria = invalid ? { "aria-invalid": true as const, "aria-describedby": noteId } : {};

  const body = (() => {
    switch (condition.field) {
      case "amount_spent":
      case "orders_count": {
        const money = condition.field === "amount_spent";
        const input = (bound: "min" | "max") => {
          const id = `${key}-${bound}`;
          const props = {
            id,
            value: condition[bound],
            onValueChange: (value: number | null) => onChange({ ...condition, [bound]: value }),
            disabled,
            ...aria,
          };
          return (
            <Field id={id} label={t(bound === "min" ? "atLeast" : "atMost")}>
              {money ? <MoneyInput {...props} currencyCode={code} /> : <NumberInput {...props} integer />}
            </Field>
          );
        };
        return (
          <>
            <FieldRow>
              {input("min")}
              {input("max")}
            </FieldRow>
            <p className="text-body text-muted-foreground">{t("rangeHelp")}</p>
          </>
        );
      }
      case "last_order_date":
      case "first_order_date":
      case "customer_since": {
        const relative = condition.op === "within_last" || condition.op === "not_within_last";
        return (
          <>
            <FieldRow>
              <Field id={`${key}-op`} label={t("dateOp")}>
                <SearchableSelect
                  id={`${key}-op`}
                  value={condition.op}
                  disabled={disabled}
                  onValueChange={(op) => onChange({ ...condition, op: op as typeof condition.op })}
                  options={SEGMENT_DATE_OPS.map((op) => ({ value: op, label: t(`op.${op}`) }))}
                  triggerClassName={FULL}
                />
              </Field>
              {relative ? (
                <Field id={`${key}-days`} label={t("days")}>
                  <NumberInput
                    id={`${key}-days`}
                    integer
                    value={condition.days}
                    disabled={disabled}
                    onValueChange={(days) => onChange({ ...condition, days })}
                    {...aria}
                  />
                </Field>
              ) : (
                <Field id={`${key}-date`} label={t("date")}>
                  <DateInput
                    id={`${key}-date`}
                    value={condition.date}
                    disabled={disabled}
                    onValueChange={(date) => onChange({ ...condition, date })}
                    {...aria}
                  />
                </Field>
              )}
            </FieldRow>
            {condition.field !== "customer_since" ? <p className="text-body text-muted-foreground">{t("neverOrderedNote")}</p> : null}
          </>
        );
      }
      case "city":
      case "zone":
        return (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            <Field id={`${key}-op`} label={t("placeOp")}>
              <SearchableSelect
                id={`${key}-op`}
                value={condition.op}
                disabled={disabled}
                onValueChange={(op) => onChange({ ...condition, op: op as typeof condition.op })}
                options={(["in", "not_in"] as const).map((op) => ({ value: op, label: t(`op.${op}`) }))}
                triggerClassName={FULL}
              />
            </Field>
            <Field id={`${key}-places`} label={name}>
              <LocationIdsPicker
                id={`${key}-places`}
                type={condition.field}
                ids={condition.ids}
                disabled={disabled}
                invalid={invalid}
                describedBy={invalid ? noteId : undefined}
                onChange={(ids) => onChange({ ...condition, ids })}
              />
            </Field>
          </div>
        );
      case "tags":
        return (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            <Field id={`${key}-op`} label={t("tagOp")}>
              <SearchableSelect
                id={`${key}-op`}
                value={condition.op}
                disabled={disabled}
                onValueChange={(op) => onChange({ ...condition, op: op as typeof condition.op })}
                options={(["has_any", "has_all", "has_none"] as const).map((op) => ({ value: op, label: t(`op.${op}`) }))}
                triggerClassName={FULL}
              />
            </Field>
            <Field id={`${key}-tags`} label={name}>
              <TagInput
                id={`${key}-tags`}
                value={condition.tags}
                max={CUSTOMER_TAGS_PER_CUSTOMER_MAX}
                disabled={disabled}
                preferExisting
                onChange={(tags) => onChange({ ...condition, tags })}
                {...aria}
              />
            </Field>
          </div>
        );
      case "marketing_consent":
        return (
          <FieldRow>
            <Field id={`${key}-channel`} label={t("consentChannel")}>
              <SearchableSelect
                id={`${key}-channel`}
                value={condition.channel}
                disabled={disabled}
                onValueChange={(channel) => onChange({ ...condition, channel: channel as typeof condition.channel })}
                options={MARKETING_CHANNELS.map((channel) => ({ value: channel, label: c(`channel.${channel}`) }))}
                triggerClassName={FULL}
              />
            </Field>
            <Field id={`${key}-status`} label={t("consentStatus")}>
              <SearchableSelect
                id={`${key}-status`}
                value={condition.status}
                disabled={disabled}
                onValueChange={(status) => onChange({ ...condition, status: status as typeof condition.status })}
                options={MARKETING_CONSENT_STATUSES.map((status) => ({ value: status, label: m(`status.${status}`) }))}
                triggerClassName={FULL}
              />
            </Field>
          </FieldRow>
        );
      case "customer_type":
        return (
          <fieldset className="space-y-1" aria-describedby={invalid ? noteId : undefined}>
            <legend className="sr-only">{name}</legend>
            {SEGMENT_CUSTOMER_TYPES.map((type) => (
              <label key={type} className="flex min-h-11 items-center gap-3 text-body md:min-h-9">
                <Checkbox
                  checked={condition.types.includes(type)}
                  disabled={disabled}
                  aria-invalid={invalid || undefined}
                  onCheckedChange={(checked) => onChange({
                    ...condition,
                    types: checked === true
                      ? SEGMENT_CUSTOMER_TYPES.filter((item) => item === type || condition.types.includes(item))
                      : condition.types.filter((item) => item !== type),
                  })}
                />
                {t(`type.${type}`)}
              </label>
            ))}
          </fieldset>
        );
      case "custom_field": {
        const fields = customerFields ?? [];
        return (
          <FieldRow columns={3}>
            <Field id={`${key}-field`} label={t("customField")}>
              <SearchableSelect
                id={`${key}-field`}
                value={condition.definitionId}
                disabled={disabled}
                busy={customerFields === undefined}
                placeholder={t("chooseField")}
                emptyMessage={t("noCustomFields")}
                aria-invalid={(invalid && problem === "field_empty") || undefined}
                aria-describedby={invalid ? noteId : undefined}
                onValueChange={(definitionId) => onChange({ ...condition, definitionId })}
                options={fields.map((field) => ({ value: field.id, label: field.name, description: field.namespace !== "custom" ? field.namespace : undefined }))}
                triggerClassName={FULL}
              />
            </Field>
            <Field id={`${key}-op`} label={t("fieldOp")}>
              <SearchableSelect
                id={`${key}-op`}
                value={condition.op}
                disabled={disabled}
                onValueChange={(op) => onChange({ ...condition, op: op as typeof condition.op })}
                options={(["is_set", "is_not_set", "equals"] as const).map((op) => ({ value: op, label: t(`op.${op}`) }))}
                triggerClassName={FULL}
              />
            </Field>
            {condition.op === "equals" ? (
              <Field id={`${key}-value`} label={t("value")}>
                <Input
                  id={`${key}-value`}
                  value={condition.value}
                  maxLength={500}
                  disabled={disabled}
                  onChange={(event) => onChange({ ...condition, value: event.target.value })}
                  {...(invalid && problem === "value_empty" ? aria : {})}
                />
              </Field>
            ) : null}
          </FieldRow>
        );
      }
    }
  })();

  return (
    <li className="space-y-3 border-t py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-heading-sm">{name}</h3>
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("removeFilter", { name })} onClick={onRemove}>
          <X aria-hidden="true" />
        </Button>
      </div>
      {body}
      {shown ? (
        <p id={noteId} className="text-body text-destructive">
          {t(`problem.${shown}`, shown === "days_invalid" ? { max: CUSTOMER_SEGMENT_DAYS_MAX } : undefined)}
        </p>
      ) : null}
    </li>
  );
}
