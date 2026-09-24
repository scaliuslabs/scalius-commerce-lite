/**
 * The discount editor's form model: one draft shape for the four discount
 * types, conversion to and from the API rule, validation (message keys from
 * the discounts catalog) and the live summary. Pure, so it is unit tested.
 */
import { getDecimalPlaces } from "@scalius/shared/currency";

import type { DiscountMessageKey } from "~/i18n/discounts";
import type { DiscountInput, DiscountRecord } from "~/lib/api-query-options/discounts";
import { ADMIN_TIME_ZONE } from "~/lib/admin-time";

export const DISCOUNT_TYPES = ["products", "buy_get", "order", "shipping"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];
export type DiscountClass = "product" | "order" | "shipping";
export type ScopeKind = "products" | "collections";

export interface Scope {
  kind: ScopeKind;
  ids: string[];
}

export interface DiscountDraft {
  type: DiscountType;
  method: "code" | "automatic";
  code: string;
  title: string;
  valueKind: "percentage" | "fixed";
  value: string;
  /** Fixed product amount: take it off once per order instead of each item. */
  oncePerOrder: boolean;
  appliesTo: Scope;
  /** Product and order discounts may also give free shipping. */
  freeShipping: boolean;
  /** Order subtotal after this discount that free shipping needs; empty = always. */
  freeShippingMinimum: string;
  minimum: "none" | "amount" | "quantity";
  minimumValue: string;
  buyKind: "quantity" | "amount";
  buyValue: string;
  buyScope: Scope;
  getQuantity: string;
  getScope: Scope;
  getValueKind: "percentage" | "free";
  getValue: string;
  limitUsesPerOrder: boolean;
  usesPerOrder: string;
  limitTotal: boolean;
  totalUses: string;
  oncePerCustomer: boolean;
  combines: Record<DiscountClass, boolean>;
  startDate: string;
  startTime: string;
  hasEnd: boolean;
  endDate: string;
  endTime: string;
  /** Kept from the saved rule; the editor does not change it. */
  spendBudgetMinor: number | null;
}

export type DraftErrors = Partial<Record<keyof DiscountDraft, DiscountMessageKey>>;

export const DISCOUNT_CLASS: Record<DiscountType, DiscountClass> = {
  products: "product",
  buy_get: "product",
  order: "order",
  shipping: "shipping",
};

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME = /^(\d{2}):(\d{2})$/u;
const CODE_PATTERN = /^[A-Z0-9_-]{3,50}$/u;

