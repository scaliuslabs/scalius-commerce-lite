import { getDecimalPlaces } from "@scalius/shared/currency";

import type {
  CreatePromotionDraftInput,
  PromotionAggregate,
  UpdatePromotionDraftInput,
} from "~/lib/api-functions/promotions";

export const PROMOTION_TARGETS = ["line", "order", "shipping"] as const;
export type PromotionTarget = (typeof PROMOTION_TARGETS)[number];
export type PromotionEffectKind = "percentage_off" | "fixed_amount_off" | "free";

export interface PromotionEditorCode {
  code: string;
  isActive: boolean;
}

export interface PromotionEditorEffect {
  enabled: boolean;
  kind: PromotionEffectKind;
  value: string;
}

export interface PromotionEditorDraft {
  name: string;
  title: string;
  codes: PromotionEditorCode[];
  codeEntry: string;
  minimumSubtotal: string;
  minimumQuantity: string;
  effects: Record<PromotionTarget, PromotionEditorEffect>;
  startsAtLocal: string;
  endsAtLocal: string;
  timezone: string;
  maxRedemptions: string;
  maxRedemptionsPerCustomer: string;
  maxDiscountSpend: string;
  currencyCode: string;
}

export interface PromotionEditorIssue {
  field: string;
  message: string;
}

export interface PromotionEditorReadiness {
  saveIssues: PromotionEditorIssue[];
  activationIssues: PromotionEditorIssue[];
}

export interface PromotionPayloadResult {
  input: CreatePromotionDraftInput | null;
  readiness: PromotionEditorReadiness;
}

const CODE_PATTERN = /^[A-Z0-9_-]{3,50}$/u;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Dhaka";
  } catch {
    return "Asia/Dhaka";
  }
}

export function createPromotionDraft(currencyCode = "BDT"): PromotionEditorDraft {
  return {
    name: "",
    title: "",
    codes: [],
    codeEntry: "",
    minimumSubtotal: "",
    minimumQuantity: "",
    effects: {
      line: { enabled: false, kind: "percentage_off", value: "10" },
      order: { enabled: true, kind: "percentage_off", value: "10" },
      shipping: { enabled: false, kind: "free", value: "" },
    },
    startsAtLocal: "",
    endsAtLocal: "",
    timezone: browserTimezone(),
    maxRedemptions: "",
    maxRedemptionsPerCustomer: "",
    maxDiscountSpend: "",
    currencyCode: currencyCode.toUpperCase(),
  };
}

function configNumber(config: Record<string, unknown>, key: string): number | null {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function effectFromAggregate(
  aggregate: PromotionAggregate,
  target: PromotionTarget,
): PromotionEditorEffect {
  const effect = aggregate.effects.find((candidate) => candidate.target === target);
  if (!effect) {
    return {
      enabled: false,
      kind: target === "shipping" ? "free" : "percentage_off",
      value: target === "shipping" ? "" : "10",
    };
  }
  if (effect.kind === "free") {
    return { enabled: true, kind: "free", value: "" };
  }
  if (effect.kind === "percentage_off") {
    const basisPoints = configNumber(effect.config, "basisPoints") ?? 0;
    return {
      enabled: true,
      kind: "percentage_off",
      value: String(basisPoints / 100),
    };
  }
  const amountMinor = configNumber(effect.config, "amountMinor") ?? 0;
  return {
    enabled: true,
    kind: "fixed_amount_off",
    value: minorToMajor(amountMinor, aggregate.budgetCurrencyCode ?? inferCurrency(aggregate)),
  };
}

function inferCurrency(aggregate: PromotionAggregate): string {
  if (aggregate.budgetCurrencyCode) return aggregate.budgetCurrencyCode;
  for (const condition of aggregate.conditions) {
    if (condition.kind === "minimum_merchandise_subtotal") {
      const currency = condition.config.currencyCode;
      if (typeof currency === "string") return currency;
    }
  }
  for (const effect of aggregate.effects) {
    if (effect.kind === "fixed_amount_off") {
      const currency = effect.config.currencyCode;
      if (typeof currency === "string") return currency;
    }
  }
  return "BDT";
}

export function hydratePromotionDraft(
  aggregate: PromotionAggregate,
  fallbackCurrency = "BDT",
): PromotionEditorDraft {
  const currencyCode = inferCurrency(aggregate) || fallbackCurrency;
  const minimumSubtotal = aggregate.conditions.find(
    (condition) => condition.kind === "minimum_merchandise_subtotal",
  );
  const minimumQuantity = aggregate.conditions.find(
    (condition) => condition.kind === "minimum_item_quantity",
  );

  return {
    name: aggregate.name,
    title: aggregate.title ?? "",
    codes: aggregate.codes.map((code) => ({ ...code })),
    codeEntry: "",
    minimumSubtotal: minimumSubtotal
      ? minorToMajor(configNumber(minimumSubtotal.config, "amountMinor") ?? 0, currencyCode)
      : "",
    minimumQuantity: minimumQuantity
      ? String(configNumber(minimumQuantity.config, "quantity") ?? "")
      : "",
    effects: {
      line: effectFromAggregate(aggregate, "line"),
      order: effectFromAggregate(aggregate, "order"),
      shipping: effectFromAggregate(aggregate, "shipping"),
    },
    startsAtLocal: epochSecondsToZonedLocal(
      aggregate.startsAtEpochSeconds,
      aggregate.timezone,
    ),
    endsAtLocal: epochSecondsToZonedLocal(
      aggregate.endsAtEpochSeconds,
      aggregate.timezone,
    ),
    timezone: aggregate.timezone,
    maxRedemptions: aggregate.maxRedemptions === null
      ? ""
      : String(aggregate.maxRedemptions),
    maxRedemptionsPerCustomer: aggregate.maxRedemptionsPerCustomer === null
      ? ""
      : String(aggregate.maxRedemptionsPerCustomer),
    maxDiscountSpend: aggregate.maxDiscountSpendMinor === null
      ? ""
      : minorToMajor(aggregate.maxDiscountSpendMinor, currencyCode),
    currencyCode,
  };
}

export function normalizePromotionCode(value: string): string {
  return value.trim().toUpperCase();
}

export function extractPromotionCodes(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\s,]+/u)
      .map(normalizePromotionCode)
      .filter(Boolean),
  ));
}

