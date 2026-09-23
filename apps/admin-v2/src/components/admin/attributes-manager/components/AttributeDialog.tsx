import { useState } from "react";
import { X } from "lucide-react";
import { postApiV1AdminAttributes, putApiV1AdminAttributesById } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { useResourceMutation } from "~/components/admin/resource/ResourceListPage";
import type { AttributeDto } from "~/lib/api-query-options/attributes";
import { useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";

const toHandle = (name: string) => name.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

interface AttributeDialogProps {
  open: boolean;
  /** Attribute to edit; omit to create one. */
  attribute?: AttributeDto;
  onClose: () => void;
}

/** Create or edit an attribute: name, handle, filter switch and preset values. */
export function AttributeDialog({ open, attribute, onClose }: AttributeDialogProps) {
  const t = useMessages(catalogMessages);
  const [name, setName] = useState(attribute?.name ?? "");
  const [slug, setSlug] = useState(attribute?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(Boolean(attribute));
  const [filterable, setFilterable] = useState(attribute?.filterable ?? true);
  const [options, setOptions] = useState<string[]>(attribute?.options ?? []);
  const [draftValue, setDraftValue] = useState("");
  const save = useResourceMutation(
    () => {
      // Presets are also edited in the values editor: resend them only when changed here.
      const optionsChanged = options.join("\u0000") !== (attribute?.options ?? []).join("\u0000");
      const body = { name: name.trim(), slug: slug.trim(), filterable, ...(optionsChanged ? { options } : {}) };
      return attribute
        ? apiData(putApiV1AdminAttributesById({ path: { id: attribute.id }, body }))
        : apiData(postApiV1AdminAttributes({ body }));
    },
    [queryKeys.attributes.all],
  );

  const addValue = () => {
    const value = draftValue.trim();
    if (value && !options.some((option) => option.toLowerCase() === value.toLowerCase())) {
      setOptions([...options, value]);
    }
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
            save.mutate({ variables: undefined, success: t(attribute ? "saved" : "created") }, { onSuccess: onClose });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="attribute-name">{t("name")}</Label>
              <Input
                id="attribute-name"
                required
                autoFocus
                placeholder={t("namePlaceholder")}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!slugEdited) setSlug(toHandle(event.target.value));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="attribute-handle">{t("handle")}</Label>
              <Input
                id="attribute-handle"
                required
                value={slug}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(toHandle(event.target.value));
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="attribute-value">{t("presetValues")}</Label>
            <div className="flex gap-2">
              <Input
                id="attribute-value"
                value={draftValue}
                onChange={(event) => setDraftValue(event.target.value)}
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
            <p className="text-body text-muted-foreground">{t("presetValuesHint")}</p>
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
                      <X className="h-3 w-3" />
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
          <Button type="submit" form="attribute-form" disabled={save.isPending || !name.trim() || !slug.trim()}>
            {attribute ? t("save") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