function partsIn(epochMs: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ADMIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(epochMs);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

/** Store (Asia/Dhaka) wall time → epoch seconds; null when not a real time. */
export function storeTimeToEpoch(date: string, time: string): number | null {
  const d = LOCAL_DATE.exec(date);
  const t = LOCAL_TIME.exec(time || "00:00");
  if (!d || !t) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  let guess = wall;
  for (let pass = 0; pass < 3; pass += 1) {
    const actual = partsIn(guess);
    const [year, month, day] = actual.date.split("-").map(Number);
    const [hour, minute] = actual.time.split(":").map(Number);
    guess += wall - Date.UTC(year!, month! - 1, day!, hour!, minute!);
  }
  const check = partsIn(guess);
  return check.date === date && check.time === (time || "00:00") ? Math.floor(guess / 1_000) : null;
}

export function epochToStoreTime(epochSeconds: number): { date: string; time: string } {
  return partsIn(epochSeconds * 1_000);
}

/** Money inputs above this (major units) are typos, not discounts (৳10,00,000). */
export const MAX_AMOUNT_MAJOR = 1_000_000;
/** The API's cap for item quantities (buy, get, per order, minimum items). */
export const MAX_QUANTITY = 10_000;

/** Bengali digits (০-৯) typed on a Bangla keyboard → Latin, so every number field accepts them. */
/** A number as merchants type it: Bangla digits become Latin, and grouping commas ("1,000", "1,00,000") are dropped. */
export function latinDigits(value: string): string {
  return value
    .replace(/[০-৯]/gu, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/(?<=\d),(?=\d)/gu, "");
}

/** Why an amount can't be saved, or null when it can. */
export function amountError(value: string, currencyCode: string): DiscountMessageKey | null {
  const precision = getDecimalPlaces(currencyCode);
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(latinDigits(value).trim());
  if (!match) return "errorAmount";
  if ((match[2]?.length ?? 0) > precision) return precision === 0 ? "errorWholeAmount" : "errorDecimals";
  const major = Number(`${match[1]}.${match[2] ?? "0"}`);
  if (major <= 0) return "errorAmount";
  return major > MAX_AMOUNT_MAJOR ? "errorAmountMax" : null;
}

export function majorToMinor(value: string, currencyCode: string): number | null {
  if (amountError(value, currencyCode)) return null;
  const precision = getDecimalPlaces(currencyCode);
  const [whole, fraction = ""] = latinDigits(value).trim().split(".");
  return Number(whole) * 10 ** precision + Number(fraction.padEnd(precision, "0") || "0");
}

export function minorToMajor(value: number, currencyCode: string): string {
  const precision = getDecimalPlaces(currencyCode);
  const fixed = (value / 10 ** precision).toFixed(precision);
  return precision === 0 ? fixed : fixed.replace(/\.?0+$/u, "");
}

function positiveInteger(value: string, max = Number.MAX_SAFE_INTEGER): number | null {
  const digits = latinDigits(value).trim();
  if (!/^\d+$/u.test(digits)) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : null;
}

function quantityError(value: string, max = MAX_QUANTITY): DiscountMessageKey | null {
  if (positiveInteger(value) === null) return "errorQuantity";
  return positiveInteger(value, max) === null ? "errorQuantityMax" : null;
}

function percentToBasisPoints(value: string): number | null {
  const digits = latinDigits(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(digits)) return null;
  const basisPoints = Math.round(Number(digits) * 100);
  return basisPoints >= 1 && basisPoints <= 10_000 ? basisPoints : null;
}

export function generateDiscountCode(random: () => number = Math.random): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 10 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
}

export function emptyDraft(type: DiscountType, now = Date.now()): DiscountDraft {
  const start = epochToStoreTime(Math.floor(now / 1_000));
  return {
    type,
    method: "code",
    code: "",
    title: "",
    valueKind: "percentage",
    value: "",
    oncePerOrder: false,
    appliesTo: { kind: "collections", ids: [] },
    freeShipping: false,
    freeShippingMinimum: "",
    minimum: "none",
    minimumValue: "",
    buyKind: "quantity",
    buyValue: "1",
    buyScope: { kind: "products", ids: [] },
    getQuantity: "1",
    getScope: { kind: "products", ids: [] },
    getValueKind: "free",
    getValue: "",
    limitUsesPerOrder: false,
    usesPerOrder: "",
    limitTotal: false,
    totalUses: "",
    oncePerCustomer: false,
    combines: { product: false, order: false, shipping: false },
    startDate: start.date,
    startTime: start.time,
    hasEnd: false,
    endDate: "",
    endTime: "",
    spendBudgetMinor: null,
  };
}

type Config = Record<string, unknown>;
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
const numberOf = (value: unknown): number | null => typeof value === "number" ? value : null;

function scopeOf(config: Config | undefined): Scope {
  const collectionIds = ids(config?.collectionIds);
  return collectionIds.length > 0
    ? { kind: "collections", ids: collectionIds }
    : { kind: "products", ids: ids(config?.productIds) };
}

export function discountTypeOf(record: Pick<DiscountRecord, "effects">): DiscountType {
  const effect = record.effects[0];
  if (!effect || effect.target === "order") return "order";
  if (effect.target === "shipping") return "shipping";
  return effect.config.buy ? "buy_get" : "products";
}

