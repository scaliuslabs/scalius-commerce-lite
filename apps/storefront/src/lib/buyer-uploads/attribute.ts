/**
 * A `file` checkout question as the browser renderer of the apps' questions
 * (lib/buyer-ui) draws it: loaded only when a question is a file, it builds
 * the upload control (markup.ts) into the question's wrapper, enhances it and
 * reports each new answer (the upload ids joined by commas).
 */
import type { CheckoutAttribute } from "@scalius/shared/plugins/buyer-ui";
import { buyerUploadCopy } from "@/lib/buyer-upload-copy";
import { pageLanguage } from "@/lib/store-time-zone";
import { enhanceBuyerUploads } from "./control";
import { buildBuyerUploadControl } from "./markup";
import { buyerUploadField } from "./model";

export function mountBuyerUploadAttribute(wrapper: HTMLElement, options: {
  attribute: CheckoutAttribute;
  /** `<app id>.<key>`: the answer's name and the input the API knows. */
  name: string;
  id: string;
  value: string;
  readonly: boolean;
  describedBy: string[];
  onAnswer: (value: string) => void;
}): void {
  const field = buyerUploadField({
    field: options.name,
    target: "attribute",
    accept: options.attribute.accept,
    maxBytes: options.attribute.maxBytes,
    maxFiles: options.attribute.maxFiles,
    required: options.attribute.required === true,
  });
  if (!field || !wrapper.isConnected) return;
  const language = pageLanguage();
  const control = buildBuyerUploadControl({
    field,
    id: options.id,
    name: options.name,
    value: options.value,
    readonly: options.readonly,
    describedBy: options.describedBy,
    copy: buyerUploadCopy(language),
    language,
  });
  const answer = control.querySelector<HTMLInputElement>("input[data-buyer-upload-answer]")!;
  // Checkout checks every question before it pays: the picker says "wait" while a file is sending, or that a required file is missing.
  control.querySelector<HTMLInputElement>("input[data-buyer-upload-input]")!.dataset.buyerAttribute = options.name;
  answer.addEventListener("change", () => options.onAnswer(answer.value));
  wrapper.querySelector("[data-buyer-upload-slot]")?.replaceWith(control);
  enhanceBuyerUploads(control);
}
