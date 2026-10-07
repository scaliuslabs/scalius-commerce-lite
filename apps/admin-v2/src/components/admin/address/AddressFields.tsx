// One address editor for the dashboard (MARKETS-DESIGN D7): a country, then
// that country's fields in its order with its labels (libaddressinput rules,
// read from the API one country at a time). Bangladesh keeps the street
// address and the City → Thana → Area picker couriers book with.
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { AddressField, AddressRules } from "@scalius/shared/address";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { LocationPicker, type LocationLevel } from "~/components/admin/location/LocationPicker";
import { useMessages } from "~/i18n";
import { countryName } from "~/lib/country-name";
import { addressMessages } from "~/i18n/address";
import { locationMessages } from "~/i18n/location";
import { addressCountriesQueryOptions, addressRulesQueryOptions } from "~/lib/api-query-options/address-rules";
import {
  addressFieldLabelKey,
  draftInCountry,
  usesLocationPicker,
  type AddressDraft,
  type AddressProblem,
  type AddressProblemField,
} from "./address-draft";


/** The rules of one country, for labels and messages outside the editor. */
export function useAddressRules(countryCode: string | null | undefined) {
  const code = countryCode && !usesLocationPicker(countryCode) ? countryCode : null;
  return useQuery({ ...addressRulesQueryOptions(code ?? "BD"), enabled: code !== null });
}

type AddressText = (key: keyof (typeof addressMessages)["en"], vars?: Record<string, string | number>) => string;
type PlaceText = (key: "city" | "zone" | "area") => string;

/**
 * The API's refusal (`readAddressProblems`) worded for the fields: one
 * message per field, in the dashboard language, with the country's label.
 */
export function addressProblemMessages(
  problems: readonly AddressProblem[] | null,
  rules: AddressRules | null,
  t: AddressText,
  place: PlaceText,
): Partial<Record<AddressProblemField, string>> {
  const errors: Partial<Record<AddressProblemField, string>> = {};
  for (const problem of problems ?? []) {
    if (errors[problem.field]) continue;
    if (problem.code === "unknown_country") {
      errors.countryCode = t("unknownCountry");
      continue;
    }
    const field = problem.field === "city" || problem.field === "zone" || problem.field === "area"
      ? place(problem.field)
      : problem.field === "countryCode" ? t("country")
        : problem.field === "phone" ? t("phone")
          : t(addressFieldLabelKey(problem.field, rules));
    const key = problem.code === "required" ? "required"
      : problem.code === "too_long" ? "tooLong"
        : problem.code === "unavailable" ? "unavailable" : "invalid";
    errors[problem.field] = t(key, { field });
  }
  return errors;
}

/** `addressProblemMessages` with the country's rules (loaded on demand). */
export function useAddressErrors(problems: readonly AddressProblem[] | null, countryCode: string) {
  const t = useMessages(addressMessages);
  const place = useMessages(locationMessages);
  const rules = useAddressRules(countryCode);
  return React.useMemo(
    () => addressProblemMessages(problems, rules.data ?? null, t, place),
    [problems, rules.data, t, place],
  );
}

export interface AddressFieldsProps {
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  /** Field messages (already worded), under each field. */
  errors?: Partial<Record<AddressProblemField, string | undefined>>;
  /** Element id prefix (labels, errors and focus). */
  idPrefix: string;
  /** The address book also takes a recipient name and company. */
  showRecipient?: boolean;
  /** A billing address: Bangladesh too fills its canonical fields (no City → Thana picker). */
  canonicalOnly?: boolean;
  /** The name field's label when not the recipient's (a billing name). */
  nameLabel?: string;
  disabled?: boolean;
  /** Bangladesh's street address and pickers, for keyboard moves from earlier fields. */
  line1Ref?: React.Ref<HTMLTextAreaElement>;
  locationRefs?: Partial<Record<LocationLevel, React.Ref<HTMLButtonElement>>>;
  onLine1KeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
}

