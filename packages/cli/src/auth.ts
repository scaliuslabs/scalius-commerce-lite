import { once } from "node:events";
import { CliError } from "./errors.js";
import { ConfigStore, credentialIdFromToken, normalizeServer, validateProfileName, validateToken } from "./config.js";
import { bearerHeaders, fetchWithNetworkErrors, responseError } from "./http.js";
import { writeDiagnostic } from "./output.js";
import type { ResolvedProfile, Runtime, StoredCredential } from "./types.js";

interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

interface DeviceTokenResponse {
  status: "pending" | "approved";
  intervalSeconds?: number;
  token?: string;
  credentialId?: string;
  expiresAt?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(source: Record<string, unknown>, camel: string, snake: string): string | undefined {
  const value = source[camel] ?? source[snake];
  return typeof value === "string" ? value : undefined;
}

function numberField(source: Record<string, unknown>, camel: string, snake: string): number | undefined {
  const value = source[camel] ?? source[snake];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return object(await response.json());
  } catch {
    throw new CliError(8, "invalid_server_response", "Server returned an invalid JSON response.");
  }
}

async function postJson(runtime: Runtime, url: string, body: unknown, headers?: Headers): Promise<Response> {
  const requestHeaders = headers ?? new Headers({ Accept: "application/json" });
  requestHeaders.set("Content-Type", "application/json");
  return fetchWithNetworkErrors(runtime, url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

function parseStart(value: Record<string, unknown>): DeviceStartResponse {
  const deviceCode = stringField(value, "deviceCode", "device_code");
  const userCode = stringField(value, "userCode", "user_code");
  const verificationUri = stringField(value, "verificationUri", "verification_uri");
  const intervalSeconds = numberField(value, "intervalSeconds", "interval") ?? 5;
  const expiresInSeconds = numberField(value, "expiresInSeconds", "expires_in") ?? 600;
  if (!deviceCode || !userCode || !verificationUri) {
    throw new CliError(8, "invalid_server_response", "Pairing response is missing required fields.");
  }
  let verificationUrl: URL;
  try {
    verificationUrl = new URL(verificationUri);
  } catch {
    throw new CliError(8, "invalid_server_response", "Pairing response contains an invalid verification URL.");
  }
  if (verificationUrl.protocol !== "https:" && !(verificationUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(verificationUrl.hostname))) {
    throw new CliError(8, "invalid_server_response", "Pairing verification URL must use HTTPS.");
  }
  if (verificationUrl.username || verificationUrl.password || verificationUrl.search || verificationUrl.hash) {
    throw new CliError(8, "invalid_server_response", "Pairing verification URL must not contain credentials, query, or fragment.");
  }
  if (intervalSeconds < 1 || intervalSeconds > 60 || expiresInSeconds < 30 || expiresInSeconds > 3_600) {
    throw new CliError(8, "invalid_server_response", "Pairing response contains invalid timing limits.");
  }
  return { deviceCode, userCode, verificationUri: verificationUrl.toString(), intervalSeconds, expiresInSeconds };
}

function parseToken(value: Record<string, unknown>): DeviceTokenResponse {
  const rawStatus = value.status;
  const status = rawStatus === "approved" ? "approved" : "pending";
  return {
    status,
    intervalSeconds: numberField(value, "intervalSeconds", "interval"),
    token: stringField(value, "token", "access_token"),
    credentialId: stringField(value, "credentialId", "credential_id"),
    expiresAt: stringField(value, "expiresAt", "expires_at"),
  };
}

async function acknowledge(runtime: Runtime, profile: ResolvedProfile, deviceCode: string): Promise<void> {
  let lastError: CliError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await postJson(runtime, `${profile.server}/api/v1/agent-auth/device/ack`, { deviceCode });
      if (response.ok) return;
      lastError = await responseError(response, "Unable to acknowledge the paired credential.");
      if (lastError.exitCode !== 7) break;
    } catch (error) {
      lastError = error instanceof CliError ? error : new CliError(7, "network_error", "Unable to acknowledge the paired credential.");
      if (lastError.exitCode !== 7) break;
    }
    await runtime.sleep(500 * (attempt + 1));
  }
  throw lastError ?? new CliError(7, "acknowledgement_failed", "Unable to acknowledge the paired credential.");
}