export function addPromotionCodes(
  existing: PromotionEditorCode[],
  entry: string,
): { codes: PromotionEditorCode[]; rejected: string[] } {
  const known = new Set(existing.map(({ code }) => normalizePromotionCode(code)));
  const codes = [...existing];
  const rejected: string[] = [];
  for (const code of extractPromotionCodes(entry)) {
    if (!CODE_PATTERN.test(code)) {
      rejected.push(code);
      continue;
    }
    if (known.has(code)) continue;
    codes.push({ code, isActive: true });
    known.add(code);
    if (codes.length === 90) break;
  }
  return { codes, rejected };
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function majorToMinor(value: string, currencyCode: string): number | null {
  const normalized = value.trim();
  const precision = getDecimalPlaces(currencyCode);
  const match = normalized.match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > precision) return null;
  const scale = 10 ** precision;
  const major = Number(match[1]);
  const fractional = Number(fraction.padEnd(precision, "0") || "0");
  const minor = major * scale + fractional;
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export function minorToMajor(value: number, currencyCode: string): string {
  const precision = getDecimalPlaces(currencyCode);
  const scale = 10 ** precision;
  const result = (value / scale).toFixed(precision);
  return precision === 0 ? result : result.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

function timezoneIsValid(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function partsInTimezone(epochMilliseconds: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(epochMilliseconds);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

export function zonedLocalToEpochSeconds(value: string, timezone: string): number | null {
  const match = value.match(LOCAL_DATE_PATTERN);
  if (!match || !timezoneIsValid(timezone)) return null;
  const target = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const targetUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let candidate = targetUtc;
  for (let pass = 0; pass < 3; pass += 1) {
    const actual = partsInTimezone(candidate, timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    candidate += targetUtc - actualAsUtc;
  }
  const roundTrip = partsInTimezone(candidate, timezone);
  if (
    roundTrip.year !== target.year
    || roundTrip.month !== target.month
    || roundTrip.day !== target.day
    || roundTrip.hour !== target.hour
    || roundTrip.minute !== target.minute
  ) {
    return null;
  }
  return Math.floor(candidate / 1_000);
}

export function epochSecondsToZonedLocal(
  epochSeconds: number | null,
  timezone: string,
): string {
  if (epochSeconds === null || !timezoneIsValid(timezone)) return "";
  const parts = partsInTimezone(epochSeconds * 1_000, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

function percentToBasisPoints(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value.trim())) return null;
  const parsed = Number(value);
  if (!(parsed > 0 && parsed <= 100)) return null;
  const basisPoints = Math.round(parsed * 100);
  return basisPoints >= 1 && basisPoints <= 10_000 ? basisPoints : null;
}

export function validatePromotionDraft(
  draft: PromotionEditorDraft,
): PromotionEditorReadiness {
  const saveIssues: PromotionEditorIssue[] = [];
  const activationIssues: PromotionEditorIssue[] = [];
  const add = (field: string, message: string) => saveIssues.push({ field, message });

  if (!draft.name.trim()) add("name", "Add an internal name.");
  else if (draft.name.trim().length > 160) add("name", "Internal name must be 160 characters or fewer.");
  if (draft.title.trim().length > 200) add("title", "Customer title must be 200 characters or fewer.");

  if (draft.codes.length === 0) add("codes", "Add at least one checkout code.");
  if (draft.codes.length > 90) add("codes", "A promotion can contain up to 90 codes.");
  const normalizedCodes = draft.codes.map(({ code }) => normalizePromotionCode(code));
  if (normalizedCodes.some((code) => !CODE_PATTERN.test(code))) {
    add("codes", "Codes need 3–50 letters, numbers, underscores, or hyphens.");
  }
  if (new Set(normalizedCodes).size !== normalizedCodes.length) {
    add("codes", "Codes must be unique.");
  }
  if (!draft.codes.some(({ isActive }) => isActive)) {
    activationIssues.push({ field: "codes", message: "Enable at least one checkout code." });
  }

  if (draft.minimumSubtotal && majorToMinor(draft.minimumSubtotal, draft.currencyCode) === null) {
    add("minimumSubtotal", "Minimum subtotal must be a positive valid amount.");
  }
  if (draft.minimumQuantity && parsePositiveInteger(draft.minimumQuantity) === null) {
    add("minimumQuantity", "Minimum quantity must be a positive whole number.");
  }

  const enabledEffects = PROMOTION_TARGETS.filter((target) => draft.effects[target].enabled);
  if (enabledEffects.length === 0) add("effects", "Choose at least one discount outcome.");
  enabledEffects.forEach((target) => {
    const effect = draft.effects[target];
    if (effect.kind === "free" && target !== "shipping") {
      add(`effects.${target}`, "Only delivery can be made free.");
    } else if (
      effect.kind === "percentage_off"
      && percentToBasisPoints(effect.value) === null
    ) {
      add(`effects.${target}`, "Percentage must be greater than 0 and no more than 100.");
    } else if (
      effect.kind === "fixed_amount_off"
      && majorToMinor(effect.value, draft.currencyCode) === null
    ) {
      add(`effects.${target}`, "Fixed discount must be a positive valid amount.");
    }
  });

  if (!timezoneIsValid(draft.timezone.trim())) {
    add("timezone", "Use a valid IANA timezone, such as Asia/Dhaka.");
  }
  const startsAt = draft.startsAtLocal
    ? zonedLocalToEpochSeconds(draft.startsAtLocal, draft.timezone.trim())
    : null;
  const endsAt = draft.endsAtLocal
    ? zonedLocalToEpochSeconds(draft.endsAtLocal, draft.timezone.trim())
    : null;
  if (draft.startsAtLocal && startsAt === null) add("startsAtLocal", "Start time is not valid in this timezone.");
  if (draft.endsAtLocal && endsAt === null) add("endsAtLocal", "End time is not valid in this timezone.");
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    add("endsAtLocal", "End time must be after the start time.");
  }

  const total = draft.maxRedemptions
    ? parsePositiveInteger(draft.maxRedemptions)
    : null;
  const perCustomer = draft.maxRedemptionsPerCustomer
    ? parsePositiveInteger(draft.maxRedemptionsPerCustomer)
    : null;
  if (draft.maxRedemptions && total === null) add("maxRedemptions", "Total uses must be a positive whole number.");
  if (draft.maxRedemptionsPerCustomer && perCustomer === null) {
    add("maxRedemptionsPerCustomer", "Uses per customer must be a positive whole number.");
  }
  if (total !== null && perCustomer !== null && perCustomer > total) {
    add("maxRedemptionsPerCustomer", "Uses per customer cannot exceed total uses.");
  }
  if (draft.maxDiscountSpend && majorToMinor(draft.maxDiscountSpend, draft.currencyCode) === null) {
    add("maxDiscountSpend", "Spend budget must be a positive valid amount.");
  }

  return { saveIssues, activationIssues };
}

export function buildPromotionPayload(draft: PromotionEditorDraft): PromotionPayloadResult {
  const readiness = validatePromotionDraft(draft);
  if (readiness.saveIssues.length > 0) return { input: null, readiness };
  const currencyCode = draft.currencyCode.toUpperCase();
  const conditions: CreatePromotionDraftInput["conditions"] = [];
  if (draft.minimumSubtotal) {
    conditions.push({
      kind: "minimum_merchandise_subtotal",
      config: {
        amountMinor: majorToMinor(draft.minimumSubtotal, currencyCode)!,
        currencyCode,
      },
    });
  }
  if (draft.minimumQuantity) {
    conditions.push({
      kind: "minimum_item_quantity",
      config: { quantity: parsePositiveInteger(draft.minimumQuantity)! },
    });
  }
  const effects: CreatePromotionDraftInput["effects"] = [];
  for (const target of PROMOTION_TARGETS) {
    const effect = draft.effects[target];
    if (!effect.enabled) continue;
    if (effect.kind === "free") {
      effects.push({ kind: "free", target: "shipping", allocation: "once", config: {} });
    } else if (effect.kind === "percentage_off") {
      effects.push({
        kind: "percentage_off",
        target,
        allocation: target === "line" ? "across" : "once",
        config: { basisPoints: percentToBasisPoints(effect.value)! },
      });
    } else {
      effects.push({
        kind: "fixed_amount_off",
        target,
        allocation: target === "line" ? "across" : "once",
        config: {
          amountMinor: majorToMinor(effect.value, currencyCode)!,
          currencyCode,
        },
      });
    }
  }

  return {
    readiness,
    input: {
      name: draft.name.trim(),
      title: draft.title.trim() || null,
      method: "code",
      priority: 100,
      conflictPolicy: "best",
      startsAtEpochSeconds: draft.startsAtLocal
        ? zonedLocalToEpochSeconds(draft.startsAtLocal, draft.timezone.trim())
        : null,
      endsAtEpochSeconds: draft.endsAtLocal
        ? zonedLocalToEpochSeconds(draft.endsAtLocal, draft.timezone.trim())
        : null,
      timezone: draft.timezone.trim(),
      maxRedemptions: draft.maxRedemptions
        ? parsePositiveInteger(draft.maxRedemptions)
        : null,
      maxRedemptionsPerCustomer: draft.maxRedemptionsPerCustomer
        ? parsePositiveInteger(draft.maxRedemptionsPerCustomer)
        : null,
      maxDiscountSpendMinor: draft.maxDiscountSpend
        ? majorToMinor(draft.maxDiscountSpend, currencyCode)
        : null,
      budgetCurrencyCode: draft.maxDiscountSpend ? currencyCode : null,
      codes: draft.codes.map(({ code, isActive }) => ({
        code: normalizePromotionCode(code),
        isActive,
      })),
      conditions,
      effects,
    },
  };
}

export function buildPromotionUpdateInput(
  draft: PromotionEditorDraft,
  expectedRevision: number,
): UpdatePromotionDraftInput | null {
  const input = buildPromotionPayload(draft).input;
  return input ? { ...input, expectedRevision } : null;
}

export function draftsEqual(left: PromotionEditorDraft, right: PromotionEditorDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const TARGET_LABELS: Record<PromotionTarget, string> = {
  line: "items",
  order: "order",
  shipping: "delivery",
};

export function describeEditorEffect(
  target: PromotionTarget,
  effect: PromotionEditorEffect,
  currencySymbol: string,
): string {
  if (!effect.enabled) return `No ${TARGET_LABELS[target]} discount`;
  if (effect.kind === "free") return "Free delivery";
  const amount = effect.kind === "percentage_off"
    ? `${effect.value || "0"}%`
    : `${currencySymbol}${effect.value || "0"}`;
  return `${amount} off ${TARGET_LABELS[target]}`;
}

export function summarizePromotionDraft(
  draft: PromotionEditorDraft,
  currencySymbol: string,
): string[] {
  return PROMOTION_TARGETS
    .filter((target) => draft.effects[target].enabled)
    .map((target) => describeEditorEffect(target, draft.effects[target], currencySymbol));
}

export function promotionStatusLabel(status: PromotionAggregate["status"]): string {
  if (status === "active") return "Active";
  if (status === "paused") return "Paused";
  if (status === "archived") return "Archived";
  return "Draft";
}

export function filterPromotions(
  promotions: PromotionAggregate[],
  search: string,
  status?: PromotionAggregate["status"],
): PromotionAggregate[] {
  const query = search.trim().toLocaleLowerCase();
  return promotions.filter((promotion) => {
    if (status && promotion.status !== status) return false;
    if (!query) return true;
    return [
      promotion.name,
      promotion.title ?? "",
      ...promotion.codes.map(({ code }) => code),
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}
