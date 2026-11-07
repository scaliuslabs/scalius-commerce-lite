import type { Database } from "@scalius/database/client";
import { sha256Hex as sha256 } from "@scalius/shared/hash";
import { deriveRuntimeSecret } from "@scalius/shared/runtime-secrets";
import { type PresentmentMoney } from "@scalius/shared/presentment";
import { storeAmountMinor } from "@scalius/shared/market-pricing";
import { courierRatesSchema, providerServesCountry, type CourierRatesInput } from "@scalius/shared/plugins/providers";
import { withCheckoutProviderDeadline } from "@scalius/shared/plugins/provider-deadline";
import type { WorkerCacheHint } from "@scalius/shared/worker-cache-hint";
import { courierFor, type CourierProvidersSource } from "./couriers/registry";
import type { ActiveDeliveryLocationRow } from "./location-validation";
import type { DeliveryRateRow } from "./zones";

export interface CalculatedRateOptions {
  couriers?: CourierProvidersSource;
  masterSecret?: string | null;
  cache?: WorkerCacheHint | null;
  credentialEncryptionKey?: string;
  /** Commit checks the signed cash-collection mode against final payment policy after pricing. */
  acceptQuotedCod?: boolean;
}

type RateProof = {
  methodId: string; service: string | null; amountMinor: number; currency: string;
  destHash: string; parcelHash: string; cod: boolean; exp: number;
};
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