export function draftFromDiscount(record: DiscountRecord, currencyCode: string): DiscountDraft {
  const type = discountTypeOf(record);
  const draft = emptyDraft(type);
  const effect = record.effects[0]!;
  const config = effect.config as Config;
  const money = (minor: unknown) => minorToMajor(numberOf(minor) ?? 0, currencyCode);
  const minimum = record.conditions.find(({ config }) => config.shippingOnly !== true);
  const shippingMinimum = record.conditions.find(({ config }) => config.shippingOnly === true);
  const start = record.startsAtEpochSeconds === null ? null : epochToStoreTime(record.startsAtEpochSeconds);
  const end = record.endsAtEpochSeconds === null ? null : epochToStoreTime(record.endsAtEpochSeconds);
  const buy = config.buy as Config | undefined;
  return {
    ...draft,
    method: record.method,
    code: record.codes[0]?.code ?? "",
    title: record.method === "automatic" ? record.name : "",
    valueKind: effect.kind === "fixed_amount_off" ? "fixed" : "percentage",
    value: effect.kind === "fixed_amount_off"
      ? money(config.amountMinor)
      : effect.kind === "percentage_off" ? String((numberOf(config.basisPoints) ?? 0) / 100) : "",
    oncePerOrder: effect.kind === "fixed_amount_off" && config.eachItem !== true,
    appliesTo: type === "products" ? scopeOf(config) : draft.appliesTo,
    freeShipping: type !== "shipping" && record.effects[1]?.target === "shipping",
    freeShippingMinimum: shippingMinimum ? money(shippingMinimum.config.amountMinor) : "",
    minimum: minimum?.kind === "minimum_merchandise_subtotal" ? "amount" : minimum ? "quantity" : "none",
    minimumValue: minimum?.kind === "minimum_merchandise_subtotal"
      ? money(minimum.config.amountMinor)
      : minimum ? String(numberOf(minimum.config.quantity) ?? "") : "",
    buyKind: buy?.amountMinor ? "amount" : "quantity",
    buyValue: buy?.amountMinor ? money(buy.amountMinor) : String(numberOf(buy?.quantity) ?? 1),
    buyScope: scopeOf(buy),
    getQuantity: String(numberOf(config.getQuantity) ?? 1),
    getScope: type === "buy_get" ? scopeOf(config) : draft.getScope,
    getValueKind: numberOf(config.basisPoints) === 10_000 ? "free" : "percentage",
    getValue: type === "buy_get" && numberOf(config.basisPoints) !== 10_000
      ? String((numberOf(config.basisPoints) ?? 0) / 100)
      : "",
    limitUsesPerOrder: numberOf(config.maxUsesPerOrder) !== null,
    usesPerOrder: String(numberOf(config.maxUsesPerOrder) ?? ""),
    limitTotal: record.maxRedemptions !== null,
    totalUses: String(record.maxRedemptions ?? ""),
    oncePerCustomer: record.maxRedemptionsPerCustomer !== null,
    combines: { ...record.combinesWith },
    startDate: start?.date ?? "",
    startTime: start?.time ?? "",
    hasEnd: end !== null,
    endDate: end?.date ?? "",
    endTime: end?.time ?? "",
    spendBudgetMinor: record.maxDiscountSpendMinor,
  };
}

