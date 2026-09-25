// What the Issue and Adjust dialogs send, as pure functions (tested without a DOM).
import type { GiftCardMessageKey } from "~/i18n/gift-cards";
import type { AdjustGiftCardInput, IssueGiftCardInput } from "./use-gift-card-mutations";
import {
  giftCardAmountMinor,
  giftCardExpiresAtFromDay,
  isValidExpiryDay,
  isValidRecipientEmail,
  isValidRecipientPhone,
} from "./gift-card-format";

export type DeliverBy = "email" | "sms";
export type IssueField = "amount" | "expiry" | "contact" | "notify";
export type IssueErrors = Partial<Record<IssueField, GiftCardMessageKey>>;

export interface IssueDraft {
  amount: number | null;
  hasExpiry: boolean;
  expiryDay: string;
  customer: { id: string; name: string } | null;
  recipientName: string;
  deliverBy: DeliverBy;
  contact: string;
  message: string;
  note: string;
  notify: boolean;
}

/** No expiry by default (Wave B §4.2); "send now" on. */
export const EMPTY_ISSUE_DRAFT: IssueDraft = {
  amount: null,
  hasExpiry: false,
  expiryDay: "",
  customer: null,
  recipientName: "",
  deliverBy: "email",
  contact: "",
  message: "",
  note: "",
  notify: true,
};

/** Where "send now" would go: the recipient's contact, else the customer. */
export function hasDeliveryTarget(draft: IssueDraft): boolean {
  return Boolean(draft.contact.trim()) || draft.customer !== null;
}

export function validateIssueDraft(draft: IssueDraft, currencyCode: string, now: Date | number = Date.now()): IssueErrors {
  const errors: IssueErrors = {};
  if (giftCardAmountMinor(draft.amount, currencyCode) === null) errors.amount = "amountRequired";
  if (draft.hasExpiry && !isValidExpiryDay(draft.expiryDay, now)) errors.expiry = "expiryInvalid";
  const contact = draft.contact.trim();
  if (contact) {
    if (draft.deliverBy === "email" && !isValidRecipientEmail(contact)) errors.contact = "emailInvalid";
    if (draft.deliverBy === "sms" && !isValidRecipientPhone(contact)) errors.contact = "phoneInvalid";
  }
  if (draft.notify && !hasDeliveryTarget(draft)) errors.notify = "notifyNeedsTarget";
  return errors;
}

/**
 * The issue request. Empty optional fields are left out and the recipient gets
 * exactly one contact (the chosen channel). The expiry is always explicit, so
 * the card is what the dialog showed: no date means it never expires.
 */
export function issueRequestBody(draft: IssueDraft, requestKey: string): IssueGiftCardInput {
  const contact = draft.contact.trim();
  const name = draft.recipientName.trim();
  const recipient = name || contact
    ? {
      ...(name ? { name } : {}),
      ...(contact && draft.deliverBy === "email" ? { email: contact } : {}),
      ...(contact && draft.deliverBy === "sms" ? { phone: contact } : {}),
    }
    : null;
  const expiresAt = draft.hasExpiry ? giftCardExpiresAtFromDay(draft.expiryDay) : null;
  const message = draft.message.trim();
  const note = draft.note.trim();
  return {
    requestKey,
    amount: draft.amount ?? 0,
    expiresAt,
    ...(draft.customer ? { customerId: draft.customer.id } : {}),
    ...(recipient ? { recipient } : {}),
    ...(message ? { message } : {}),
    ...(note ? { note } : {}),
    notify: draft.notify && hasDeliveryTarget(draft),
  };
}

export type AdjustDirection = "increase" | "decrease";
export type AdjustErrors = Partial<Record<"amount" | "reason", GiftCardMessageKey>>;

/** The signed adjustment (major units for the API, minor for the preview), or why it can't be sent. */
export function adjustmentFor(
  input: { direction: AdjustDirection; amount: number | null; reason: string },
  card: { balanceMinor: number; currencyCode: string },
): { body: Omit<AdjustGiftCardInput, "requestKey">; deltaMinor: number } | { errors: AdjustErrors } {
  const errors: AdjustErrors = {};
  const minor = giftCardAmountMinor(input.amount, card.currencyCode);
  if (minor === null) errors.amount = "amountRequired";
  else if (input.direction === "decrease" && minor > card.balanceMinor) errors.amount = "belowZero";
  const reason = input.reason.trim();
  if (!reason) errors.reason = "reasonRequired";
  if (errors.amount || errors.reason || minor === null || input.amount === null) return { errors };
  const sign = input.direction === "decrease" ? -1 : 1;
  return { body: { amount: sign * input.amount, reason }, deltaMinor: sign * minor };
}