const RECIPIENT_FIELDS = ["name", "company"] as const satisfies readonly AddressField[];
const isRecipientField = (field: AddressField) => (RECIPIENT_FIELDS as readonly AddressField[]).includes(field);

export function AddressFields({
  value,
  onChange,
  errors = {},
  idPrefix,
  showRecipient = false,
  canonicalOnly = false,
  nameLabel,
  disabled = false,
  line1Ref,
  locationRefs,
  onLine1KeyDown,
}: AddressFieldsProps) {
  const t = useMessages(addressMessages);
  const countries = useQuery(addressCountriesQueryOptions());
  const countryOptions = React.useMemo(
    () => (countries.data ?? [value.countryCode])
      .map((code) => ({ value: code, label: countryName(code), keywords: [code] }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    [countries.data, value.countryCode],
  );
  const set = (field: keyof AddressDraft, next: string) => onChange({ ...value, [field]: next });
  const id = (field: string) => `${idPrefix}-${field}`;
  const error = (field: AddressProblemField) => errors[field];

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <Label htmlFor={id("country")}>{t("country")}</Label>
        <SearchableSelect
          id={id("country")}
          value={value.countryCode}
          selectedLabel={countryName(value.countryCode)}
          options={countryOptions}
          onValueChange={(code) => code && onChange(draftInCountry(value, code))}
          disabled={disabled}
          placeholder={t("selectCountry")}
          searchPlaceholder={t("searchCountries")}
          emptyMessage={t("noCountries")}
          aria-invalid={error("countryCode") ? true : undefined}
          triggerClassName="w-full"
        />
        <FieldError id={id("country")} message={error("countryCode")} />
      </div>
      {showRecipient ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {RECIPIENT_FIELDS.map((field) => (
            <TextField key={field} id={id(field)} label={field === "name" && nameLabel ? nameLabel : t(field)} value={value[field]} disabled={disabled}
              error={error(field)} onChange={(next) => set(field, next)} />
          ))}
        </div>
      ) : null}
      {usesLocationPicker(value.countryCode) && !canonicalOnly ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor={id("line1")}>{t("line1")}</Label>
            <Textarea
              id={id("line1")}
              ref={line1Ref}
              rows={2}
              value={value.line1}
              disabled={disabled}
              onChange={(event) => set("line1", event.target.value)}
              onKeyDown={onLine1KeyDown}
              aria-invalid={error("line1") ? true : undefined}
              aria-describedby={error("line1") ? `${id("line1")}-error` : undefined}
            />
            <FieldError id={id("line1")} message={error("line1")} />
          </div>
          <LocationPicker
            ids={{ city: id("city"), zone: id("zone"), area: id("area") }}
            required={{ city: true, zone: true }}
            refs={locationRefs}
            disabled={disabled}
            value={{
              city: value.city ? { id: value.city, name: value.cityName } : null,
              zone: value.zone ? { id: value.zone, name: value.zoneName } : null,
              area: value.area ? { id: value.area, name: value.areaName } : null,
            }}
            errors={{ city: error("city"), zone: error("zone"), area: error("area") }}
            onChange={(next) => onChange({
              ...value,
              city: next.city?.id ?? null,
              zone: next.zone?.id ?? null,
              area: next.area?.id ?? null,
              cityName: next.city?.name ?? "",
              zoneName: next.zone?.name ?? "",
              areaName: next.area?.name ?? "",
            })}
          />
        </>
      ) : (
        <CountryFields value={value} onChange={onChange} errors={errors} id={id} disabled={disabled} />
      )}
    </div>
  );
}