export function validateDraft(
  draft: DiscountDraft,
  currencyCode: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): DraftErrors {
  const errors: DraftErrors = {};
  const set = (field: keyof DiscountDraft, error: DiscountMessageKey | null) => {
    if (error) errors[field] = error;
  };
  if (draft.method === "code") {
    if (!draft.code.trim()) errors.code = "errorCodeRequired";
    else if (!CODE_PATTERN.test(draft.code.trim().toUpperCase())) errors.code = "errorCodeFormat";
  } else if (!draft.title.trim()) {
    errors.title = "errorTitleRequired";
  } else if (draft.title.trim().length > 160) {
    errors.title = "errorTitleLength";
  }
  if (draft.type === "products" || draft.type === "order") {
    set("value", draft.valueKind === "percentage"
      ? percentToBasisPoints(draft.value) === null ? "errorPercent" : null
      : amountError(draft.value, currencyCode));
  }
  if (draft.type === "products" && draft.appliesTo.ids.length === 0) errors.appliesTo = "errorPickItems";
  if (bundlesShipping(draft) && draft.freeShippingMinimum.trim()) {
    set("freeShippingMinimum", amountError(draft.freeShippingMinimum, currencyCode));
  }
  if (draft.type === "buy_get") {
    set("buyValue", draft.buyKind === "quantity" ? quantityError(draft.buyValue) : amountError(draft.buyValue, currencyCode));
    if (draft.buyScope.ids.length === 0) errors.buyScope = "errorPickItems";
    set("getQuantity", quantityError(draft.getQuantity));
    if (draft.getScope.ids.length === 0) errors.getScope = "errorPickItems";
    if (draft.getValueKind === "percentage" && percentToBasisPoints(draft.getValue) === null) errors.getValue = "errorPercent";
    if (draft.limitUsesPerOrder) set("usesPerOrder", quantityError(draft.usesPerOrder));
  } else if (draft.minimum !== "none") {
    set("minimumValue", draft.minimum === "amount"
      ? amountError(draft.minimumValue, currencyCode)
      : quantityError(draft.minimumValue));
  }
  if (draft.method === "code" && draft.limitTotal) {
    set("totalUses", quantityError(draft.totalUses, Number.MAX_SAFE_INTEGER));
  }
  const start = storeTimeToEpoch(draft.startDate, draft.startTime);
  if (start === null) errors.startDate = "errorDate";
  if (draft.hasEnd) {
    const end = storeTimeToEpoch(draft.endDate, draft.endTime);
    if (end === null) errors.endDate = "errorDate";
    // An ended discount can't be switched on; say so before saving.
    else if (end <= nowSeconds) errors.endDate = "errorEndPassed";
    else if (start !== null && end <= start) errors.endDate = "errorEndBeforeStart";
  }
  return errors;
}

function bundlesShipping(draft: DiscountDraft): boolean {
  return draft.freeShipping && (draft.type === "products" || draft.type === "order");
}

function scopeConfig(scope: Scope) {
  return scope.kind === "products" ? { productIds: scope.ids } : { collectionIds: scope.ids };
}

/** API rule for a valid draft (call `validateDraft` first). */
export function draftToInput(draft: DiscountDraft, currencyCode: string): DiscountInput {
  const currency = currencyCode.toUpperCase();
  const code = draft.code.trim().toUpperCase();
  const value = () => draft.valueKind === "percentage"
    ? { kind: "percentage_off" as const, config: { basisPoints: percentToBasisPoints(draft.value)! } }
    : { kind: "fixed_amount_off" as const, config: { amountMinor: majorToMinor(draft.value, currency)!, currencyCode: currency } };
  let effect: DiscountInput["effects"][number];
  if (draft.type === "shipping") {
    effect = { kind: "free", target: "shipping", allocation: "once", config: {} };
  } else if (draft.type === "order") {
    const { kind, config } = value();
    effect = kind === "percentage_off"
      ? { kind, target: "order", allocation: "once", config }
      : { kind, target: "order", allocation: "once", config };
  } else if (draft.type === "products") {
    const { kind, config } = value();
    effect = kind === "percentage_off"
      ? { kind, target: "line", allocation: "across", config: { ...config, ...scopeConfig(draft.appliesTo) } }
      : {
        kind,
        target: "line",
        allocation: "across",
        config: { ...config, ...scopeConfig(draft.appliesTo), ...(draft.oncePerOrder ? {} : { eachItem: true }) },
      };
  } else {
    effect = {
      kind: "percentage_off",
      target: "line",
      allocation: "across",
      config: {
        basisPoints: draft.getValueKind === "free" ? 10_000 : percentToBasisPoints(draft.getValue)!,
        ...scopeConfig(draft.getScope),
        getQuantity: positiveInteger(draft.getQuantity)!,
        buy: {
          ...(draft.buyKind === "quantity"
            ? { quantity: positiveInteger(draft.buyValue)! }
            : { amountMinor: majorToMinor(draft.buyValue, currency)!, currencyCode: currency }),
          ...scopeConfig(draft.buyScope),
        },
        ...(draft.limitUsesPerOrder ? { maxUsesPerOrder: positiveInteger(draft.usesPerOrder)! } : {}),
      },
    };
  }
  // Shopify: a product discount's minimum counts only the chosen items.
  const minimumScope = draft.type === "products" ? scopeConfig(draft.appliesTo) : {};
  const conditions: DiscountInput["conditions"] = draft.type === "buy_get" || draft.minimum === "none"
    ? []
    : draft.minimum === "amount"
      ? [{ kind: "minimum_merchandise_subtotal", config: { amountMinor: majorToMinor(draft.minimumValue, currency)!, currencyCode: currency, ...minimumScope } }]
      : [{ kind: "minimum_item_quantity", config: { quantity: positiveInteger(draft.minimumValue)!, ...minimumScope } }];
  const effects: DiscountInput["effects"] = [effect];
  if (bundlesShipping(draft)) {
    effects.push({ kind: "free", target: "shipping", allocation: "once", config: {} });
    if (draft.freeShippingMinimum.trim()) {
      conditions.push({
        kind: "minimum_merchandise_subtotal",
        config: { amountMinor: majorToMinor(draft.freeShippingMinimum, currency)!, currencyCode: currency, shippingOnly: true },
      });
    }
  }
  const isCode = draft.method === "code";
  return {
    name: isCode ? code : draft.title.trim(),
    title: null,
    method: draft.method,
    combinesWith: {
      ...draft.combines,
      [DISCOUNT_CLASS[draft.type]]: false,
      ...(bundlesShipping(draft) ? { shipping: false } : {}),
    },
    startsAtEpochSeconds: storeTimeToEpoch(draft.startDate, draft.startTime),
    endsAtEpochSeconds: draft.hasEnd ? storeTimeToEpoch(draft.endDate, draft.endTime) : null,
    timezone: ADMIN_TIME_ZONE,
    maxRedemptions: isCode && draft.limitTotal ? positiveInteger(draft.totalUses) : null,
    maxRedemptionsPerCustomer: isCode && draft.oncePerCustomer ? 1 : null,
    maxDiscountSpendMinor: isCode ? draft.spendBudgetMinor : null,
    budgetCurrencyCode: isCode && draft.spendBudgetMinor !== null ? currency : null,
    codes: isCode ? [{ code, isActive: true }] : [],
    conditions,
    effects,
  };
}

