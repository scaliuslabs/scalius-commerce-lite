import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors.js";
import type { ConfigFile, CredentialsFile, ResolvedProfile, Runtime, StoredCredential } from "./types.js";

const MAX_CONFIG_BYTES = 10 * 1024 * 1024;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TOKEN = /^sc_(?:pat|cli)_(agc_[A-Za-z0-9_-]{20})_[A-Za-z0-9_-]{43}$/;

function emptyConfig(): ConfigFile {
  return { version: 1, profiles: {} };
}

function emptyCredentials(): CredentialsFile {
  return { version: 1, credentials: {} };
}

export function configDirectory(runtime: Runtime): string {
  const override = runtime.env.SCALIUS_CONFIG_HOME?.trim();
  if (override) return resolve(override);
  if (runtime.platform === "win32") {
    const appData = runtime.env.APPDATA?.trim();
    if (appData) return join(appData, "Scalius");
  }
  const xdg = runtime.env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(runtime.homedir(), ".config"), "scalius");
}

export function validateProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new CliError(2, "invalid_profile", "Profile names must use 1-80 letters, numbers, dots, dashes, or underscores.");
  }
  return name;
}

export function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(2, "invalid_server", "Server must be an absolute HTTPS origin.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CliError(2, "invalid_server", "Server must use HTTPS; HTTP is accepted only for localhost.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new CliError(2, "invalid_server", "Server must contain an origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

export function validateToken(value: string): string {
  const token = value.trim();
  if (!TOKEN.test(token)) {
    throw new CliError(3, "invalid_token", "Expected a Scalius personal or CLI credential.");
  }
  return token;
}

export function credentialIdFromToken(value: string): string {
  const token = validateToken(value);
  return TOKEN.exec(token)![1]!;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, { encoding: "utf8" });
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) {
      throw new CliError(8, "config_too_large", `Configuration file is larger than ${MAX_CONFIG_BYTES} bytes.`);
    }
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    if (error instanceof CliError) throw error;
    throw new CliError(8, "config_read_failed", `Unable to read ${path}.`);
  }
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await secureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    try {
      await chmod(path, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export class ConfigStore {
  readonly directory: string;
  readonly configPath: string;
  readonly credentialsPath: string;

  constructor(private readonly runtime: Runtime) {
    this.directory = configDirectory(runtime);
    this.configPath = join(this.directory, "config.json");
    this.credentialsPath = join(this.directory, "credentials.json");
  }

  loadConfig(): Promise<ConfigFile> {
    return readJson(this.configPath, emptyConfig());
  }

  loadCredentials(): Promise<CredentialsFile> {
    return readJson(this.credentialsPath, emptyCredentials());
  }

  saveConfig(config: ConfigFile): Promise<void> {
    return atomicJsonWrite(this.configPath, config);
  }

  saveCredentials(credentials: CredentialsFile): Promise<void> {
    return atomicJsonWrite(this.credentialsPath, credentials);
  }

  async putProfile(name: string, server: string, makeActive = true): Promise<void> {
    validateProfileName(name);
    const config = await this.loadConfig();
    config.profiles[name] = { server: normalizeServer(server) };
    if (makeActive || !config.activeProfile) config.activeProfile = name;
    await this.saveConfig(config);
  }

  async putCredential(name: string, credential: StoredCredential): Promise<void> {
    validateProfileName(name);
    credential.token = validateToken(credential.token);
    const credentials = await this.loadCredentials();
    credentials.credentials[name] = credential;
    await this.saveCredentials(credentials);
  }

  async removeCredential(name: string): Promise<boolean> {
    const credentials = await this.loadCredentials();
    const existed = name in credentials.credentials;
    delete credentials.credentials[name];
    await this.saveCredentials(credentials);
    return existed;
  }

  async resolveProfile(requested?: string, requireToken = true): Promise<ResolvedProfile> {
    const config = await this.loadConfig();
    const name = validateProfileName(requested ?? config.activeProfile ?? "default");
    const configured = config.profiles[name];
    const environmentServer = this.runtime.env.SCALIUS_SERVER?.trim();
    const server = configured?.server ?? (environmentServer ? normalizeServer(environmentServer) : undefined);
    if (!server) {
      throw new CliError(2, "profile_not_configured", `Profile '${name}' has no server. Authenticate first or set SCALIUS_SERVER.`);
    }
    const environmentToken = this.runtime.env.SCALIUS_TOKEN?.trim();
    if (environmentToken) {
      return { name, server, token: validateToken(environmentToken), tokenSource: "environment" };
    }
    const credentials = await this.loadCredentials();
    const credential = credentials.credentials[name];
    if (requireToken && !credential) {
      throw new CliError(3, "not_authenticated", `Profile '${name}' is not authenticated.`);
    }
    return {
      name,
      server,
      ...(credential ? { token: validateToken(credential.token), tokenSource: "disk" as const, credential } : {}),
    };
  }

  cachePath(profileName: string): string {
    const digest = createHash("sha256").update(profileName).digest("hex");
    return join(this.directory, "cache", `${digest}.openapi.json`);
  }
}

export async function writeAtomicOutput(
  path: string,
  body: ReadableStream<Uint8Array> | null,
  overwrite: boolean,
  limits: {
    maximumBytes: number;
    minimumBytes?: number;
    expectedBytes?: number;
  },
): Promise<number> {
  const minimumBytes = limits.minimumBytes ?? 0;
  if (
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes < 1 ||
    !Number.isSafeInteger(minimumBytes) ||
    minimumBytes < 0 ||
    minimumBytes > limits.maximumBytes ||
    (limits.expectedBytes !== undefined &&
      (!Number.isSafeInteger(limits.expectedBytes) ||
        limits.expectedBytes < minimumBytes ||
        limits.expectedBytes > limits.maximumBytes))
  ) {
    throw new CliError(8, "invalid_output_policy", "The output byte policy is invalid.");
  }
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let total = 0;
  try {
    handle = await open(temporary, "wx", 0o600);
    if (body) {
      const reader = body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > limits.maximumBytes) {
            throw new CliError(8, "artifact_too_large", `Artifact exceeds its ${limits.maximumBytes}-byte contract limit.`);
          }
          if (limits.expectedBytes !== undefined && total > limits.expectedBytes) {
            throw new CliError(8, "invalid_artifact_response", "Artifact bytes do not match Content-Length.");
          }
          await handle.writeFile(chunk.value);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    if (total < minimumBytes) {
      throw new CliError(8, "invalid_artifact_response", "Artifact response is empty.");
    }
    if (limits.expectedBytes !== undefined && total !== limits.expectedBytes) {
      throw new CliError(8, "invalid_artifact_response", "Artifact bytes do not match Content-Length.");
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!overwrite) {
      await link(temporary, destination).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new CliError(2, "output_exists", `Output file already exists: ${destination}`);
        }
        throw error;
      });
      await unlink(temporary);
      return total;
    }
    await rename(temporary, destination);
    return total;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
