// An app's services on its page, as data: each feature (turned on by itself)
// and each provider no feature owns (on with the app), grouped by the kind of
// service they give (Shopify's payment providers card, one card per kind).
// A group with a recommended feature comes first, so a new merchant meets
// the suggestion before the rest. Pure: the page draws these.
import type { AppDetail, AppFeature } from "~/lib/api-query-options/apps";
import { providerConfigured } from "./app-settings-draft";

export const SERVICE_GROUPS = ["payment", "courier", "sms", "fraud", "other"] as const;
export type ServiceGroup = (typeof SERVICE_GROUPS)[number];

type Provider = AppDetail["providers"][number];

/** One row of a group card: a feature with its switch, or a provider that runs with the app. */
export type ServiceItem =
  | { kind: "feature"; id: string; feature: AppFeature }
  | { kind: "provider"; id: string; provider: Provider };

function groupOf(kind: string | undefined): ServiceGroup {
  return kind === "payment" || kind === "courier" || kind === "sms" || kind === "fraud" ? kind : "other";
}

/** The group a feature belongs to: the kind of its first provider. */
export function featureGroup(feature: Pick<AppFeature, "request">): ServiceGroup {
  return groupOf(feature.request.providers[0]?.kind);
}

/**
 * Every feature and every provider no feature owns, by group in
 * `SERVICE_GROUPS` order, except that groups with a recommended feature come
 * first; within a group, recommended features lead.
 */
export function serviceGroups(app: Pick<AppDetail, "features" | "providers">): Array<{ group: ServiceGroup; items: ServiceItem[] }> {
  const owned = new Set(app.features.flatMap((feature) => feature.request.providers.map((provider) => provider.id)));
  const items: Array<{ group: ServiceGroup; recommended: boolean; item: ServiceItem }> = [
    ...app.features.map((feature) => ({
      group: featureGroup(feature),
      recommended: feature.recommended,
      item: { kind: "feature" as const, id: `feature:${feature.id}`, feature },
    })),
    ...app.providers
      .filter((provider) => !owned.has(provider.id))
      .map((provider) => ({ group: groupOf(provider.kind), recommended: false, item: { kind: "provider" as const, id: `provider:${provider.id}`, provider } })),
  ];
  const groups = SERVICE_GROUPS
    .map((group) => {
      const members = items.filter((entry) => entry.group === group);
      return {
        group,
        recommended: members.some((entry) => entry.recommended),
        items: [...members].sort((left, right) => Number(right.recommended) - Number(left.recommended)).map((entry) => entry.item),
      };
    })
    .filter((entry) => entry.items.length > 0);
  return [...groups.filter((entry) => entry.recommended), ...groups.filter((entry) => !entry.recommended)]
    .map(({ group, items: members }) => ({ group, items: members }));
}

/** A feature's providers as the app lists them while it is on (with their settings and readiness). */
export function featureProviders(app: Pick<AppDetail, "providers">, feature: AppFeature): Provider[] {
  const ids = new Set(feature.request.providers.map((provider) => provider.id));
  return app.providers.filter((provider) => ids.has(provider.id));
}

/** A provider's own fields (one that uses the app's general settings has none of its own). */
function ownKeys(provider: Provider): string[] {
  return provider.own ? provider.settings : [];
}

/**
 * The settings keys to show with a row, in the app's field order: a
 * feature's own fields and its providers', or a provider's own. Only while it
 * runs (the app lists only those fields).
 */
export function itemSettingKeys(app: Pick<AppDetail, "settings" | "providers">, item: ServiceItem): string[] {
  const keys = new Set(item.kind === "feature"
    ? [...item.feature.settings, ...featureProviders(app, item.feature).flatMap(ownKeys)]
    : ownKeys(item.provider));
  return app.settings.fields.filter((field) => keys.has(field.key)).map((field) => field.key);
}

/** Every key a feature or provider row shows: the rest are the app's own settings. */
export function serviceSettingKeys(app: Pick<AppDetail, "features" | "providers">): Set<string> {
  return new Set([...app.features.flatMap((feature) => feature.settings), ...app.providers.flatMap(ownKeys)]);
}