/** Classes this draft may combine with (its own class never; nor shipping when it bundles free shipping). */
export function combinableClasses(draft: DiscountDraft): DiscountClass[] {
  return (["product", "order", "shipping"] as const).filter((item) =>
    item !== DISCOUNT_CLASS[draft.type] && !(item === "shipping" && bundlesShipping(draft)));
}

/**
 * How this draft behaves next to the store's other live discounts. Combining
 * is symmetric: either discount allowing the other's class is enough.
 */
export function combinationPreview(
  draft: DiscountDraft,
  discounts: DiscountRecord[],
  selfId: string | undefined,
): Array<{ name: string; stacks: boolean }> {
  const own = DISCOUNT_CLASS[draft.type];
  return discounts
    .filter((other) => other.id !== selfId && ["active", "scheduled"].includes(discountStatus(other)))
    .map((other) => {
      const otherClass = DISCOUNT_CLASS[discountTypeOf(other)];
      const stacks = otherClass !== own
        && (combinableClasses(draft).includes(otherClass) && draft.combines[otherClass] || other.combinesWith[own]);
      return { name: other.codes[0]?.code ?? other.name, stacks };
    })
    .sort((left, right) => Number(right.stacks) - Number(left.stacks) || left.name.localeCompare(right.name));
}

export type DiscountStatus = "active" | "scheduled" | "expired" | "draft" | "inactive";

export function discountStatus(
  record: Pick<DiscountRecord, "status" | "startsAtEpochSeconds" | "endsAtEpochSeconds">,
  nowSeconds = Math.floor(Date.now() / 1_000),
): DiscountStatus {
  if (record.status !== "active" && record.status !== "draft") return "inactive";
  // Past its end date a draft can never go live either: both are expired.
  if (record.endsAtEpochSeconds !== null && record.endsAtEpochSeconds <= nowSeconds) return "expired";
  if (record.status === "draft") return "draft";
  if (record.startsAtEpochSeconds !== null && record.startsAtEpochSeconds > nowSeconds) return "scheduled";
  return "active";
}

