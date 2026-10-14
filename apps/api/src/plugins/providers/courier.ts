// App couriers as delivery couriers. Delivery code calls every courier
// through one interface (core delivery/couriers/port.ts); this adapter is the
// only place an app's courier port is reached: each operation the app
// declares runs through the plugin host (bundled on Workers Free, the
// sandbox on Workers Paid) with the port's input and output validated there.
//
// A merchant uses an app courier through a delivery provider row whose type
// is `<plugin id>:<provider id>`; the row carries no credentials, the app's
// own settings do (read strictly; unreadable secrets fail closed). Failures
// stay the port's `ProviderError`, which delivery code reads: a certain
// refusal fails the booking, an uncertain one keeps it for reconciliation.
// A request the port would refuse is refused here first, as a certain
// failure: it never reaches the app.
//
// A courier that books by its own location ids (`locations` in its manifest
// entry) gets them here: the platform reads them from the store's places
// (`externalIds.<key>`), refuses a booking missing a required one before the
// shipment row is written (`preflight`), and passes them in the recipient.

import type { Database } from "@scalius/database/client";
import {
  NO_APP_COURIER_PROVIDERS,
  createCourierProviders,
  getDeliveryProviderReadinessSummary,
  getExternalLocationIds,
  isPositiveIntegerExternalLocationId,
  type Courier,
  type CourierProviders,
  type CourierProvidersSource,
  type DeliveryProviderActivationBlocker,
} from "@scalius/core/modules/delivery";
import { listActiveProviderPlugins, type PluginInstallation } from "@scalius/core/modules/plugins";
import {
  declaredProviderOperations,
  ProviderError,
  providerOperationSchemas,
  qualifiedProviderId,
  type CourierProviderDescriptor,
  type CourierShipmentInput,
  type ProviderOperation,
  type ProviderOperationInput,
  type ProviderOperationOutput,
} from "@scalius/shared/plugins/providers";
import {
  readAppProviderSettings,
  requestProviderRuntime,
  withSignal,
  type AppProviderRuntime,
  type AppProviderSettings,
  type RequestLike,
} from "./runtime";

type CourierDeclaration = { kind: "courier" } & CourierProviderDescriptor;

const clip = (value: string, max: number) => value.slice(0, max);
const clipOrNull = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

/**
 * A booking within the port's text bounds: order data the store accepts can
 * be longer than a courier needs (a long item list), and the app receives no
 * more than the port promises.
 */
function fitShipmentInput(input: CourierShipmentInput): CourierShipmentInput {
  const { recipient } = input;
  return {
    ...input,
    recipient: {
      ...recipient,
      name: clip(recipient.name, 200),
      phone: clip(recipient.phone, 40),
      address: clip(recipient.address, 2000),
      cityId: clipOrNull(recipient.cityId, 128),
      zoneId: clipOrNull(recipient.zoneId, 128),
      areaId: clipOrNull(recipient.areaId, 128),
      cityName: clipOrNull(recipient.cityName, 200),
      zoneName: clipOrNull(recipient.zoneName, 200),
      areaName: clipOrNull(recipient.areaName, 200),
      postalCode: clipOrNull(recipient.postalCode, 40),
    },
    note: clipOrNull(input.note, 1000),
    itemDescription: clipOrNull(input.itemDescription, 500),
  };
}

/** What keeps an app courier's rows from shipping, in the merchant's words. */
function appSetupBlockers(appName: string, settings: AppProviderSettings): DeliveryProviderActivationBlocker[] {
  const blockers: DeliveryProviderActivationBlocker[] = [
    ...settings.credentialErrors.map((message) => ({ source: "credentials" as const, key: "credentials", label: "Credentials", message })),
    ...settings.missingFields.map((key) => ({
      source: "config" as const,
      key: `settings.${key}`,
      label: key,
      message: `Complete ${appName}'s settings: ${key}.`,
    })),
  ];
  if (!settings.enabled) {
    blockers.push({
      source: "config",
      key: "app",
      label: appName,
      message: blockers.length === 0 && settings.blockedReason
        ? settings.blockedReason
        : `${appName} must be active and approved to deliver orders.`,
    });
  }
  return blockers;
}

type CourierLocations = NonNullable<CourierDeclaration["locations"]>;
type LocationLevel = "city" | "zone" | "area";
const LEVEL_IDS: Record<LocationLevel, "cityId" | "zoneId" | "areaId"> = { city: "cityId", zone: "zoneId", area: "areaId" };

/**
 * The courier's ids of the recipient's places, or why a booking cannot be
 * made: a required level missing from the address, or a place without the
 * courier's id. One read per level the address names.
 */
async function courierLocationIds(
  db: Database,
  courierName: string,
  locations: CourierLocations,
  recipient: CourierShipmentInput["recipient"],
): Promise<{ ids: NonNullable<CourierShipmentInput["recipient"]["locationIds"]> } | { refusal: string }> {
  const absent = locations.required.filter((level) => !recipient[LEVEL_IDS[level]]);
  if (absent.length > 0) return { refusal: `Missing required location information: ${absent.join(", ")}` };
  const found = await getExternalLocationIds(db, {
    ...(recipient.cityId ? { city: recipient.cityId } : {}),
    ...(recipient.zoneId ? { zone: recipient.zoneId } : {}),
    area: recipient.areaId,
  }, locations.key);
  const usable = (value: string | number | null | undefined) => (locations.numeric
    ? isPositiveIntegerExternalLocationId(value)
    : (typeof value === "string" && value.trim() !== "") || typeof value === "number");
  const ids = {
    city: usable(found.city) ? String(found.city).trim() : null,
    zone: usable(found.zone) ? String(found.zone).trim() : null,
    area: usable(found.area) ? String(found.area).trim() : null,
  };
  const missing = locations.required.filter((level) => ids[level] === null);
  return missing.length === 0
    ? { ids }
    : { refusal: `${courierName} requires mapped${locations.numeric ? " numeric" : ""} location IDs before shipment creation. Missing mapping for: ${missing.join(", ")}. Configure ${courierName} IDs in Delivery Locations settings.` };
}