/**
 * How a running service is doing. "Ready" means it works: a payment method
 * checkout offers, the SMS service notifications send through, and, for a
 * provider with a connection test, one that passed with its current keys
 * ("Set up (not tested)" until then). Set up but not used says why: hidden in
 * Settings, Payments, a currency it cannot charge, or another SMS service.
 */
export type ServiceHealth =
  | { status: "ready" }
  | { status: "setup"; missing: number }
  | { status: "error"; error: string; at: string | null }
  | { status: "testFailed"; error: string; at: string | null }
  | { status: "hidden" }
  | { status: "currency" }
  | { status: "notChosen" }
  | { status: "untested" }
  | null;

export type ServiceHealthStatus = NonNullable<ServiceHealth>["status"];

/** Each status's badge, and how urgent it is (lower first): not working, needs setup, set up but unused or untested, ready. */
export const SERVICE_HEALTH: Readonly<Record<ServiceHealthStatus, { variant: "success" | "warning" | "attention" | "destructive" | "secondary"; rank: number }>> = {
  error: { variant: "destructive", rank: 0 },
  testFailed: { variant: "destructive", rank: 0 },
  setup: { variant: "warning", rank: 1 },
  currency: { variant: "warning", rank: 1 },
  untested: { variant: "attention", rank: 2 },
  hidden: { variant: "secondary", rank: 2 },
  notChosen: { variant: "secondary", rank: 2 },
  ready: { variant: "success", rank: 3 },
};

/** Whether the store uses a set-up provider, in `ServiceHealth` terms (null: it does). */
export function unusedHealth(provider: Pick<Provider, "use">): ServiceHealth {
  switch (provider.use) {
    case "hidden": return { status: "hidden" };
    case "currency": return { status: "currency" };
    case "not_chosen": return { status: "notChosen" };
    default: return null;
  }
}

/** A set-up provider's connection test, in `ServiceHealth` terms (null: passed, or it offers none). */
function connectionHealth(provider: Partial<Pick<Provider, "connection">>): ServiceHealth {
  const { connection } = provider;
  if (!connection) return null;
  if (connection.status === "failed") return { status: "testFailed", error: connection.message ?? "", at: connection.testedAt };
  return connection.status === "untested" ? { status: "untested" } : null;
}

/**
 * How a running row is doing, from what the app reports: a scheduled job of
 * its own that failed last time, else whether its providers have every
 * required setting, a failed connection test, whether the store uses them
 * (`use`), and whether a test passed. Null while off, and for a feature with
 * nothing to check. Nothing here calls a provider: tests run on request.
 */
export function serviceHealth(app: Pick<AppDetail, "providers" | "cron" | "settings">, item: ServiceItem): ServiceHealth {
  const on = item.kind === "provider" || item.feature.enabled;
  if (!on) return null;
  const jobs = item.kind === "feature" ? app.cron.filter((job) => item.feature.request.cron.includes(job.name)) : [];
  const failed = jobs.find((job) => job.lastRun?.status === "failed");
  if (failed?.lastRun) return { status: "error", error: failed.lastRun.error ?? "", at: failed.lastRun.finishedAt ?? failed.lastRun.scheduledFor };
  const providers = item.kind === "feature" ? featureProviders(app, item.feature) : [item.provider];
  if (providers.length === 0) return null;
  const missing = providers.flatMap((provider) => provider.required).filter((key) => !providerConfigured(app, { required: [key] })).length;
  if (missing > 0) return { status: "setup", missing };
  const connections = providers.map(connectionHealth);
  return connections.find((health) => health?.status === "testFailed")
    ?? providers.map(unusedHealth).find(Boolean)
    ?? connections.find(Boolean)
    ?? { status: "ready" };
}

/** The newest finished run of a feature's own jobs, for its "Last ran" line. */
export function lastJobRun(app: Pick<AppDetail, "cron">, feature: AppFeature): string | null {
  const times = app.cron
    .filter((job) => feature.request.cron.includes(job.name) && job.lastRun?.status === "succeeded")
    .map((job) => job.lastRun!.finishedAt ?? job.lastRun!.scheduledFor)
    .sort();
  return times.at(-1) ?? null;
}
