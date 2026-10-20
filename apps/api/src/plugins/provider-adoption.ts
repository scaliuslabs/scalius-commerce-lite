// One switch makes an app's payment or SMS service work (QA round 1, m1).
//
//   payment  Turning a payment feature on adds its providers to the checkout's
//            payment methods, after the ones already there. Checkout offers a
//            method only while it is ready (`buildActivePaymentMethods`), so one
//            added before its keys are saved waits for them. Settings, Payments
//            stays the one place to reorder or hide methods: a method the
//            merchant hid is never added back until its feature is turned off
//            and on again.
//   sms      When no notification SMS service is chosen, the first ready SMS
//            provider becomes it: when its feature turns on with its keys
//            already saved, or when its keys are saved. A chosen service is
//            never replaced here.
//
// `providerUse` is the other half: how the app page says whether a running
// provider is actually used, so "Ready" never shows for one checkout skips.

import type { Database } from "@scalius/database/client";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import { getCurrencySettings, paymentMethodsDocument, smsDocument } from "@scalius/core/modules/settings";
import { SettingsRevisionConflictError } from "@scalius/core/settings-store";
import { pluginFeatureRequest } from "@scalius/shared/plugins";
import { qualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { createAppProviderRuntime, readAppProviderSettings, type AppProviderRuntime } from "./providers/runtime";

const ATTEMPTS = 3;

type Declaration = PluginInstallation["manifest"]["providers"][number];

/** The providers a feature brings, as the app declares them. */
function featureProviderIds(installation: PluginInstallation, feature: string): string[] {
  return pluginFeatureRequest(installation.declaredManifest, feature)?.providers.map((provider) => provider.id) ?? [];
}

/** Retries a read-modify-write on a settings document that moved meanwhile. */
async function withRevisionRetry(work: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await work();
      return;
    } catch (error) {
      if (!(error instanceof SettingsRevisionConflictError) || attempt >= ATTEMPTS) throw error;
    }
  }
}

/** Adds the turned-on features' payment providers to the checkout's methods (see the file comment). */
export async function offerTurnedOnPaymentProviders(
  db: Database,
  installation: PluginInstallation,
  turnedOn: readonly string[],
): Promise<void> {
  const ids = new Set(turnedOn.flatMap((feature) => featureProviderIds(installation, feature)));
  const methods = installation.manifest.providers
    .filter((provider) => provider.kind === "payment" && ids.has(provider.id))
    .map((provider) => qualifiedProviderId(installation.pluginId, provider.id));
  if (methods.length === 0) return;
  await withRevisionRetry(async () => {
    const stored = await paymentMethodsDocument.readDetailed(db, undefined, { skipCache: true });
    // An unreadable document is the merchant's to fix in Settings, Payments: never rewritten here.
    if (stored.invalid) return;
    // Never saved: cash on delivery is the implied method, and stays.
    const current = stored.value.enabledMethods ?? ["cod"];
    const added = methods.filter((method) => !current.includes(method));
    if (added.length === 0) return;
    await paymentMethodsDocument.write(db, {
      enabledMethods: [...current, ...added],
      defaultMethod: current.includes(stored.value.defaultMethod) ? stored.value.defaultMethod : (current[0] ?? "cod"),
    }, undefined, { expectedRevision: stored.revision });
  });
}

/** Whether a provider has every setting it needs and can run here (the readiness every send checks). */
async function providerReady(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: Declaration,
  encryptionKey: string | undefined,
): Promise<boolean> {
  const settings = await readAppProviderSettings(runtime, installation, declaration, encryptionKey);
  return settings.enabled && settings.missingFields.length === 0 && settings.credentialErrors.length === 0;
}

/** Chooses this app's first ready SMS provider as the notification SMS service when none is chosen. */
export async function chooseReadySmsProvider(
  db: Database,
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  encryptionKey: string | undefined,
): Promise<void> {
  if (installation.status !== "active") return;
  // The running manifest: only the SMS providers whose features are on.
  const candidates = installation.manifest.providers.filter((provider) => provider.kind === "sms");
  if (candidates.length === 0) return;
  const stored = await smsDocument.readDetailed(db, undefined, { skipCache: true });
  if (stored.invalid || stored.value.activeProvider.trim()) return;
  for (const declaration of candidates) {
    if (!(await providerReady(runtime, installation, declaration, encryptionKey))) continue;
    try {
      // The revision read above: a service chosen meanwhile wins.
      await smsDocument.write(db, { activeProvider: qualifiedProviderId(installation.pluginId, declaration.id) }, undefined, { expectedRevision: stored.revision });
    } catch (error) {
      if (!(error instanceof SettingsRevisionConflictError)) throw error;
    }
    return;
  }
}

/**
 * After features turn on or an app's keys are saved: its payment providers
 * join checkout and a ready SMS provider becomes the SMS service when none is
 * chosen. This is the one entry both lanes use: the lifecycle (`lifecycle.ts`:
 * activating an app and turning a feature on, whoever asks, the dashboard or an
 * agent operation) and the settings save. The change is already saved, so a
 * failure here only leaves the service unused, which its status then says.
 */
export async function putServicesToUse(
  context: { db: Database; env: Env; ctx?: ExecutionContext },
  installation: PluginInstallation,
  turnedOn: readonly string[],
): Promise<void> {
  try {
    if (turnedOn.length > 0) await offerTurnedOnPaymentProviders(context.db, installation, turnedOn);
    await chooseReadySmsProvider(
      context.db,
      createAppProviderRuntime({ env: context.env, db: context.db, ctx: context.ctx }),
      installation,
      getCredentialEncryptionKey(context.env as unknown as Record<string, unknown>),
    );
  } catch (error) {
    console.warn(`[Apps] ${installation.pluginId}: its services could not be put to use (${error instanceof Error ? error.name : "error"}).`);
  }
}

/**
 * Whether a running provider is used by the store, for its status on the app
 * page: a payment method checkout lists or the merchant hid (or that cannot
 * charge the store's currency), the chosen SMS service or another one. Other
 * kinds have no such choice (null).
 */
export type ProviderUse = "offered" | "hidden" | "currency" | "chosen" | "not_chosen" | null;

export async function providerUse(db: Database, installation: PluginInstallation): Promise<Map<string, ProviderUse>> {
  const running = installation.manifest.providers;
  const hasPayment = running.some((provider) => provider.kind === "payment");
  const hasSms = running.some((provider) => provider.kind === "sms");
  const [payments, currency, sms] = await Promise.all([
    hasPayment ? paymentMethodsDocument.readDetailed(db) : null,
    hasPayment ? getCurrencySettings(db) : null,
    hasSms ? smsDocument.readDetailed(db) : null,
  ]);
  const enabled = payments && !payments.invalid ? payments.value.enabledMethods ?? ["cod"] : [];
  const chosenSms = sms && !sms.invalid ? sms.value.activeProvider.trim() : "";
  return new Map(running.map((provider): [string, ProviderUse] => {
    const id = qualifiedProviderId(installation.pluginId, provider.id);
    if (provider.kind === "payment") {
      const charges = "chargeCurrencies" in provider ? provider.chargeCurrencies : "any";
      if (Array.isArray(charges) && currency && !charges.includes(currency.currencyCode)) return [id, "currency"];
      return [id, enabled.includes(id) ? "offered" : "hidden"];
    }
    if (provider.kind === "sms") return [id, chosenSms === id ? "chosen" : "not_chosen"];
    return [id, null];
  }));
}
