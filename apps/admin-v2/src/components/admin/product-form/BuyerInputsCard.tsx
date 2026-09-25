import React from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { CUSTOMIZATION_LIMITS } from "@scalius/shared/line-properties";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrency } from "@/hooks/use-currency";
import { LinePropertyFields } from "@/components/admin/order-form/LinePropertyFields";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { BuyerInputDialog } from "./BuyerInputDialog";
import {
  emptyBuyerInput,
  moveBuyerInput,
  schemaFromDrafts,
  type BuyerInputDraft,
} from "./buyer-inputs";
import type { ProductFormValues } from "./types";

const TYPE_LABELS = {
  text: "inputType.text",
  textarea: "inputType.textarea",
  select: "inputType.select",
  checkbox: "inputType.checkbox",
} as const;

/**
 * "Buyer inputs" (Etsy's personalization, with Shopify-style priced choices):
 * what the product page asks before Add to cart. The list reorders with the
 * arrow buttons; each input opens in a dialog; a preview shows the block the
 * buyer will fill. Saved with the product, through its revision.
 */
export function BuyerInputsCard({ form, readOnly = false, savedInvalid = false, conflict = null }: {
  form: UseFormReturn<ProductFormValues>;
  readOnly?: boolean;
  /** The saved inputs couldn't be read: saving here replaces them. */
  savedInvalid?: boolean;
  /** Someone else saved the product while these inputs were being edited. */
  conflict?: { onReview: () => void } | null;
}) {
  const t = useMessages(productMessages);
  const { code, fmt } = useCurrency();
  const watched = useWatch({ control: form.control, name: "customizationSchema" });
  const drafts = React.useMemo(() => watched ?? [], [watched]);
  const [editing, setEditing] = React.useState<{ index: number | null; draft: BuyerInputDraft } | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<Record<string, string>>({});
  const listRef = React.useRef<HTMLUListElement>(null);
  const minorFactor = 10 ** getDecimalPlaces(code);
  const schema = React.useMemo(() => schemaFromDrafts(drafts, minorFactor), [drafts, minorFactor]);
  const full = drafts.length >= CUSTOMIZATION_LIMITS.fields;

  const commit = (next: BuyerInputDraft[]) =>
    form.setValue("customizationSchema", next, { shouldDirty: true, shouldValidate: true });
  const open = (index: number | null) => {
    setEditing({ index, draft: index === null ? emptyBuyerInput() : drafts[index]! });
    setDialogOpen(true);
  };
  const move = (index: number, direction: -1 | 1) => {
    commit(moveBuyerInput(drafts, index, direction));
    // Keep the moved row's button under the keyboard.
    requestAnimationFrame(() => listRef.current
      ?.querySelectorAll<HTMLButtonElement>(`[data-move="${direction}"]`)[index + direction]
      ?.focus());
  };
  const priceText = (draft: BuyerInputDraft) => {
    if (draft.type === "select") {
      const prices = draft.options.map((option) => option.price ?? 0).filter((price) => price > 0);
      return prices.length ? t("inputPriceFrom", { amount: fmt(Math.min(...prices)) }) : null;
    }
    return draft.price ? `+${fmt(draft.price)}` : null;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("buyerInputs")}</CardTitle>
        <CardDescription>{t("buyerInputsHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {conflict ? (
          <Alert variant="warning">
            <AlertDescription>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>{t("buyerInputsConflict")}</span>
                <Button type="button" variant="outline" size="sm" onClick={conflict.onReview}>{t("reviewConflict")}</Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
        {savedInvalid ? (
          <Alert variant="warning"><AlertDescription>{t("buyerInputsUnreadable")}</AlertDescription></Alert>
        ) : null}
        {drafts.length > 0 ? (
          <ul ref={listRef} className="divide-y rounded-lg border" aria-label={t("buyerInputs")}>
            {drafts.map((draft, index) => {
              const price = priceText(draft);
              return (
                <li key={draft.key || index} className="flex items-center gap-2 px-3 py-2 text-body">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-words">{draft.label}</span>
                      {draft.required ? <Badge variant="secondary">{t("inputRequiredBadge")}</Badge> : null}
                    </p>
                    <p className="text-muted-foreground">
                      {[
                        t(TYPE_LABELS[draft.type]),
                        draft.type === "select" ? t("inputChoices", { count: draft.options.length }) : null,
                        price,
                      ].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {readOnly ? null : (
                    <div className="flex shrink-0 items-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-move="-1"
                        disabled={index === 0}
                        aria-label={t("moveInputUp", { name: draft.label })}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-move="1"
                        disabled={index === drafts.length - 1}
                        aria-label={t("moveInputDown", { name: draft.label })}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => open(index)}>
                        {t("editInput")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("removeInput", { name: draft.label })}
                        onClick={() => commit(drafts.filter((_, other) => other !== index))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-body text-muted-foreground">{t("buyerInputsEmpty")}</p>
        )}
        {schema ? (
          <section className="space-y-2 border-t pt-4" aria-label={t("buyerInputsPreview")}>
            <h3 className="text-heading-sm">{t("buyerInputsPreview")}</h3>
            <LinePropertyFields
              schema={schema}
              values={preview}
              onChange={(key, value) => setPreview((current) => ({ ...current, [key]: value }))}
              error={null}
              surcharge={(priceMinor) => fmt(priceMinor / minorFactor)}
            />
          </section>
        ) : null}
      </CardContent>
      {readOnly ? null : (
        <CardFooter className="justify-between">
          <p className="text-body text-muted-foreground" aria-live="polite">
            {full ? t("buyerInputsFull", { max: CUSTOMIZATION_LIMITS.fields }) : null}
          </p>
          <Button type="button" variant="outline" disabled={full} onClick={() => open(null)}>
            <Plus className="size-4" />
            {t("addBuyerInput")}
          </Button>
        </CardFooter>
      )}
      <BuyerInputDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing?.draft ?? null}
        others={editing ? drafts.filter((_, index) => index !== editing.index) : []}
        currencyCode={code}
        onSave={(saved) => {
          if (!editing) return;
          commit(editing.index === null
            ? [...drafts, saved]
            : drafts.map((draft, index) => (index === editing.index ? saved : draft)));
          setDialogOpen(false);
        }}
      />
    </Card>
  );
}