/** A code whose total-use limit is used up: still on, but no buyer can apply it. */
export function limitReached(record: Pick<DiscountRecord, "maxRedemptions" | "redemptionCount">): boolean {
  return record.maxRedemptions !== null && record.redemptionCount >= record.maxRedemptions;
}

/**
 * A fixed amount off each item that is more than every selected product's
 * price makes them free (the storefront clamps it). `prices` are the selected
 * products' prices in major units, or null while they load.
 */
export function exceedsEveryPrice(draft: DiscountDraft, prices: number[] | null, currencyCode: string): boolean {
  if (draft.type !== "products" || draft.valueKind !== "fixed" || draft.oncePerOrder) return false;
  if (draft.appliesTo.kind !== "products" || !prices || prices.length === 0) return false;
  const amount = majorToMinor(draft.value, currencyCode);
  const precision = getDecimalPlaces(currencyCode);
  return amount !== null && prices.every((price) => amount > Math.round(price * 10 ** precision));
}

/** Message key + vars for one summary line, rendered by the caller's `t`. */
export type SummaryLine = { key: DiscountMessageKey; vars?: Record<string, string | number> };

export interface SummaryFormat {
  /** A valid major-unit amount, e.g. "1500" → "৳1,500.00". */
  money: (major: string) => string;
  /** A valid number → the dashboard language's digits. */
  number: (value: string) => string;
  date: (epochSeconds: number) => string;
  /** The picked items by name ("Panjabi, Attar and 1 more") or by count ("3 products"). */
  scope: (scope: Scope) => string;
}

const one = (value: string) => latinDigits(value).trim() === "1";

/** The value in a few words for the list: "10% off · 2 products", "Buy 2 get 1". */
export function describeValue(draft: DiscountDraft, currencyCode: string, format: SummaryFormat): SummaryLine {
  const value = draft.valueKind === "percentage"
    ? `${format.number(draft.value)}%`
    : format.money(draft.value);
  if (draft.type === "shipping") return { key: "type_shipping" };
  if (draft.type === "order") return { key: "listValueOrder", vars: { value } };
  if (draft.type === "products") return { key: "listValueProducts", vars: { value, scope: format.scope(draft.appliesTo) } };
  const get = format.number(draft.getQuantity);
  // A partial gift names its discount, so "Buy 1 get 1" always means free.
  const percent = draft.getValueKind === "percentage" ? `${format.number(draft.getValue)}%` : null;
  if (draft.buyKind === "quantity") {
    const vars = { buy: format.number(draft.buyValue), get };
    return percent ? { key: "listValueBuyGetPercent", vars: { ...vars, percent } } : { key: "listValueBuyGet", vars };
  }
  const vars = { value: format.money(draft.buyValue), get };
  return percent ? { key: "listValueSpendGetPercent", vars: { ...vars, percent } } : { key: "listValueSpendGet", vars };
}

/** The Summary card: one line per fact, only once that fact is complete and valid. */
/**
 * The Summary card's lines. `stacksWithOthers` is how many other active or
 * scheduled discounts combine with this one (from `combinationPreview`, the
 * same rule checkout applies: a tick on either discount is enough), so the
 * combination line never contradicts the list under it.
 */
