// Add or edit one custom field definition (Settings › Custom data). The key,
// type and owner are fixed once created; an edit is guarded by the revision
// the dialog opened with. Validations are checked with the shared codec.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import {
  CUSTOM_FIELD_MERCHANT_NAMESPACE,
  CUSTOM_FIELD_SCALAR_TYPES,
  customFieldBoundKind,
  customFieldOwnerIsStorefront,
  customFieldMoneyFromMajor,
  customFieldMoneyMajorText,
  customFieldSupportsChoices,
  customFieldSupportsRegex,
  isCustomFieldKey,
  isCustomFieldListType,
  customFieldItemType,
  isCustomFieldType,
  normalizeCustomFieldKey,
  parseCustomFieldValidations,
  type CustomFieldOwnerType,
  type CustomFieldScalarType,
  type CustomFieldType,
  type CustomFieldValidationSetting,
  type CustomFieldWireValidations,
} from "@scalius/shared/custom-fields";
import { sameFormValue } from "~/lib/form-values";
import { DEFAULT_CURRENCY, getDecimalPlaces } from "@scalius/shared/currency";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { customFieldMessages, type CustomFieldMessageKey } from "~/i18n/custom-fields";
import { isAdminApiConflictError, readAdminApiErrorCode } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import {
  customFieldDefinitionsQueryOptions,
  useSaveCustomFieldDefinition,
  type CustomFieldDefinition,
} from "~/lib/api-query-options/custom-fields";
import { localDateTime } from "~/components/admin/custom-fields/custom-field-draft";
import { Field, ChoiceField } from "~/components/ui/field";

/** Scalar types with a list form (all but true/false and JSON). */
const LISTABLE = new Set<string>(CUSTOM_FIELD_SCALAR_TYPES.filter((type) => type !== "boolean" && type !== "json"));

/** What the merchant sees and can change; dirty compares exactly this. */
interface Draft {
  name: string;
  key: string;
  description: string;
  itemType: CustomFieldScalarType;
  list: boolean;
  storefrontVisible: boolean;
  min: string;
  max: string;
  regex: string;
  choices: string;
  to: string;
}

type Errors = Partial<Record<"name" | "key" | CustomFieldValidationSetting, string>>;

/** Where each problem is fixed, in the order the form shows them (the first one gets focus). */
const ERROR_TARGETS: ReadonlyArray<[keyof Errors, string]> = [
  ["name", "custom-field-definition-name"],
  ["key", "custom-field-definition-key"],
  ["to", "custom-field-definition-to"],
  ["min", "custom-field-definition-min"],
  ["range", "custom-field-definition-min"],
  ["max", "custom-field-definition-max"],
  ["regex", "custom-field-definition-regex"],
  ["choices", "custom-field-definition-choices"],
  ["validations", "custom-field-definition-validations"],
];

/** Money context: bounds cross the API in minor units and are typed in major units. */
type BoundContext = { decimalPlaces: number; currencyCode: string };

function boundDraft(type: CustomFieldType, value: string | number | null | undefined, context: BoundContext): string {
  if (value === null || value === undefined) return "";
  if (customFieldItemType(type) === "money") return customFieldMoneyMajorText({ amountMinor: Number(value), currency: context.currencyCode }, context);
  return customFieldItemType(type) === "date_time" && typeof value === "string" ? localDateTime(value) : String(value);
}

function draftOf(definition: CustomFieldDefinition | null, context: BoundContext): Draft {
  return {
    name: definition?.name ?? "",
    key: definition?.key ?? "",
    description: definition?.description ?? "",
    itemType: definition ? customFieldItemType(definition.type) : "single_line_text",
    list: definition ? isCustomFieldListType(definition.type) : false,
    storefrontVisible: definition?.storefrontVisible ?? false,
    min: definition ? boundDraft(definition.type, definition.validations.min, context) : "",
    max: definition ? boundDraft(definition.type, definition.validations.max, context) : "",
    regex: definition?.validations.regex ?? "",
    choices: definition?.validations.choices?.join("\n") ?? "",
    to: definition?.validations.to ?? "",
  };
}

function typeOf(draft: Draft): CustomFieldType {
  const listed = `list.${draft.itemType}`;
  return draft.list && isCustomFieldType(listed) ? listed : draft.itemType;
}

