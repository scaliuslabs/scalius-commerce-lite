import React from "react";
import { Plus, X } from "lucide-react";
import { CUSTOMIZATION_LIMITS } from "@scalius/shared/line-properties";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { NumberInput } from "@/components/ui/number-input";
import { MoneyInput } from "@/components/admin/shared/MoneyInput";
import { useMessages } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import {
  BUYER_INPUT_TYPES,
  buyerInputIssue,
  maxLengthLimit,
  withKeys,
  type BuyerInputDraft,
  type BuyerInputIssue,
} from "./buyer-inputs";

const TYPE_LABELS = {
  text: "inputType.text",
  textarea: "inputType.textarea",
  select: "inputType.select",
  checkbox: "inputType.checkbox",
} as const;

function issueText(issue: BuyerInputIssue, t: (key: ProductMessageKey, vars?: Record<string, string | number>) => string): string {
  switch (issue.field) {
    case "label":
      return issue.reason === "required" ? t("inputLabelRequired") : t("inputTooLong", { max: CUSTOMIZATION_LIMITS.labelLength });
    case "help":
      return t("inputTooLong", { max: CUSTOMIZATION_LIMITS.helpLength });
    case "maxLength":
      return t("inputLimitRange");
    case "price":
      return t("inputPriceNegative");
    case "options":
      return issue.reason === "required" ? t("inputChoicesRequired") : t("inputChoicesTooMany", { max: CUSTOMIZATION_LIMITS.selectOptions });
    case "option":
      return issue.reason === "required" ? t("inputChoiceRequired")
        : issue.reason === "duplicate" ? t("inputChoiceDuplicate")
          : issue.reason === "negative" ? t("inputPriceNegative")
            : t("inputTooLong", { max: CUSTOMIZATION_LIMITS.optionLabelLength });
  }
}

