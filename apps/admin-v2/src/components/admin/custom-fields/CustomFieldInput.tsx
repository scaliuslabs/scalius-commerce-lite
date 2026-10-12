// One input per custom field type (COMMERCE-HOOKS H4). Every input edits a
// text draft (`custom-field-draft.ts`); list types repeat the item input with
// add and remove. References pick from the catalogue; a SKU reference takes
// its ID.
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getApiV1AdminCollections, getApiV1AdminProducts } from "@scalius/api-client/sdk";
import {
  customFieldItemType,
  customFieldSupportsChoices,
  isCustomFieldListType,
  type CustomFieldType,
  type CustomFieldWireValidations,
} from "@scalius/shared/custom-fields";
import { MediaManager } from "~/components/admin/media-manager";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { DateInput } from "~/components/ui/date-input";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useCurrency } from "~/hooks/use-currency";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { customFieldMessages } from "~/i18n/custom-fields";
import { apiData } from "~/lib/api";
import { collectionsByIdsQueryOptions } from "~/lib/api-query-options/collections";
import { productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import type { CustomFieldDraft } from "./custom-field-draft";

interface ItemProps {
  id: string;
  type: CustomFieldType;
  validations: CustomFieldWireValidations;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  label: string;
}

const loadProducts: SearchableSelectLoader = async ({ search, page, signal }) => {
  const data = await apiData(getApiV1AdminProducts({ query: { view: "compact", page, limit: 20, search: search || undefined } as never, signal }));
  const { products, pagination } = data as unknown as { products: Array<{ id: string; name: string }>; pagination: { page: number; totalPages: number } };
  return {
    options: products.map((product) => ({ value: product.id, label: product.name })),
    hasMore: pagination.page < pagination.totalPages,
  };
};

const loadCollections: SearchableSelectLoader = async ({ search, page, signal }) => {
  const data = await apiData(getApiV1AdminCollections({ query: { page, limit: 20, search: search || undefined }, signal }));
  return {
    options: data.collections.map((collection) => ({ value: collection.id, label: collection.name })),
    hasMore: data.pagination.page < data.pagination.totalPages,
  };
};

function ProductReferenceSelect(props: ItemProps) {
  const t = useMessages(customFieldMessages);
  const canView = usePermissions().hasPermission(PERMISSIONS.PRODUCTS_VIEW);
  const chosen = useQuery({ ...productsByIdsQueryOptions(props.value ? [props.value] : []), enabled: canView && Boolean(props.value) });
  const name = canView && !chosen.isError ? chosen.data?.products.find((product) => product.id === props.value)?.name : undefined;
  return (
    <SearchableSelect
      id={props.id}
      value={props.value}
      {...(canView ? { load: loadProducts, queryKey: ["custom-field-products"] } : { options: [] })}
      selectedLabel={name ?? (props.value || undefined)}
      onValueChange={(value) => props.onChange(value)}
      clearable
      disabled={props.disabled}
      placeholder={t("pickProduct")}
      searchPlaceholder={t("searchProducts")}
      emptyMessage={t("noProducts")}
      ariaLabel={props.label}
      aria-invalid={props.invalid || undefined}
      triggerClassName="w-full"
    />
  );
}

function CollectionReferenceSelect(props: ItemProps) {
  const t = useMessages(customFieldMessages);
  const canView = usePermissions().hasPermission(PERMISSIONS.COLLECTIONS_VIEW);
  const chosen = useQuery({ ...collectionsByIdsQueryOptions(props.value ? [props.value] : []), enabled: canView && Boolean(props.value) });
  const name = canView && !chosen.isError ? chosen.data?.collections.find((collection) => collection.id === props.value)?.name : undefined;
  return (
    <SearchableSelect
      id={props.id}
      value={props.value}
      {...(canView ? { load: loadCollections, queryKey: ["custom-field-collections"] } : { options: [] })}
      selectedLabel={name ?? (props.value || undefined)}
      onValueChange={(value) => props.onChange(value)}
      clearable
      disabled={props.disabled}
      placeholder={t("pickCollection")}
      searchPlaceholder={t("searchCollections")}
      emptyMessage={t("noCollections")}
      ariaLabel={props.label}
      aria-invalid={props.invalid || undefined}
      triggerClassName="w-full"
    />
  );
}

function MediaReferenceInput(props: ItemProps) {
  const t = useMessages(customFieldMessages);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.value ? <code className="min-w-0 truncate text-body">{props.value}</code> : (
        <span className="text-body text-muted-foreground">{t("notSet")}</span>
      )}
      {props.disabled ? null : (
        <>
          <MediaManager
            capability="both"
            onSelect={(file) => props.onChange(file.id)}
            trigger={
              <Button id={props.id} type="button" variant="outline" size="sm" aria-describedby={props.describedBy}>
                {props.value ? t("changeFile") : t("chooseFile")}
              </Button>
            }
          />
          {props.value ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => props.onChange("")}>{t("clear")}</Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function ItemInput(props: ItemProps) {
  const t = useMessages(customFieldMessages);
  const { code, symbol } = useCurrency();
  const common = {
    id: props.id,
    disabled: props.disabled,
    "aria-invalid": props.invalid || undefined,
    "aria-describedby": props.describedBy,
  };
  const text = (extra: Record<string, unknown> = {}) => (
    <Input {...common} {...extra} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
  );
  const item = customFieldItemType(props.type);
  if (customFieldSupportsChoices(props.type) && props.validations.choices?.length) {
    return (
      <SearchableSelect
        id={props.id}
        value={props.value}
        options={props.validations.choices.map((choice) => ({ value: choice, label: choice }))}
        onValueChange={(value) => props.onChange(value)}
        clearable
        disabled={props.disabled}
        placeholder={t("notSet")}
        ariaLabel={props.label}
        aria-invalid={props.invalid || undefined}
        triggerClassName="w-full"
      />
    );
  }
  switch (item) {
    case "multi_line_text":
      return <Textarea {...common} rows={3} value={props.value} onChange={(event) => props.onChange(event.target.value)} />;
    case "json":
      return (
        <Textarea
          {...common}
          rows={4}
          spellCheck={false}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      );
    case "integer":
      return text({ inputMode: "numeric", autoComplete: "off" });
    case "decimal":
      return text({ inputMode: "decimal", autoComplete: "off" });
    case "money":
      return (
        <MoneyInput
          {...common}
          currencyCode={code}
          value={props.value.trim() === "" || Number.isNaN(Number(props.value)) ? null : Number(props.value)}
          onValueChange={(value) => props.onChange(value === null ? "" : String(value))}
        />
      );
    case "boolean":
      return (
        <SearchableSelect
          id={props.id}
          value={props.value}
          options={[{ value: "true", label: t("yes") }, { value: "false", label: t("no") }]}
          onValueChange={(value) => props.onChange(value)}
          clearable
          disabled={props.disabled}
          placeholder={t("notSet")}
          ariaLabel={props.label}
          aria-invalid={props.invalid || undefined}
          triggerClassName="w-full"
        />
      );
    case "date":
      return <DateInput {...common} aria-label={props.label} value={props.value} onValueChange={props.onChange} />;
    case "date_time": {
      const [day = "", time = ""] = props.value.split("T");
      return (
        <div role="group" aria-label={props.label} className="space-y-2">
          <DateInput
            {...common}
            aria-label={t("dateOf", { field: props.label })}
            value={day}
            onValueChange={(next) => props.onChange(next ? `${next}T${time}` : "")}
          />
          <Input
            {...common}
            id={`${props.id}-time`}
            type="time"
            step={1}
            aria-label={t("timeOf", { field: props.label })}
            disabled={props.disabled || !day}
            value={time}
            onChange={(event) => props.onChange(`${day}T${event.target.value}`)}
          />
        </div>
      );
    }
    case "url":
      return text({ type: "url", inputMode: "url", autoComplete: "off", spellCheck: false });
    case "color":
      return (
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-9 shrink-0 rounded-lg border bg-(--swatch)"
            style={{ "--swatch": /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(props.value.trim()) ? props.value.trim() : "transparent" } as CSSProperties}
          />
          {text({ placeholder: "#000000", autoComplete: "off", spellCheck: false })}
        </div>
      );
    case "product_reference":
      return <ProductReferenceSelect {...props} />;
    case "collection_reference":
      return <CollectionReferenceSelect {...props} />;
    case "media_reference":
      return <MediaReferenceInput {...props} />;
    case "variant_reference":
      return text({ placeholder: t("idPlaceholder"), autoComplete: "off", spellCheck: false });
    default:
      return text({ autoComplete: "off" });
  }
}

/** The field's input, a repeated item input for list types. */
export function CustomFieldInput({ id, type, validations, draft, onChange, disabled, invalid, describedBy, label }: {
  id: string;
  type: CustomFieldType;
  validations: CustomFieldWireValidations;
  draft: CustomFieldDraft;
  onChange: (draft: CustomFieldDraft) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  label: string;
}) {
  const t = useMessages(customFieldMessages);
  if (!isCustomFieldListType(type)) {
    return (
      <ItemInput
        id={id}
        type={type}
        validations={validations}
        value={typeof draft === "string" ? draft : ""}
        onChange={onChange}
        disabled={disabled}
        invalid={invalid}
        describedBy={describedBy}
        label={label}
      />
    );
  }
  const items = Array.isArray(draft) && draft.length > 0 ? draft : [""];
  const setItem = (index: number, value: string) => onChange(items.map((item, position) => (position === index ? value : item)));
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        // Items have no identity of their own: the position is the item.
        <div key={index} className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <ItemInput
              id={index === 0 ? id : `${id}-${index}`}
              type={type}
              validations={validations}
              value={item}
              onChange={(value) => setItem(index, value)}
              disabled={disabled}
              invalid={invalid}
              describedBy={describedBy}
              label={`${label} ${index + 1}`}
            />
          </div>
          {disabled || items.length === 1 ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("removeItem", { index: index + 1 })}
              onClick={() => onChange(items.filter((_, position) => position !== index))}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
      ))}
      {disabled ? null : (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, ""])}>
          <Plus aria-hidden="true" />
          {t("addItem")}
        </Button>
      )}
    </div>
  );
}