export function summarizeDraft(
  draft: DiscountDraft,
  currencyCode: string,
  format: SummaryFormat,
  stacksWithOthers = 0,
): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const clean = (value: string) => latinDigits(value).trim();
  const amount = (value: string) => (amountError(value, currencyCode) ? null : format.money(clean(value)));
  const percent = (value: string) => (percentToBasisPoints(value) === null ? null : `${format.number(clean(value))}%`);
  const count = (value: string, max?: number) => (quantityError(value, max) ? null : format.number(clean(value)));
  const value = draft.valueKind === "percentage" ? percent(draft.value) : amount(draft.value);
  if (draft.type === "products") {
    if (value) lines.push({ key: draft.valueKind === "fixed" && !draft.oncePerOrder ? "summaryOffEachItem" : "summaryOff", vars: { value } });
    if (draft.appliesTo.ids.length > 0) lines.push({ key: "summaryAppliesTo", vars: { names: format.scope(draft.appliesTo) } });
  } else if (draft.type === "order" && value) {
    lines.push({ key: "summaryOffOrder", vars: { value } });
  }
  if (bundlesShipping(draft)) {
    const over = amount(draft.freeShippingMinimum);
    if (!draft.freeShippingMinimum.trim()) lines.push({ key: "summaryPlusFreeShipping" });
    else if (over) lines.push({ key: "summaryPlusFreeShippingOver", vars: { value: over } });
  }
  if (draft.type === "shipping") {
    lines.push({ key: "summaryFreeShipping" });
  } else if (draft.type === "buy_get") {
    if (draft.buyScope.ids.length > 0) {
      const names = format.scope(draft.buyScope);
      const buyAmount = amount(draft.buyValue);
      const buyCount = count(draft.buyValue);
      if (draft.buyKind === "amount" && buyAmount) lines.push({ key: "summaryBuyAmount", vars: { value: buyAmount, names } });
      if (draft.buyKind === "quantity" && buyCount) {
        lines.push({ key: one(draft.buyValue) ? "summaryBuyOne" : "summaryBuyQuantity", vars: { count: buyCount, names } });
      }
    }
    const getCount = count(draft.getQuantity);
    const getPercent = percent(draft.getValue);
    if (draft.getScope.ids.length > 0 && getCount && (draft.getValueKind === "free" || getPercent)) {
      const names = format.scope(draft.getScope);
      const single = one(draft.getQuantity);
      lines.push(draft.getValueKind === "free"
        ? { key: single ? "summaryGetFreeOne" : "summaryGetFree", vars: { count: getCount, names } }
        : { key: single ? "summaryGetPercentOne" : "summaryGetPercent", vars: { count: getCount, names, value: getPercent! } });
      lines.push({ key: "summaryCustomerAdds", vars: { names } });
    }
    const uses = count(draft.usesPerOrder);
    if (draft.limitUsesPerOrder && uses) {
      lines.push({ key: one(draft.usesPerOrder) ? "summaryUsesPerOrderOne" : "summaryUsesPerOrder", vars: { count: uses } });
    }
  }
  if (draft.type !== "buy_get") {
    const minimumAmount = amount(draft.minimumValue);
    const minimumCount = count(draft.minimumValue);
    if (draft.minimum === "none") lines.push({ key: "summaryNoMinimum" });
    else if (draft.minimum === "amount" && minimumAmount) lines.push({ key: "summaryMinimumAmount", vars: { value: minimumAmount } });
    else if (draft.minimum === "quantity" && minimumCount) {
      lines.push({ key: one(draft.minimumValue) ? "summaryMinimumQuantityOne" : "summaryMinimumQuantity", vars: { count: minimumCount } });
    }
  }
  if (draft.method === "code") {
    const total = count(draft.totalUses, Number.MAX_SAFE_INTEGER);
    if (draft.limitTotal && total) lines.push({ key: one(draft.totalUses) ? "summaryTotalUsesOne" : "summaryTotalUses", vars: { count: total } });
    if (draft.oncePerCustomer) lines.push({ key: "summaryOncePerCustomer" });
    if (!draft.limitTotal && !draft.oncePerCustomer) lines.push({ key: "summaryNoLimits" });
  }
  const others = combinableClasses(draft).filter((item) => draft.combines[item]);
  lines.push(others.length > 0
    ? { key: others.length === 2 ? "summaryCombinesBoth" : `summaryCombines_${others[0]!}` }
    : { key: stacksWithOthers > 0 ? "summaryCombinesWhereAllowed" : "summaryNoCombine" });
  const start = storeTimeToEpoch(draft.startDate, draft.startTime);
  const end = draft.hasEnd ? storeTimeToEpoch(draft.endDate, draft.endTime) : null;
  if (start !== null) {
    lines.push(end !== null && end > start
      ? { key: "summaryActiveBetween", vars: { start: format.date(start), end: format.date(end) } }
      : { key: "summaryActiveFrom", vars: { start: format.date(start) } });
  }
  return lines;
}