async function signingKey(master: string): Promise<CryptoKey> {
  const secret = await deriveRuntimeSecret(master, "checkout-rate-quote");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signRate(proof: RateProof, key: CryptoKey): Promise<string> {
  const payload = encode(encoder.encode(JSON.stringify(proof)));
  return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))))}`;
}
async function readRate(token: string | null | undefined, key: CryptoKey, match: Omit<RateProof, "amountMinor" | "exp" | "service" | "cod"> & { cod?: boolean }, service: string | null): Promise<RateProof | null> {
  if (!token || token.length > 2048) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !await crypto.subtle.verify("HMAC", key, decode(parts[1]!), encoder.encode(parts[0]!))) return null;
    const proof = JSON.parse(new TextDecoder().decode(decode(parts[0]!))) as RateProof;
    if (typeof proof.cod !== "boolean" || !Number.isSafeInteger(proof.amountMinor) || proof.amountMinor < 0 || !Number.isSafeInteger(proof.exp)
      || proof.exp <= Math.floor(Date.now() / 1000) || proof.exp > Math.floor(Date.now() / 1000) + 900
      || (service !== null && proof.service !== service)
      || Object.entries(match).some(([name, value]) => proof[name as keyof RateProof] !== value)) return null;
    return proof;
  } catch { return null; }
}

/**
 * Quotes once per provider and parcel, at most three quotes and two seconds
 * total; no durable quote state. Each option quotes the parcel `parcelFor`
 * gives it (the lines its own fee prices, `deliveryOptionBaseLines`); an
 * option whose parcel is empty prices nothing and calls no carrier.
 */
export async function resolveCalculatedDeliveryRates(input: {
  db: Database;
  rows: readonly DeliveryRateRow[];
  request: CourierRatesInput;
  /** The parcel each option quotes; absent: `request.parcel` for every option. */
  parcelFor?: (row: DeliveryRateRow) => CourierRatesInput["parcel"];
  locationRows: readonly ActiveDeliveryLocationRow[];
  money: PresentmentMoney;
  token?: string | null;
  methodId?: string | null;
  options?: CalculatedRateOptions;
}): Promise<DeliveryRateRow[]> {
  if (!input.rows.some((row) => row.rateSource && row.rateSource !== "flat")) return [...input.rows];
  const { options = {}, request, money } = input;
  const key = options.masterSecret ? await signingKey(options.masterSecret) : null;
  const requestFor = (row: DeliveryRateRow): CourierRatesInput => input.parcelFor ? { ...request, parcel: input.parcelFor(row) } : request;
  const parcelHashOf = (rowRequest: CourierRatesInput) => sha256(JSON.stringify({ parcel: rowRequest.parcel, origin: rowRequest.origin }));
  const selected = input.rows.find((row) => row.id === input.methodId);
  if (key && input.token && selected?.rateSource && selected.rateSource !== "flat") {
    const destHash = await sha256(JSON.stringify({ destination: request.destination, provider: selected.rateSource, service: selected.rateService ?? null }));
    const parcelHash = await parcelHashOf(requestFor(selected));
    const locked = await readRate(input.token, key, { methodId: selected.id, currency: request.currency, destHash, parcelHash, ...(options.acceptQuotedCod ? {} : { cod: request.cod }) }, selected.rateService ?? null);
    // Commit consumes the chosen signed rate; it does not contact any carrier.
    if (locked) return input.rows.flatMap((row) => row.id === selected.id
      ? [{ ...row, feeMinor: locked.amountMinor, rateCurrency: request.currency, rateCod: locked.cod, rateToken: input.token! }]
      : !row.rateSource || row.rateSource === "flat" || row.kind === "pickup" ? [row] : []);
  }
  const locationExternalIds = new Map<string, Record<string, string | number>>();
  for (const row of input.locationRows) {
    try { locationExternalIds.set(row.id, JSON.parse(row.externalIds || "{}")); } catch { /* Unreadable mappings refuse this carrier's rate. */ }
  }
  const sign = async (row: DeliveryRateRow, parcelHash: string, amountMinor: number, service: string | null) => {
    const destHash = await sha256(JSON.stringify({ destination: request.destination, provider: row.rateSource, service: row.rateService ?? null }));
    const proof: RateProof = { methodId: row.id, service, amountMinor, currency: request.currency, destHash, parcelHash, cod: request.cod, exp: Math.floor(Date.now() / 1000) + 900 };
    return { ...row, feeMinor: amountMinor, rateCurrency: request.currency, rateCod: request.cod, rateToken: await signRate(proof, key!) };
  };
  const settled = new Map<string, DeliveryRateRow | null>();
  const pending = new Map<string, Promise<ReturnType<typeof courierRatesSchema.parse> | null>>();
  const quoted = await withCheckoutProviderDeadline(async (signal) => {
    return Promise.all(input.rows.map((row) => (async (): Promise<DeliveryRateRow | null> => {
      const provider = row.rateSource;
      if (!provider || provider === "flat" || row.kind === "pickup") return row;
      if (!key) return null;
      const rowRequest = requestFor(row);
      const parcelHash = await parcelHashOf(rowRequest);
      // Nothing for the carrier to price: every line has its own profile rate or ships free.
      if (input.parcelFor && rowRequest.parcel.lines.length === 0) return sign(row, parcelHash, 0, row.rateService ?? null);
      const quoteKey = `${provider}\u0000${parcelHash}`;
      let call = pending.get(quoteKey);
      if (!call && pending.size < 3) {
        call = (async () => {
          try {
            const courier = await courierFor(options.couriers, provider);
            if (!courier?.rates || !providerServesCountry(courier.countries, rowRequest.destination.country)) return null;
            const cacheKey = await sha256(JSON.stringify({ provider, request: rowRequest, mappings: [...locationExternalIds] }));
            const cached = await options.cache?.get(cacheKey).catch(() => null);
            if (cached) {
              try { return courierRatesSchema.parse(JSON.parse(cached)); } catch { /* A bad hint is a miss. */ }
            }
            const response = courierRatesSchema.parse(await courier.rates(rowRequest, { settings: null, signal, db: input.db, locationExternalIds }));
            await options.cache?.put(cacheKey, JSON.stringify(response)).catch(() => undefined);
            return response;
          } catch { return null; }
        })();
        pending.set(quoteKey, call);
      }
      const rates = (await call)?.rates ?? [];
      const chosen = row.rateService ? rates.find((rate) => rate.service === row.rateService)
        : rates.reduce<(typeof rates)[number] | undefined>((best, rate) => !best || rate.amountMinor < best.amountMinor ? rate : best, undefined);
      const amountMinor = chosen?.amountMinor ?? (row.fallbackFeeMinor == null ? null : storeAmountMinor(row.fallbackFeeMinor, { money, fx: null }, "fee"));
      if (amountMinor === null) return null;
      return sign(row, parcelHash, amountMinor, chosen?.service ?? row.rateService ?? null);
    })().then((result) => { settled.set(row.id, result); return result; })));
  }).catch(async () => Promise.all(input.rows.map(async (row): Promise<DeliveryRateRow | null> => {
    if (settled.has(row.id)) return settled.get(row.id)!;
    if (!row.rateSource || row.rateSource === "flat" || row.kind === "pickup") return row;
    if (!key || row.fallbackFeeMinor == null) return null;
    return sign(row, await parcelHashOf(requestFor(row)), storeAmountMinor(row.fallbackFeeMinor, { money, fx: null }, "fee"), row.rateService ?? null);
  })));
  return quoted.filter((row): row is DeliveryRateRow => row !== null);
}
