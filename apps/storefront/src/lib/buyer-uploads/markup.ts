/**
 * The upload control's markup, shared by the server component
 * (components/apps/BuyerUploadField.astro) and the browser renderer of the
 * apps' checkout questions (lib/buyer-ui, which loads this module only for a
 * `file` question). control.ts enhances it; without JavaScript it is a file
 * picker with no name, so a form posts the answer field alone.
 */
import type { BuyerUploadCopy } from "@/lib/buyer-upload-copy";
import { buyerUploadAcceptAttribute, buyerUploadDataset, buyerUploadHint, type BuyerUploadField } from "./model";

export const BUYER_UPLOAD_CLASSES = {
  root: "space-y-2",
  pick: "inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-lg border border-dashed border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/30 sm:w-auto",
  input: "sr-only",
  hint: "text-sm text-muted-foreground",
  list: "space-y-2",
} as const;

export interface BuyerUploadMarkup {
  field: BuyerUploadField;
  /** The file picker's id (the field's `<label for>` names it). */
  id: string;
  /** The answer's form name (`property.<key>` on the buy form, the attribute's key at checkout). */
  name: string;
  /** The answer it holds (upload ids joined by commas), "" for none. */
  value: string;
  /** An order page: the files, without the picker or Remove. */
  readonly?: boolean;
  /** More ids the picker is described by (the field's help, its error). */
  describedBy?: readonly string[];
  copy: BuyerUploadCopy;
  language: string;
}

/** The parts' attributes, as the server component and the browser builder write them. */
export function buyerUploadParts(markup: BuyerUploadMarkup) {
  const hintId = `${markup.id}-upload-hint`;
  return {
    root: {
      ...buyerUploadDataset(markup.field),
      ...(markup.readonly ? { "data-upload-readonly": "true" } : {}),
    },
    answer: { type: "hidden" as const, name: markup.name, value: markup.value, "data-buyer-upload-answer": "" },
    input: {
      id: markup.id,
      type: "file" as const,
      accept: buyerUploadAcceptAttribute(markup.field.accept),
      multiple: markup.field.maxFiles > 1,
      disabled: markup.readonly === true,
      "aria-describedby": [hintId, ...(markup.describedBy ?? [])].join(" "),
      "data-buyer-upload-input": "",
    },
    pickLabel: markup.field.maxFiles > 1 ? markup.copy.chooseFiles : markup.copy.chooseFile,
    hintId,
    hint: buyerUploadHint(markup.copy, markup.field, markup.language),
  };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attributes: Record<string, string | boolean> = {}): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const [name, value] of Object.entries(attributes)) {
    // A boolean attribute is present when true, absent when false (as Astro writes it).
    if (value === false) continue;
    element.setAttribute(name, value === true ? "" : value);
  }
  return element;
}

/** The control in the browser: the same parts as BuyerUploadField.astro. */
export function buildBuyerUploadControl(markup: BuyerUploadMarkup): HTMLElement {
  const parts = buyerUploadParts(markup);
  const root = node("div", BUYER_UPLOAD_CLASSES.root, parts.root);
  root.append(node("input", "", parts.answer));
  if (!markup.readonly) {
    const pick = node("label", BUYER_UPLOAD_CLASSES.pick, { "data-buyer-upload-pick": "" });
    const label = node("span", "", { "data-buyer-upload-pick-label": "" });
    label.textContent = parts.pickLabel;
    pick.append(node("input", BUYER_UPLOAD_CLASSES.input, parts.input), label);
    const hint = node("p", BUYER_UPLOAD_CLASSES.hint, { id: parts.hintId });
    hint.textContent = parts.hint;
    root.append(pick, hint);
  } else {
    root.append(node("input", "hidden", parts.input));
  }
  const list = node("ul", BUYER_UPLOAD_CLASSES.list, { "data-buyer-upload-list": "" });
  list.hidden = true;
  root.append(list, node("p", "sr-only", { "data-buyer-upload-status": "", role: "status", "aria-live": "polite" }));
  return root;
}