export interface LoginOptions {
  server: string;
  profileName: string;
  openBrowser: boolean;
}

export async function login(runtime: Runtime, options: LoginOptions): Promise<Record<string, unknown>> {
  const store = new ConfigStore(runtime);
  const name = validateProfileName(options.profileName);
  const server = normalizeServer(options.server);
  const existing = await store.resolveProfile(name, false).catch(() => undefined);
  if (existing?.server === server && existing.credential?.pendingAcknowledgement) {
    try {
      await acknowledge(runtime, existing, existing.credential.pendingAcknowledgement.deviceCode);
      const recovered = { ...existing.credential };
      delete recovered.pendingAcknowledgement;
      await store.putCredential(name, recovered);
      return {
        status: "authenticated",
        profile: name,
        server,
        credentialId: recovered.credentialId,
        expiresAt: recovered.expiresAt,
        recoveredAcknowledgement: true,
      };
    } catch (error) {
      const cliError = error instanceof CliError ? error : undefined;
      if (cliError && cliError.exitCode !== 7) throw cliError;
      writeDiagnostic(runtime, "A saved credential still awaits acknowledgement; starting a new pairing attempt.");
    }
  }
  const response = await postJson(runtime, `${server}/api/v1/agent-auth/device/start`, {
    clientName: "Scalius CLI",
    profileName: name,
  });
  if (!response.ok) throw await responseError(response, "Unable to start dashboard pairing.");
  const start = parseStart(await parseJson(response));
  await store.putProfile(name, server);

  writeDiagnostic(runtime, `Open ${start.verificationUri}`);
  writeDiagnostic(runtime, `Enter code: ${start.userCode}`);
  if (options.openBrowser) {
    try {
      await runtime.openUrl(start.verificationUri);
    } catch {
      writeDiagnostic(runtime, "The browser could not be opened. Use the URL above from any browser.");
    }
  }

  const deadline = runtime.now() + start.expiresInSeconds * 1_000;
  let interval = start.intervalSeconds;
  while (runtime.now() < deadline) {
    await runtime.sleep(interval * 1_000);
    const tokenResponse = await postJson(runtime, `${server}/api/v1/agent-auth/device/token`, { deviceCode: start.deviceCode });
    if (tokenResponse.status === 202) {
      const pending = parseToken(await parseJson(tokenResponse));
      interval = Math.max(interval, pending.intervalSeconds ?? interval);
      continue;
    }
    if (tokenResponse.status === 429) {
      interval = Math.min(60, interval + 5);
      continue;
    }
    if (!tokenResponse.ok) {
      const failure = await responseError(tokenResponse, "Dashboard pairing failed.");
      if (tokenResponse.status >= 400 && tokenResponse.status < 500 && tokenResponse.status !== 429) {
        throw new CliError(3, failure.errorCode, failure.message, failure.details);
      }
      throw failure;
    }
    const approved = parseToken(await parseJson(tokenResponse));
    if (approved.status !== "approved" || !approved.token) {
      throw new CliError(8, "invalid_server_response", "Approved pairing response did not contain a credential.");
    }
    const approvedToken = validateToken(approved.token);
    const derivedCredentialId = credentialIdFromToken(approvedToken);
    if (approved.credentialId && approved.credentialId !== derivedCredentialId) {
      throw new CliError(8, "invalid_server_response", "Paired credential metadata does not match its token.");
    }
    if (approved.expiresAt && !Number.isFinite(Date.parse(approved.expiresAt))) {
      throw new CliError(8, "invalid_server_response", "Paired credential has an invalid expiry.");
    }
    const credential: StoredCredential = {
      token: approvedToken,
      createdAt: new Date(runtime.now()).toISOString(),
      credentialId: derivedCredentialId,
      expiresAt: approved.expiresAt,
      pendingAcknowledgement: { deviceCode: start.deviceCode },
    };
    await store.putCredential(name, credential);
    const profile: ResolvedProfile = { name, server, token: credential.token, tokenSource: "disk", credential };
    await acknowledge(runtime, profile, start.deviceCode);
    delete credential.pendingAcknowledgement;
    await store.putCredential(name, credential);
    return {
      status: "authenticated",
      profile: name,
      server,
      credentialId: derivedCredentialId,
      expiresAt: approved.expiresAt,
    };
  }
  throw new CliError(3, "pairing_expired", "Dashboard pairing expired before approval.");
}

