// The app providers core may reach for SMS, email, the fraud check, tax,
// machine translation and AI drafting
// (`AppProviders`, @scalius/core/integrations/provider-port). Core asks only
// when the merchant's saved choice is an app id (`<plugin id>:<provider id>`),
// so a store on built-in providers reads no plugin table. One answer per id
// per request (or queue message): readiness and the send that follows share
// one installation read.
//
// An app answers only when it is installed, declares that provider, is
// active and approved for the port, can run here and has complete, readable
// settings. Anything else is the merchant-facing reason it cannot be used,
// and core fails closed on it.

import type { Database } from "@scalius/database/client";
import { deps } from "@scalius/core/cache-deps";
import type {
  AppProviderChoice,
  AppProviderKind,
  AppProviders,
  BoundProvider,
} from "@scalius/core/integrations/provider-port";
import { getPluginInstallation, type PluginInstallation } from "@scalius/core/modules/plugins";
import { parseQualifiedProviderId, type PluginProviderDeclaration } from "@scalius/shared/plugins/providers";
import { ValidationError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { appFraudProvider } from "./fraud";
import { appEmailProvider, appSmsProvider } from "./messaging";
import { appTaxProvider } from "./tax";
import { appTranslationProvider } from "./translation";
import { appAiProvider } from "./ai";
import {
  createAppProviderRuntime,
  readAppProviderSettings,
  requestProviderRuntime,
  type AppProviderRuntime,
  type RequestLike,
} from "./runtime";

type Adapter = (runtime: AppProviderRuntime, installation: PluginInstallation, declaration: PluginProviderDeclaration) => BoundProvider<AppProviderKind>;

const ADAPTERS: Record<AppProviderKind, Adapter> = {
  sms: appSmsProvider as Adapter,
  email: appEmailProvider as Adapter,
  fraud: appFraudProvider as Adapter,
  tax: appTaxProvider as Adapter,
  translation: appTranslationProvider as Adapter,
  ai: appAiProvider as Adapter,
};

const PORT_NAMES: Record<AppProviderKind, string> = { sms: "SMS", email: "email", fraud: "fraud check", tax: "tax", translation: "translation", ai: "AI" };

async function resolveChoice(
  runtime: AppProviderRuntime,
  encryptionKey: string | undefined,
  kind: AppProviderKind,
  id: string,
): Promise<AppProviderChoice<AppProviderKind>> {
  const notInstalled = { provider: null, issue: `The ${PORT_NAMES[kind]} app provider you chose is not installed. Choose another provider.` };
  const parsed = parseQualifiedProviderId(id);
  if (!parsed) return notInstalled;
  // Cached public output that depends on this answer (sign-in channels) follows the app's state.
  deps.plugin(parsed.pluginId);
  const installation = await getPluginInstallation(runtime.db, parsed.pluginId);
  const declaration = installation?.manifest.providers.find((provider) => provider.kind === kind && provider.id === parsed.providerId);
  if (!installation || !declaration) return notInstalled;
  const settings = await readAppProviderSettings(runtime, installation, declaration, encryptionKey);
  if (!settings.enabled || settings.missingFields.length > 0 || settings.credentialErrors.length > 0) {
    return { provider: null, issue: settings.blockedReason ?? `${declaration.name} is not ready.` };
  }
  return { provider: ADAPTERS[kind](runtime, installation, declaration), issue: null };
}

/**
 * Refuses a saved choice that names no installed app's provider of the port.
 * Readiness (active, approved, configured) is checked where it is used, so a
 * merchant may choose an app before finishing its setup.
 */
export async function assertAppProviderInstalled(db: Database, kind: AppProviderKind, id: string): Promise<void> {
  const parsed = parseQualifiedProviderId(id);
  const installation = parsed ? await getPluginInstallation(db, parsed.pluginId) : null;
  const declared = installation?.manifest.providers.some((provider) => provider.kind === kind && provider.id === parsed?.providerId);
  if (!declared) throw new ValidationError(`No installed app provides this ${PORT_NAMES[kind]} provider.`);
}

/** The app providers of one runtime; each id is resolved once. */
export function createAppProviders(runtime: AppProviderRuntime, encryptionKey: string | undefined): AppProviders {
  const resolved = new Map<string, Promise<AppProviderChoice<AppProviderKind>>>();
  return {
    resolve<K extends AppProviderKind>(kind: K, id: string): Promise<AppProviderChoice<K>> {
      const key = `${kind}\u0000${id}`;
      let choice = resolved.get(key);
      if (!choice) {
        choice = resolveChoice(runtime, encryptionKey, kind, id);
        resolved.set(key, choice);
      }
      return choice as Promise<AppProviderChoice<K>>;
    },
  };
}

const perRequest = new WeakMap<Request, AppProviders>();

/**
 * The app providers of one Hono request (one plugin host, one lookup per id).
 * Nothing is built until an app id is resolved: a request on built-in
 * providers only carries the handle.
 */
export function requestAppProviders(c: RequestLike): AppProviders {
  let providers = perRequest.get(c.req.raw);
  if (!providers) {
    let built: AppProviders | null = null;
    providers = {
      resolve(kind, id) {
        built ??= createAppProviders(requestProviderRuntime(c), getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>));
        return built.resolve(kind, id);
      },
    };
    perRequest.set(c.req.raw, providers);
  }
  return providers;
}

/**
 * For work outside a request (queue consumers, scheduled jobs): app
 * providers on a detached execution context, created without any read.
 * `encryptionKey` is the CREDENTIAL_ENCRYPTION_KEY the caller already read.
 */
export function detachedAppProviders(env: Env, db: Database, encryptionKey: string | undefined): AppProviders {
  return createAppProviders(createAppProviderRuntime({ env, db }), encryptionKey);
}