/** Another country's fields, row by row as its rules order them. */
function CountryFields({
  value,
  onChange,
  errors,
  id,
  disabled,
}: {
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  errors: Partial<Record<AddressProblemField, string | undefined>>;
  id: (field: string) => string;
  disabled: boolean;
}) {
  const t = useMessages(addressMessages);
  const rules = useQuery(addressRulesQueryOptions(value.countryCode));
  if (rules.isPending) {
    // The usual shape (two lines, a city row, a region and postal row) so the dialog barely moves.
    return (
      <div className="grid gap-3" aria-busy="true" aria-label={t("rulesLoading")}>
        {[0, 1, 2].map((row) => <Skeleton key={row} className="h-16 w-full" />)}
      </div>
    );
  }
  if (!rules.data) return <p className="text-body text-destructive">{t("rulesFailed")}</p>;
  const data: AddressRules = rules.data;
  const required = new Set(data.requiredFields);
  const rows = data.rows
    .map((row) => row.filter((field) => !isRecipientField(field)))
    .filter((row) => row.length > 0);
  const set = (field: AddressField, next: string) => onChange({ ...value, [field]: next });

  return (
    <>
      {rows.map((row) => (
        <div key={row.join("-")} className={row.length > 1 ? "grid gap-3 sm:grid-cols-2" : "grid gap-3"}>
          {row.map((field) => {
            const label = t(addressFieldLabelKey(field, data));
            if (field === "adminArea" && data.adminAreas.length > 0) {
              const options = data.adminAreas.map((area) => ({ value: area.code, label: area.name, keywords: [area.code] }));
              const current = data.adminAreas.find((area) => area.code === value.adminArea);
              return (
                <div key={field} className="grid gap-2">
                  <Label htmlFor={id(field)}>{label}</Label>
                  <SearchableSelect
                    id={id(field)}
                    value={value.adminArea}
                    selectedLabel={current?.name ?? (value.adminArea || undefined)}
                    options={options}
                    onValueChange={(code) => set("adminArea", code)}
                    disabled={disabled}
                    required={required.has(field)}
                    clearable={!required.has(field)}
                    placeholder={t("select")}
                    searchPlaceholder={t("search")}
                    emptyMessage={t("noMatches")}
                    aria-invalid={errors[field] ? true : undefined}
                    aria-describedby={errors[field] ? `${id(field)}-error` : undefined}
                    triggerClassName="w-full"
                  />
                  <FieldError id={id(field)} message={errors[field]} />
                </div>
              );
            }
            return (
              <TextField
                key={field}
                id={id(field)}
                label={label}
                value={value[field]}
                required={required.has(field)}
                disabled={disabled}
                error={errors[field]}
                hint={field === "postalCode" && data.postalCodeExamples[0] ? t("example", { example: data.postalCodeExamples[0] }) : undefined}
                autoComplete={AUTOCOMPLETE[field]}
                onChange={(next) => set(field, next)}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}

const AUTOCOMPLETE: Partial<Record<AddressField, string>> = {
  line1: "address-line1",
  line2: "address-line2",
  dependentLocality: "address-level3",
  locality: "address-level2",
  adminArea: "address-level1",
  postalCode: "postal-code",
  name: "name",
  company: "organization",
};

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  required,
  disabled,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
}) {
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        required={required}
        disabled={disabled}
        autoComplete={autoComplete ?? "off"}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint ? <p id={`${id}-hint`} className="text-body text-muted-foreground">{hint}</p> : null}
      <FieldError id={id} message={error} />
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={`${id}-error`} className="text-body text-destructive">{message}</p> : null;
}

/**
 * Staff only, shown once the API refused the address: keep an address that is
 * right but doesn't follow its country's format (stored marked, Saleor's flag).
 */
export function SkipAddressValidation({ id, checked, onCheckedChange, disabled }: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const t = useMessages(addressMessages);
  return (
    <div className="flex items-start gap-2">
      <span className="flex h-lh items-center">
        <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(next) => onCheckedChange(next === true)}
          aria-describedby={`${id}-help`} />
      </span>
      <div className="grid gap-1">
        <Label htmlFor={id}>{t("skipValidation")}</Label>
        <p id={`${id}-help`} className="text-body text-muted-foreground">{t("skipValidationHelp")}</p>
      </div>
    </div>
  );
}