async function readNonTtySecret(runtime: Runtime): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of runtime.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.byteLength;
    if (size > 4_096) throw new CliError(3, "invalid_token", "Credential input is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readTtySecret(runtime: Runtime): Promise<string> {
  if (!runtime.stdin.setRawMode) throw new CliError(3, "secret_input_unavailable", "Unable to read a hidden credential from this terminal.");
  runtime.stderr.write("Credential: ");
  runtime.stdin.setRawMode(true);
  runtime.stdin.resume();
  let value = "";
  try {
    while (true) {
      const [chunk] = await once(runtime.stdin, "data") as [Buffer | string];
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003") throw new CliError(130, "interrupted", "Operation interrupted.");
        if (character === "\r" || character === "\n") {
          runtime.stderr.write("\n");
          return value;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    }
  } finally {
    runtime.stdin.setRawMode(false);
    runtime.stdin.pause();
  }
}

export async function importToken(runtime: Runtime, serverValue: string, profileName: string): Promise<Record<string, unknown>> {
  const store = new ConfigStore(runtime);
  const name = validateProfileName(profileName);
  const server = normalizeServer(serverValue);
  const environmentToken = runtime.env.SCALIUS_TOKEN?.trim();
  if (environmentToken) {
    validateToken(environmentToken);
    await store.putProfile(name, server);
    return { status: "authenticated", profile: name, server, source: "environment", persisted: false };
  }
  const raw = runtime.stdin.isTTY ? await readTtySecret(runtime) : await readNonTtySecret(runtime);
  const token = validateToken(raw);
  const credentialId = credentialIdFromToken(token);
  await store.putProfile(name, server);
  await store.putCredential(name, {
    token,
    credentialId,
    createdAt: new Date(runtime.now()).toISOString(),
  });
  return { status: "authenticated", profile: name, server, source: "disk", persisted: true, credentialId };
}

export async function authStatus(runtime: Runtime, profileName?: string): Promise<Record<string, unknown>> {
  const store = new ConfigStore(runtime);
  const profile = await store.resolveProfile(profileName, false);
  if (profile.credential?.pendingAcknowledgement) {
    await acknowledge(runtime, profile, profile.credential.pendingAcknowledgement.deviceCode);
    const credential = { ...profile.credential };
    delete credential.pendingAcknowledgement;
    await store.putCredential(profile.name, credential);
    profile.credential = credential;
  }
  const expiresAt = profile.credential?.expiresAt;
  const expired = expiresAt ? Date.parse(expiresAt) <= runtime.now() : false;
  return {
    profile: profile.name,
    server: profile.server,
    authenticated: Boolean(profile.token) && !expired,
    source: profile.tokenSource ?? null,
    credentialId: profile.credential?.credentialId,
    expiresAt,
    expired,
  };
}

export async function logout(runtime: Runtime, profileName?: string): Promise<Record<string, unknown>> {
  const store = new ConfigStore(runtime);
  const profile = await store.resolveProfile(profileName, false);
  const removed = await store.removeCredential(profile.name);
  return {
    status: "logged_out",
    profile: profile.name,
    removedDiskCredential: removed,
    environmentCredentialStillConfigured: Boolean(runtime.env.SCALIUS_TOKEN?.trim()),
  };
}

export async function revoke(runtime: Runtime, profileName?: string): Promise<Record<string, unknown>> {
  const store = new ConfigStore(runtime);
  const profile = await store.resolveProfile(profileName, true);
  const response = await postJson(runtime, `${profile.server}/api/v1/agent-auth/revoke`, {}, bearerHeaders(profile.token!));
  if (!response.ok) throw await responseError(response, "Unable to revoke the credential.");
  if (profile.tokenSource === "disk") await store.removeCredential(profile.name);
  return {
    status: "revoked",
    profile: profile.name,
    environmentCredentialMustBeUnset: profile.tokenSource === "environment",
  };
}
