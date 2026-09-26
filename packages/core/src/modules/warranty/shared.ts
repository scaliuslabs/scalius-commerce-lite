// Helpers shared by the warranty services: ids, clocks, error codes and the
// English event/subject lines written into claim threads. Pure except for
// `claimIdFor`, which hashes with Web Crypto.

import type { Database } from "@scalius/database/client";
import { AppError, ConflictError } from "../../errors";
import { warrantySummaryLabel, type WarrantyDurationUnit, type WarrantyProvider } from "@scalius/shared/warranty";

export type BatchStatements = Parameters<Database["batch"]>[0];
export type BatchStatement = BatchStatements[number];

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Code points, as SQLite `length()` counts them. */
export function codePoints(value: string): number {
  return Array.from(value).length;
}

export function truncateCodePoints(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join("")}…`;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function toBase62(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) out += BASE62[bytes[index]! % 62];
  return out;
}

/**
 * The claim id for one "Make a claim" form: derived from the warranty and the
 * form's client key, so a double submit (or the image uploads that precede
 * the submit) lands on the same claim and the same reserved thread.
 */
export async function claimIdFor(warrantyId: string, clientKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`warranty-claim:${warrantyId}:${clientKey}`),
  ));
  return `wcl_${toBase62(digest, 24)}`;
}

/** Form keys: 8–100 URL-safe characters (a UUID from the page). */
export const CLAIM_CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export function warrantyNotActive(message = "This warranty is no longer active."): AppError {
  return new AppError(409, "WARRANTY_NOT_ACTIVE", message);
}

export function warrantyExpired(expiresAt: number): AppError {
  return new AppError(
    409,
    "WARRANTY_EXPIRED",
    `This warranty ended on ${formatClaimDate(expiresAt)}. Message the store about the order if you need help.`,
  );
}

export function claimAlreadyOpen(conversationId: string | null): AppError {
  return new AppError(
    409,
    "WARRANTY_CLAIM_OPEN",
    "A claim for this item is already open. Continue in that conversation.",
    conversationId ? { conversationId } : undefined,
  );
}

export function staleClaim(): ConflictError {
  return new ConflictError("Someone else changed this claim. Refresh and try again.");
}

const CLAIM_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Dhaka",
});

/** "12 Sep 2027" in Bangladesh time. */
export function formatClaimDate(epochSeconds: number): string {
  return CLAIM_DATE.format(new Date(epochSeconds * 1000));
}

export interface ClaimLineFacts {
  productName: string | null;
  variantLabel: string | null;
  expiresAt: number;
}

function itemName(facts: Pick<ClaimLineFacts, "productName" | "variantLabel">): string {
  const name = facts.productName?.trim() || "your item";
  const variant = facts.variantLabel?.trim();
  return variant ? `${name} (${variant})` : name;
}

/** The thread's subject: "Warranty claim · iPhone 15 (128 GB)". */
export function claimSubject(facts: Pick<ClaimLineFacts, "productName" | "variantLabel">): string {
  return truncateCodePoints(`Warranty claim · ${itemName(facts)}`, 120);
}

/** The opening event line: "Warranty claim for iPhone 15 · warranty until 12 Sep 2027". */
export function claimOpenedLine(facts: ClaimLineFacts, expired: boolean): string {
  const until = `${expired ? "warranty ended" : "warranty until"} ${formatClaimDate(facts.expiresAt)}`;
  return truncateCodePoints(`Warranty claim for ${itemName(facts)} · ${until}`, 500);
}

const STATUS_WORDS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  rejected: "Declined",
};

const RESOLUTION_WORDS: Record<string, string> = {
  repair: "Repair",
  replacement: "Replacement",
  refund: "Refund",
  other: "Other",
};

/** A status event line: "Claim status: In progress", "Claim resolved · Repair", "Claim declined". */
export function claimStatusLine(status: string, resolution: string | null): string {
  if (status === "resolved") {
    return resolution ? `Claim resolved · ${RESOLUTION_WORDS[resolution] ?? resolution}` : "Claim resolved";
  }
  if (status === "rejected") return "Claim declined";
  if (status === "open") return "Claim reopened";
  return `Claim status: ${STATUS_WORDS[status] ?? status}`;
}

export interface PolicyTerms {
  name: string;
  provider: WarrantyProvider;
  durationValue: number;
  durationUnit: WarrantyDurationUnit;
  replacementDays: number | null;
}

export function policySummary(policy: PolicyTerms): string {
  return warrantySummaryLabel(policy);
}

export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return `${error.message} ${cause instanceof Error ? cause.message : String(cause ?? "")}`;
}
