import { ConfigStore, validateProfileName } from "./config.js";
import { CliError } from "./errors.js";
import type { Runtime } from "./types.js";

export async function listProfiles(runtime: Runtime): Promise<Record<string, unknown>> {
  const store = new ConfigStore(runtime);
  const [config, credentials] = await Promise.all([store.loadConfig(), store.loadCredentials()]);
  const profiles = Object.entries(config.profiles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, profile]) => ({
      name,
      server: profile.server,
      active: config.activeProfile === name,
      authenticated: Boolean(credentials.credentials[name]) || Boolean(runtime.env.SCALIUS_TOKEN?.trim()),
    }));
  return { activeProfile: config.activeProfile ?? null, profiles };
}

export async function useProfile(runtime: Runtime, nameValue: string): Promise<Record<string, unknown>> {
  const store = new ConfigStore(runtime);
  const name = validateProfileName(nameValue);
  const config = await store.loadConfig();
  if (!config.profiles[name]) throw new CliError(2, "profile_not_found", `Profile '${name}' does not exist.`);
  config.activeProfile = name;
  await store.saveConfig(config);
  return { status: "active", profile: name, server: config.profiles[name].server };
}

export async function showProfile(runtime: Runtime, requested?: string): Promise<Record<string, unknown>> {
  const store = new ConfigStore(runtime);
  const profile = await store.resolveProfile(requested, false);
  return {
    profile: profile.name,
    server: profile.server,
    authenticated: Boolean(profile.token),
    credentialSource: profile.tokenSource ?? null,
    credentialId: profile.credential?.credentialId,
    expiresAt: profile.credential?.expiresAt,
  };
}