/** One app courier as a delivery courier. */
export function appCourier(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: CourierDeclaration,
): Courier<AppProviderSettings> {
  const operations = new Set(declaredProviderOperations(declaration));
  const settingsByKey = new Map<string, Promise<AppProviderSettings>>();
  const readSettings = (encryptionKey: string | undefined) => {
    const key = encryptionKey ?? "";
    let read = settingsByKey.get(key);
    if (!read) {
      read = readAppProviderSettings(runtime, installation, declaration, encryptionKey);
      settingsByKey.set(key, read);
    }
    return read;
  };
  const invoke = async <M extends ProviderOperation<"courier">>(
    operation: M,
    input: ProviderOperationInput<"courier", M>,
    signal: AbortSignal | undefined,
  ): Promise<ProviderOperationOutput<"courier", M>> => {
    if (!providerOperationSchemas("courier", operation)!.input.safeParse(input).success) {
      throw new ProviderError("declined", `${declaration.name} cannot take this request.`, { code: "provider.invalid_request" });
    }
    const host = await runtime.host();
    return withSignal(host.invokeProvider(installation, "courier", declaration.id, operation, input), signal);
  };

  const courier: Courier<AppProviderSettings> = {
    id: qualifiedProviderId(installation.pluginId, declaration.id),
    label: declaration.name,
    countries: declaration.kind === "courier" ? declaration.countries : "any",
    ...(declaration.locations ? { requiredLocations: declaration.locations.required } : {}),

    // Read once per request and key: readiness, settings pages and every call share it.
    async setup(provider, encryptionKey) {
      const settings = await readSettings(encryptionKey);
      const readiness = getDeliveryProviderReadinessSummary({
        type: provider.type,
        activationBlockers: appSetupBlockers(installation.manifest.name, settings),
        isActive: provider.isActive,
        lastTestAttemptAt: provider.lastTestAttemptAt,
        lastTestSuccessAt: provider.lastTestSuccessAt,
        lastTestFailureAt: provider.lastTestFailureAt,
      });
      const error = settings.credentialErrors[0];
      return error
        ? { settings: null, error, unreadable: true, readiness }
        : { settings, readiness };
    },

    async createShipment(input, { signal, db }) {
      const locations = declaration.locations;
      if (!locations) return invoke("createShipment", fitShipmentInput(input), signal);
      const read = await courierLocationIds(db, declaration.name, locations, input.recipient);
      if ("refusal" in read) throw new ProviderError("declined", read.refusal, { code: "courier.locations" });
      return invoke("createShipment", fitShipmentInput({ ...input, recipient: { ...input.recipient, locationIds: read.ids } }), signal);
    },
    trackShipment: (input, { signal }) => invoke("trackShipment", input, signal),
  };

  const locations = declaration.locations;
  if (locations) {
    // Before a shipment row is written: a booking the courier cannot place is refused without a trace.
    courier.preflight = async (recipient, db) => {
      const read = await courierLocationIds(db, declaration.name, locations, recipient);
      return "refusal" in read ? read.refusal : null;
    };
  }

  if (operations.has("findShipment")) courier.findShipment = (input, { signal }) => invoke("findShipment", input, signal);
  if (operations.has("cancelShipment")) courier.cancelShipment = (input, { signal }) => invoke("cancelShipment", input, signal);
  if (operations.has("quote")) courier.quote = (input, { signal }) => invoke("quote", input, signal);
  if (operations.has("verifyWebhook")) courier.verifyWebhook = (input, { signal }) => invoke("verifyWebhook", input, signal);
  if (operations.has("reconcileCod")) courier.reconcileCod = (input, { signal }) => invoke("reconcileCod", input, signal);
  if (operations.has("testConnection")) courier.testConnection = (input, { signal }) => invoke("testConnection", input, signal);
  const trackingPage = declaration.trackingUrl;
  if (trackingPage) courier.trackingUrl = (trackingId) => trackingPage.split("{trackingId}").join(encodeURIComponent(trackingId));
  return courier;
}

/** Every courier these installations declare. */
export function appCouriers(runtime: AppProviderRuntime, installations: readonly PluginInstallation[]): Courier[] {
  const couriers: Courier[] = [];
  for (const installation of installations) {
    for (const declaration of installation.manifest.providers) {
      if (declaration.kind === "courier") couriers.push(appCourier(runtime, installation, declaration));
    }
  }
  return couriers;
}

/** The couriers a runtime can use, reading the active courier apps (one indexed read). */
export async function loadCourierProviders(runtime: AppProviderRuntime): Promise<CourierProviders> {
  const installations = await listActiveProviderPlugins(runtime.db, "courier");
  return installations.length === 0 ? NO_APP_COURIER_PROVIDERS : createCourierProviders(appCouriers(runtime, installations));
}

const perRequest = new WeakMap<Request, Promise<CourierProviders>>();

/**
 * The couriers one request can use, as a lazy source: delivery code calls it
 * only for a row that names an app courier, so
 * other work reads no plugin table. Read at most once per request.
 */
export function requestCourierProviders(c: RequestLike): CourierProvidersSource {
  return () => {
    let providers = perRequest.get(c.req.raw);
    if (!providers) {
      providers = loadCourierProviders(requestProviderRuntime(c));
      perRequest.set(c.req.raw, providers);
    }
    return providers;
  };
}