/** The wire validations of a draft (bounds as typed; date-times from local time; money to minor units). */
function validationsOf(draft: Draft, context: BoundContext): CustomFieldWireValidations {
  const type = typeOf(draft);
  const bound = (text: string) => {
    const value = text.trim();
    if (!value) return null;
    // An unreadable amount is sent as typed, so the codec refuses it.
    if (customFieldItemType(type) === "money") return customFieldMoneyFromMajor(value, context)?.amountMinor ?? value;
    if (customFieldItemType(type) === "date_time") {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }
    return value;
  };
  const kind = customFieldBoundKind(type);
  const choices = draft.choices.split("\n").map((choice) => choice.trim()).filter(Boolean);
  return {
    min: kind ? bound(draft.min) : null,
    max: kind ? bound(draft.max) : null,
    regex: customFieldSupportsRegex(type) && draft.regex.trim() ? draft.regex.trim() : null,
    choices: customFieldSupportsChoices(type) && choices.length > 0 ? choices : null,
    ...(draft.itemType === "object_reference" ? { to: draft.to.trim() } : {}),
  };
}

const RANGE_ERROR_ID = "custom-field-definition-range-error";

export function CustomFieldDefinitionDialog({ ownerType, definition, open, onOpenChange }: {
  ownerType: CustomFieldOwnerType;
  /** null adds a field. */
  definition: CustomFieldDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(customFieldMessages);
  const currencyCode = useCurrency().code ?? DEFAULT_CURRENCY.code;
  const context = useMemo(() => ({ decimalPlaces: getDecimalPlaces(currencyCode), currencyCode }), [currencyCode]);
  const [draft, setDraft] = useState<Draft>(() => draftOf(definition, context));
  // The key follows the name until the merchant types their own (clearing it follows the name again).
  // Editing history, not content: it never makes the dialog dirty.
  const [keyEdited, setKeyEdited] = useState(definition !== null);
  const [errors, setErrors] = useState<Errors>({});
  const save = useSaveCustomFieldDefinition();
  const reset = save.reset;
  const queryClient = useQueryClient();
  // Keys this dialog has sent a create for since it opened.
  const sentKeys = useRef(new Set<string>());

  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(definition, context));
    setKeyEdited(definition !== null);
    setErrors({});
    sentKeys.current = new Set();
    reset();
  }, [open, definition, reset, context]);

  const dirty = !sameFormValue(draft, draftOf(definition, context));
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy: save.isPending, onClose: () => onOpenChange(false) });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === "name" && !keyEdited) next.key = normalizeCustomFieldKey(String(value)) ?? "";
      return next;
    });
    setErrors({});
  };

  const type = typeOf(draft);
  const boundKind = customFieldBoundKind(type);

  /** What to change, said beside the setting the shared codec refused. */
  const settingProblem = (setting: CustomFieldValidationSetting): string => {
    switch (setting) {
      case "range": return t("setting.range");
      case "min":
      case "max":
        return boundKind === "length"
          ? t("setting.boundLength")
          : t("setting.boundValue", { type: t(`type.${customFieldItemType(type)}` as CustomFieldMessageKey) });
      case "regex": return t("setting.regex");
      case "choices": return t("setting.choices");
      case "to": return t("setting.to");
      default: return t("issue.invalid_validation");
    }
  };
  const storefrontAllowed = customFieldOwnerIsStorefront(ownerType);
  const creating = definition === null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: Errors = {};
    const name = draft.name.trim();
    if (!name) found.name = t("nameRequired");
    if (creating && !isCustomFieldKey(draft.key.trim())) found.key = t("keyInvalid");
    const validations = validationsOf(draft, context);
    const checked = parseCustomFieldValidations(type, validations, context);
    if (!checked.ok) {
      const setting = checked.issue.validation ?? "validations";
      found[setting] = settingProblem(setting);
    }
    if (Object.keys(found).length > 0) {
      setErrors(found);
      const first = ERROR_TARGETS.find(([field]) => found[field]);
      if (first) document.getElementById(first[1])?.focus();
      return;
    }
    const description = draft.description.trim() || null;
    const onSuccess = () => {
      toast.success(t(creating ? "created" : "saved"));
      onOpenChange(false);
    };
    if (creating) {
      const body = {
        ownerType,
        name,
        key: draft.key.trim(),
        description,
        type,
        validations,
        storefrontVisible: storefrontAllowed && draft.storefrontVisible,
      };
      if (save.isPending) return;
      const sentBefore = sentKeys.current.has(body.key);
      sentKeys.current.add(body.key);
      save.mutate({ id: null, body }, {
        onSuccess,
        onError: async (error) => {
          // This dialog's own earlier create (its answer lost) made the field: that is a success.
          if (!sentBefore || readAdminApiErrorCode(error) !== "custom_field_key_taken" || !await createdAlready(body)) return;
          save.reset();
          onSuccess();
        },
      });
    } else {
      save.mutate({
        id: definition.id,
        body: {
          expectedRevision: definition.revision,
          name,
          description,
          validations,
          ...(storefrontAllowed ? { storefrontVisible: draft.storefrontVisible } : {}),
        },
      }, { onSuccess });
    }
  };

  /** Whether the field this dialog asked for exists now, as asked (key, type and name). */
  const createdAlready = async (body: { ownerType: CustomFieldOwnerType; key: string; type: CustomFieldType; name: string }) => {
    try {
      const { definitions } = await queryClient.fetchQuery({ ...customFieldDefinitionsQueryOptions(), staleTime: 0 });
      return definitions.some((field) => field.ownerType === body.ownerType && field.namespace === CUSTOM_FIELD_MERCHANT_NAMESPACE
        && field.key === body.key && field.type === body.type && field.name === body.name);
    } catch {
      return false;
    }
  };

  const keyTaken = save.error !== null && readAdminApiErrorCode(save.error) === "custom_field_key_taken";
  const serverError = save.error && !keyTaken
    ? readAdminApiErrorCode(save.error) === "custom_field_in_theme" ? t("inTheme")
      : isAdminApiConflictError(save.error) ? t("conflict") : getServerFnError(save.error, t("saveFailed"))
    : null;
  const keyError = errors.key ?? (keyTaken ? t("keyTaken") : undefined);
  const binding = `${definition?.namespace ?? CUSTOM_FIELD_MERCHANT_NAMESPACE}.${draft.key || "key"}`;
  const boundInput = (side: "min" | "max") => {
    const id = `custom-field-definition-${side}`;
    const label = boundKind === "length" ? (side === "min" ? "minLength" : "maxLength") : (side === "min" ? "minValue" : "maxValue");
    const item = customFieldItemType(type);
    const inputType = boundKind === "length" ? "text" : item === "date" ? "date" : item === "date_time" ? "datetime-local" : "text";
    return (
      <Field id={id} label={t(label)} error={errors[side]}>
        <Input
          id={id}
          type={inputType}
          inputMode={boundKind === "length" || item === "integer" ? "numeric" : item === "decimal" || item === "money" ? "decimal" : undefined}
          value={draft[side]}
          aria-invalid={errors[side] || errors.range ? true : undefined}
          aria-describedby={errors.range ? RANGE_ERROR_ID : undefined}
          onChange={(event) => set(side, event.target.value)}
        />
      </Field>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="sm:max-w-160">
          <DialogHeader>
            <DialogTitle>{creating ? t("addTitle", { owner: t(`ownerOne.${ownerType}` as CustomFieldMessageKey) }) : t("editTitle")}</DialogTitle>
          </DialogHeader>
          <form id="custom-field-definition-form" method="post" noValidate className="space-y-4" onSubmit={submit}>
            {serverError ? <Alert variant="destructive"><AlertDescription>{serverError}</AlertDescription></Alert> : null}
            <Field id="custom-field-definition-name" label={t("name")} error={errors.name ? errors.name : undefined}>
              <Input
                id="custom-field-definition-name"
                value={draft.name}
                maxLength={80}
                onChange={(event) => set("name", event.target.value)}
              />
            </Field>
            <Field id="custom-field-definition-key" label={t("key")}>
              <Input
                id="custom-field-definition-key"
                value={draft.key}
                maxLength={64}
                disabled={!creating}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={keyError ? true : undefined}
                aria-describedby="custom-field-definition-key-note"
                onChange={(event) => {
                  setDraft((current) => ({ ...current, key: event.target.value }));
                  setKeyEdited(event.target.value !== "");
                  setErrors({});
                }}
              />
              <p id="custom-field-definition-key-note" className={keyError ? "text-body text-destructive" : "text-body text-muted-foreground"}>
                {keyError ?? t("keyHelp", { binding })}
              </p>
            </Field>
            <Field id="custom-field-definition-description" label={t("fieldDescription")}>
              <Input
                id="custom-field-definition-description"
                value={draft.description}
                maxLength={300}
                onChange={(event) => set("description", event.target.value)}
              />
            </Field>
            <Field id="custom-field-definition-type" label={t("type")} help={creating ? undefined : t("typeFixed")}>
              <SearchableSelect
                id="custom-field-definition-type"
                triggerClassName="w-full"
                value={draft.itemType}
                disabled={!creating}
                onValueChange={(value) => {
                  const next = CUSTOM_FIELD_SCALAR_TYPES.find((item) => item === value);
                  if (!next) return;
                  setDraft((current) => ({ ...current, itemType: next, list: LISTABLE.has(next) && current.list, min: "", max: "", regex: "", choices: "", to: "" }));
                  setErrors({});
                }}
                options={CUSTOM_FIELD_SCALAR_TYPES.map((item) => ({ value: item, label: t(`type.${item}` as CustomFieldMessageKey) }))}
              />
            </Field>
            {LISTABLE.has(draft.itemType) ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="custom-field-definition-list"
                  checked={draft.list}
                  disabled={!creating}
                  onCheckedChange={(value) => set("list", value === true)}
                />
                <Label htmlFor="custom-field-definition-list">{t("list")}</Label>
              </div>
            ) : null}
            {draft.itemType === "object_reference" ? (
              <Field id="custom-field-definition-to" label={t("objectTarget")} help={t("objectTargetHelp")} error={errors.to}>
                <Input
                  id="custom-field-definition-to"
                  value={draft.to}
                  maxLength={150}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => set("to", event.target.value)}
                />
              </Field>
            ) : null}
            <ChoiceField
              id="custom-field-definition-storefront"
              label={t("storefrontVisible")}
              help={storefrontAllowed ? t("storefrontHelp") : t("storefrontNever")}
              control={(
              <Checkbox
                id="custom-field-definition-storefront"
                checked={storefrontAllowed && draft.storefrontVisible}
                disabled={!storefrontAllowed}
                aria-describedby="custom-field-definition-storefront-help"
                onCheckedChange={(value) => set("storefrontVisible", value === true)}
              />
              )}
            />
            {boundKind || customFieldSupportsRegex(type) || customFieldSupportsChoices(type) ? (
              <fieldset className="space-y-4 border-t pt-4">
                <legend className="sr-only">{t("validations")}</legend>
                <h3 className="text-heading-sm">{t("validations")}</h3>
                {boundKind ? (
                  <div className="space-y-1">
                    <div className="grid gap-4 sm:grid-cols-2">
                      {boundInput("min")}
                      {boundInput("max")}
                    </div>
                    {errors.range ? <p id={RANGE_ERROR_ID} className="text-body text-destructive">{errors.range}</p> : null}
                  </div>
                ) : null}
                {customFieldSupportsRegex(type) ? (
                  <Field id="custom-field-definition-regex" label={t("regex")} help={t("regexHelp")} error={errors.regex}>
                    <Input
                      id="custom-field-definition-regex"
                      value={draft.regex}
                      maxLength={200}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => set("regex", event.target.value)}
                    />
                  </Field>
                ) : null}
                {customFieldSupportsChoices(type) ? (
                  <Field id="custom-field-definition-choices" label={t("choices")} help={t("choicesHelp")} error={errors.choices}>
                    <Textarea
                      id="custom-field-definition-choices"
                      rows={3}
                      value={draft.choices}
                      onChange={(event) => set("choices", event.target.value)}
                    />
                  </Field>
                ) : null}
              </fieldset>
            ) : null}
            {errors.validations ? (
              <p id="custom-field-definition-validations" tabIndex={-1} className="text-body text-destructive">{errors.validations}</p>
            ) : null}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={requestClose}>{t("cancel")}</Button>
            <Button type="submit" form="custom-field-definition-form" loading={save.isPending}>{t(creating ? "create" : "save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}