/** Add or change one buyer input: its type, words, limit and price (or priced choices). */
export function BuyerInputDialog({ open, onOpenChange, initial, others, currencyCode, onSave }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The input being edited, or a blank one for Add. */
  initial: BuyerInputDraft | null;
  /** The product's other inputs (their keys stay unique). */
  others: readonly BuyerInputDraft[];
  currencyCode: string;
  onSave: (draft: BuyerInputDraft) => void;
}) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const [draft, setDraft] = React.useState<BuyerInputDraft | null>(initial);
  const [issue, setIssue] = React.useState<BuyerInputIssue | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setIssue(null);
    // Every opening starts from the input as it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (patch: Partial<BuyerInputDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setIssue(null);
  };
  const setOption = (index: number, patch: Partial<BuyerInputDraft["options"][number]>) =>
    update({ options: (draft?.options ?? []).map((option, other) => (other === index ? { ...option, ...patch } : option)) });

  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The page form must not submit from inside the dialog.
    event.stopPropagation();
    if (!draft) return;
    const problem = buyerInputIssue(draft);
    if (problem) {
      setIssue(problem);
      const id = problem.field === "option" ? `buyer-input-option-${problem.index}` : `buyer-input-${problem.field}`;
      document.getElementById(id)?.focus();
      return;
    }
    onSave(withKeys({ ...draft, label: draft.label.trim(), help: draft.help.trim() }, others));
  };

  const errorFor = (field: BuyerInputIssue["field"], index?: number) =>
    issue && issue.field === field && (index === undefined || (issue.field === "option" && issue.index === index))
      ? issueText(issue, t)
      : null;
  const labelError = errorFor("label");
  const text = draft?.type === "text" || draft?.type === "textarea";
  const isNew = !initial?.key;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(isNew ? "addBuyerInput" : "editBuyerInput")}</DialogTitle>
          <DialogDescription>{t("buyerInputDialogHelp")}</DialogDescription>
        </DialogHeader>
        {draft ? (
          <form id="buyer-input-form" method="post" noValidate className="space-y-4" onSubmit={save}>
            <div className="space-y-2">
              <Label htmlFor="buyer-input-type">{t("inputTypeLabel")}</Label>
              <SearchableSelect
                id="buyer-input-type"
                value={draft.type}
                onValueChange={(value) => {
                  const type = BUYER_INPUT_TYPES.find((candidate) => candidate === value) ?? "text";
                  update({
                    type,
                    maxLength: null,
                    options: type === "select" && draft.options.length === 0 ? [{ value: "", label: "", price: null }] : draft.options,
                  });
                }}
                triggerClassName="w-full"
                options={BUYER_INPUT_TYPES.map((type) => ({ value: type, label: t(TYPE_LABELS[type]) }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="buyer-input-label">{t("inputLabel")}</Label>
              <Input
                id="buyer-input-label"
                value={draft.label}
                maxLength={CUSTOMIZATION_LIMITS.labelLength}
                placeholder={t("inputLabelPlaceholder")}
                aria-invalid={Boolean(labelError) || undefined}
                aria-describedby={labelError ? "buyer-input-label-error" : undefined}
                autoComplete="off"
                onChange={(event) => update({ label: event.target.value })}
              />
              {labelError ? <p id="buyer-input-label-error" className="text-body text-destructive">{labelError}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="buyer-input-help">{t("inputHelpText")}</Label>
              <Input
                id="buyer-input-help"
                value={draft.help}
                maxLength={CUSTOMIZATION_LIMITS.helpLength}
                aria-invalid={Boolean(errorFor("help")) || undefined}
                autoComplete="off"
                onChange={(event) => update({ help: event.target.value })}
              />
              {errorFor("help") ? <p className="text-body text-destructive">{errorFor("help")}</p> : null}
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-lh items-center">
                <Checkbox id="buyer-input-required" checked={draft.required} onCheckedChange={(checked) => update({ required: checked === true })} />
              </span>
              <Label htmlFor="buyer-input-required">
                {t(draft.type === "checkbox" ? "inputRequiredCheckbox" : "inputRequired")}
              </Label>
            </div>
            {text || draft.type === "checkbox" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {text ? (
                  <div className="space-y-2">
                    <Label htmlFor="buyer-input-maxLength">{t("inputLimit")}</Label>
                    <NumberInput
                      id="buyer-input-maxLength"
                      integer
                      value={draft.maxLength}
                      placeholder={String(maxLengthLimit(draft.type))}
                      aria-invalid={Boolean(errorFor("maxLength")) || undefined}
                      aria-describedby="buyer-input-maxLength-help"
                      onValueChange={(maxLength) => update({ maxLength })}
                    />
                    <p id="buyer-input-maxLength-help" className={errorFor("maxLength") ? "text-body text-destructive" : "text-body text-muted-foreground"}>
                      {errorFor("maxLength") ?? t("inputLimitHelp", { max: maxLengthLimit(draft.type) })}
                    </p>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="buyer-input-price">{t("inputPrice")}</Label>
                  <MoneyInput
                    id="buyer-input-price"
                    currencyCode={currencyCode}
                    value={draft.price}
                    placeholder="0"
                    aria-invalid={Boolean(errorFor("price")) || undefined}
                    aria-describedby="buyer-input-price-help"
                    onValueChange={(price) => update({ price })}
                  />
                  <p id="buyer-input-price-help" className={errorFor("price") ? "text-body text-destructive" : "text-body text-muted-foreground"}>
                    {errorFor("price") ?? t(draft.type === "checkbox" ? "inputPriceHelpCheckbox" : "inputPriceHelp")}
                  </p>
                </div>
              </div>
            ) : null}
            {draft.type === "select" ? (
              <fieldset className="space-y-2">
                <legend className="text-body font-medium">{t("inputChoicesLabel")}</legend>
                <ul className="space-y-2">
                  {draft.options.map((option, index) => {
                    const error = errorFor("option", index);
                    return (
                      <li key={option.value || `new-${index}`} className="space-y-1">
                        <div className="flex items-start gap-2">
                          <Input
                            id={`buyer-input-option-${index}`}
                            value={option.label}
                            maxLength={CUSTOMIZATION_LIMITS.optionLabelLength}
                            aria-label={t("inputChoiceLabel", { number: index + 1 })}
                            aria-invalid={Boolean(error) || undefined}
                            autoComplete="off"
                            onChange={(event) => setOption(index, { label: event.target.value })}
                          />
                          <MoneyInput
                            className="w-28 shrink-0"
                            currencyCode={currencyCode}
                            value={option.price}
                            placeholder="0"
                            aria-label={t("inputChoicePrice", { number: index + 1 })}
                            onValueChange={(price) => setOption(index, { price })}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            aria-label={t("removeChoice", { number: index + 1 })}
                            onClick={() => update({ options: draft.options.filter((_, other) => other !== index) })}
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                        {error ? <p className="text-body text-destructive">{error}</p> : null}
                      </li>
                    );
                  })}
                </ul>
                {errorFor("options") ? <p id="buyer-input-options" tabIndex={-1} className="text-body text-destructive">{errorFor("options")}</p> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={draft.options.length >= CUSTOMIZATION_LIMITS.selectOptions}
                  onClick={() => update({ options: [...draft.options, { value: "", label: "", price: null }] })}
                >
                  <Plus className="size-4" />
                  {t("addChoice")}
                </Button>
              </fieldset>
            ) : null}
          </form>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{r("cancel")}</Button>
          <Button type="submit" form="buyer-input-form">{t("inputDone")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
