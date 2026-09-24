import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import { postApiV1AdminAttributes, putApiV1AdminAttributesById } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { autoHandleFor } from "~/components/admin/search-listing/SearchListingCard";
import { apiData } from "~/lib/api";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { queryKeys } from "~/lib/query-keys";
import type { AttributeDto } from "~/lib/api-query-options/attributes";
import { useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";

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
  const queryClient = useQueryClient();
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
      const body = { name: name.trim(), slug, filterable, ...(optionsChanged ? { options } : {}) };
      return attribute
        ? apiData(putApiV1AdminAttributesById({ path: { id: attribute.id }, body }))
        : apiData(postApiV1AdminAttributes({ body: { ...body, slug: slug || undefined } }));
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
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && onClose()}>
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
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="attribute-filterable">{t("filterableYes")}</Label>
              <p className="text-body text-muted-foreground">{t("filterableHint")}</p>
            </div>
            <Switch id="attribute-filterable" checked={filterable} onCheckedChange={setFilterable} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t("cancel")}
          </Button>
          <Button type="submit" form="attribute-form" loading={save.isPending}>
            {attribute ? t("save") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
