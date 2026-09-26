import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import { postApiV1AdminAttributes, putApiV1AdminAttributesById } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { SearchableSelect } from "~/components/ui/searchable-select";
import {
  ATTRIBUTE_FACET_DISPLAYS,
  ATTRIBUTE_UNIT_MAX_LENGTH,
  ATTRIBUTE_VALUE_TYPES,
  defaultAttributeFacetDisplay,
  isAttributeFacetDisplayAllowed,
  type AttributeFacetDisplay,
  type AttributeValueType,
} from "@scalius/shared/catalog-attributes";
import { ConvertTypeDialog } from "./ConvertTypeDialog";
import { autoHandleFor } from "~/components/admin/search-listing/SearchListingCard";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { apiData } from "~/lib/api";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { queryKeys } from "~/lib/query-keys";
import { attributeGroupsQueryOptions, type AttributeDto } from "~/lib/api-query-options/attributes";
import { useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";
import { attributeTypeMessages } from "~/i18n/attribute-types";

const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** While typing a handle: lowercase, spaces become dashes, nothing else outside a-z, 0-9 and "-". */
const typedHandle = (text: string) => text.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

interface AttributeDialogProps {
  open: boolean;
  /** Attribute to edit; omit to create one. */
  attribute?: AttributeDto;
  onClose: () => void;
}

/**
 * Create or edit an attribute: name, handle, filter switch and preset values.
 * Fields are checked when the merchant leaves them or presses Save, never while typing.
 */
export function AttributeDialog({ open, attribute, onClose }: AttributeDialogProps) {
  const t = useMessages(catalogMessages);
  const a = useMessages(attributeTypeMessages);
  const queryClient = useQueryClient();
  const { data: groupData } = useQuery({ ...attributeGroupsQueryOptions(), enabled: open });
  const [valueType, setValueType] = useState<AttributeValueType>(attribute?.valueType ?? "text");
  const [groupId, setGroupId] = useState<string | null>(attribute?.groupId ?? null);
  const [unit, setUnit] = useState(attribute?.unit ?? "");
  const [facetDisplay, setFacetDisplay] = useState<AttributeFacetDisplay>(attribute?.facetDisplay ?? "checkbox");
  const [keySpec, setKeySpec] = useState(attribute?.keySpec ?? false);
  const [highlight, setHighlight] = useState(attribute?.highlight ?? false);
  const [converting, setConverting] = useState(false);
  // What is saved: a type change is saved by its own dialog.
  const [saved, setSaved] = useState({
    valueType: attribute?.valueType ?? "text",
    unit: attribute?.unit ?? "",
    facetDisplay: attribute?.facetDisplay ?? "checkbox",
  });
  const hasPresets = valueType === "text" || valueType === "enum";
  const [name, setName] = useState(attribute?.name ?? "");
  const [slug, setSlug] = useState(attribute?.slug ?? "");
  const [filterable, setFilterable] = useState(attribute?.filterable ?? true);
  const [options, setOptions] = useState<string[]>(attribute?.options ?? []);
  const [draftValue, setDraftValue] = useState("");
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [checked, setChecked] = useState({ name: false, slug: false });
  const [serverError, setServerError] = useState<{ field: "slug" | "form"; message: string } | null>(null);

  // A new attribute left without a handle gets one made from its name on the server.
  const autoHandle = attribute || slug ? undefined : autoHandleFor(name, "attribute");
  const slugInvalid = autoHandle === undefined && (slug.length < 2 || !HANDLE.test(slug));
  const errors = {
    name: checked.name && name.trim().length < 2 ? t("nameTooShort") : null,
    slug: serverError?.field === "slug"
      ? serverError.message
      : checked.slug && slugInvalid ? t("handleInvalid") : null,
  };

  const save = useMutation({
    mutationFn: () => {
      // Presets are also edited in the values editor: resend them only when changed here.
      const optionsChanged = options.join("\u0000") !== (attribute?.options ?? []).join("\u0000");
      const typed = {
        groupId,
        unit: valueType === "number" ? unit.trim() || null : null,
        facetDisplay,
        keySpec,
        highlight,
      };
      const body = { name: name.trim(), slug, filterable, ...typed, ...(optionsChanged && hasPresets ? { options } : {}) };
      return attribute
        ? apiData(putApiV1AdminAttributesById({ path: { id: attribute.id }, body }))
        : apiData(postApiV1AdminAttributes({ body: { ...body, valueType, slug: slug || undefined } }));
    },
    onSuccess: () => {
      toast.success(t("saved"));
      onClose();
    },
    onError: (error) => {
      if (!isAdminApiConflictError(error)) {
        setServerError({ field: "form", message: t("saveFailed") });
      } else {
        const inTrash = error instanceof Error && /deleted attribute/i.test(error.message);
        setServerError({ field: "slug", message: t(inTrash ? "attributeInTrash" : "attributeTaken") });
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.attributes.all }),
  });

  const dirty =
    name !== (attribute?.name ?? "") ||
    slug !== (attribute?.slug ?? "") ||
    filterable !== (attribute?.filterable ?? true) ||
    valueType !== saved.valueType ||
    groupId !== (attribute?.groupId ?? null) ||
    unit !== saved.unit ||
    facetDisplay !== saved.facetDisplay ||
    keySpec !== (attribute?.keySpec ?? false) ||
    highlight !== (attribute?.highlight ?? false) ||
    options.join("\u0000") !== (attribute?.options ?? []).join("\u0000") ||
    draftValue.trim() !== "";
  // Esc, an outside click or Cancel with unsaved edits asks first.
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy: save.isPending, onClose });

  const addValue = () => {
    const value = draftValue.trim();
    if (!value) return;
    const existing = options.find((option) => option.toLowerCase() === value.toLowerCase());
    if (existing) {
      setDuplicate(existing);
      return;
    }
    setOptions([...options, value]);
    setDraftValue("");
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && requestClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{attribute ? t("editAttribute") : t("addAttribute")}</DialogTitle>
          </DialogHeader>
          <form
            id="attribute-form"
            method="post"
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setChecked({ name: true, slug: true });
              setServerError(null);
              if (name.trim().length < 2 || slugInvalid || save.isPending) return;
              save.mutate();
            }}
          >
            {serverError?.field === "form" ? (
              <p role="alert" className="text-body text-destructive">{serverError.message}</p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="attribute-name">{t("name")}</Label>
                <Input
                  id="attribute-name"
                  autoFocus
                  maxLength={100}
                  placeholder={t("namePlaceholder")}
                  value={name}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "attribute-name-error" : undefined}
                  onBlur={() => setChecked((current) => ({ ...current, name: true }))}
                  onChange={(event) => setName(event.target.value)}
                />
                {errors.name ? <p id="attribute-name-error" className="text-body text-destructive">{errors.name}</p> : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="attribute-handle">{t("handle")}</Label>
                <Input
                  id="attribute-handle"
                  maxLength={100}
                  inputMode="url"
                  autoCapitalize="none"
                  placeholder={autoHandle || t("handlePlaceholder")}
                  value={slug}
                  aria-invalid={Boolean(errors.slug)}
                  aria-describedby="attribute-handle-help"
                  onBlur={() => setChecked((current) => ({ ...current, slug: true }))}
                  onChange={(event) => {
                    setServerError(null);
                    setSlug(typedHandle(event.target.value));
                  }}
                />
                <p id="attribute-handle-help" className={errors.slug ? "text-body text-destructive" : "text-body text-muted-foreground"}>
                  {errors.slug ?? t(autoHandle === undefined ? "handleHelp" : "handleAuto")}
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="attribute-type">{a("type")}</Label>
                {attribute ? (
                  <div className="flex items-center gap-2">
                    <p id="attribute-type" className="min-w-0 flex-1 text-body">{a(`type_${valueType}`)}</p>
                    <Button type="button" variant="outline" onClick={() => setConverting(true)}>{a("changeType")}</Button>
                  </div>
                ) : (
                  <SearchableSelect
                    id="attribute-type"
                    value={valueType}
                    onValueChange={(value) => {
                      const next = value as AttributeValueType;
                      setValueType(next);
                      if (!isAttributeFacetDisplayAllowed(next, facetDisplay)) setFacetDisplay(defaultAttributeFacetDisplay(next));
                    }}
                    triggerClassName="w-full"
                    options={ATTRIBUTE_VALUE_TYPES.map((type) => ({ value: type, label: a(`type_${type}`) }))}
                  />
                )}
                <p className="text-body text-muted-foreground">{a(`typeHelp_${valueType}`)}</p>
              </div>
              {valueType === "number" ? (
                <div className="space-y-2">
                  <Label htmlFor="attribute-unit">{a("unit")}</Label>
                  <Input
                    id="attribute-unit"
                    maxLength={ATTRIBUTE_UNIT_MAX_LENGTH}
                    placeholder={a("unitPlaceholder")}
                    value={unit}
                    onChange={(event) => setUnit(event.target.value)}
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="attribute-group">{a("group")}</Label>
                <SearchableSelect
                  id="attribute-group" value={groupId ?? ""} onValueChange={(value) => setGroupId(value || null)}
                  triggerClassName="w-full"
                  options={[
                    { value: "", label: a("noGroup") },
                    ...(groupData?.groups ?? []).map((group) => ({ value: group.id, label: group.name })),
                    ...(groupId && groupData && !groupData.groups.some((group) => group.id === groupId) ? [{ value: groupId, label: groupId }] : []),
                  ]}
                />
                <p className="text-body text-muted-foreground">{a("groupHelp")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="attribute-display">{a("filterDisplay")}</Label>
                <SearchableSelect
                  id="attribute-display" value={facetDisplay} onValueChange={(value) => setFacetDisplay(value as AttributeFacetDisplay)}
                  triggerClassName="w-full"
                  options={ATTRIBUTE_FACET_DISPLAYS.filter((display) => isAttributeFacetDisplayAllowed(valueType, display)).map((display) => ({ value: display, label: a(`display_${display}`) }))}
                />
              </div>
            </div>
            {hasPresets ? (
            <div className="space-y-2">
              <Label htmlFor="attribute-value">{t("presetValues")}</Label>
              <div className="flex gap-2">
                <Input
                  id="attribute-value"
                  maxLength={100}
                  value={draftValue}
                  aria-describedby="attribute-value-help"
                  onChange={(event) => {
                    setDraftValue(event.target.value);
                    setDuplicate(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addValue();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={addValue} disabled={!draftValue.trim()}>
                  {t("addValue")}
                </Button>
              </div>
              <p id="attribute-value-help" className="text-body text-muted-foreground">
                {duplicate ? t("valueAlreadyAdded", { value: duplicate }) : t("presetValuesHint")}
              </p>
              {options.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {options.map((option) => (
                    <Badge key={option} variant="secondary">
                      {option}
                      <button
                        type="button"
                        onClick={() => setOptions(options.filter((item) => item !== option))}
                        aria-label={t("removeValue", { value: option })}
                        className="ml-1 rounded-full"
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
            ) : null}
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="attribute-key-spec">{a("keySpec")}</Label>
                <p className="text-body text-muted-foreground">{a("keySpecHelp")}</p>
              </div>
              <Switch id="attribute-key-spec" checked={keySpec} onCheckedChange={setKeySpec} />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="attribute-highlight">{a("highlight")}</Label>
                <p className="text-body text-muted-foreground">{a("highlightHelp")}</p>
              </div>
              <Switch id="attribute-highlight" checked={highlight} onCheckedChange={setHighlight} />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="attribute-filterable">{t("filterableYes")}</Label>
                <p className="text-body text-muted-foreground">{t("filterableHint")}</p>
              </div>
              <Switch id="attribute-filterable" checked={filterable} onCheckedChange={setFilterable} />
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={requestClose} disabled={save.isPending}>
              {t("cancel")}
            </Button>
            <Button type="submit" form="attribute-form" loading={save.isPending}>
              {attribute ? t("save") : t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
      {attribute ? (
        <ConvertTypeDialog
          attribute={attribute}
          open={converting}
          onClose={() => setConverting(false)}
          onConverted={(next, convertedUnit) => {
            // The server switched the type (and its filter style): the dialog follows it.
            const nextUnit = convertedUnit ?? "";
            setValueType(next);
            setFacetDisplay(defaultAttributeFacetDisplay(next));
            setUnit(nextUnit);
            setSaved({ valueType: next, unit: nextUnit, facetDisplay: defaultAttributeFacetDisplay(next) });
          }}
        />
      ) : null}
    </>
  );
}
