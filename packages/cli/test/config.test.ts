import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, configDirectory, normalizeServer, validateToken, writeAtomicOutput } from "../src/config.js";
import { CliError } from "../src/errors.js";
import { createTestRuntime, validToken } from "./helpers.js";

describe("configuration", () => {
  it("uses SCALIUS_CONFIG_HOME and stores credentials securely without leaking into config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-cli-"));
    const runtime = createTestRuntime({ directory });
    const store = new ConfigStore(runtime);
    const token = validToken();
    await store.putProfile("work", "https://api.example.com");
    await store.putCredential("work", { token, createdAt: "2026-08-13T00:00:00.000Z" });

    expect(configDirectory(runtime)).toBe(directory);
    const config = await readFile(store.configPath, "utf8");
    const credentials = await readFile(store.credentialsPath, "utf8");
    expect(config).not.toContain(token);
    expect(credentials).toContain(token);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.credentialsPath)).mode & 0o777).toBe(0o600);
  });

  it("accepts the exact credential grammar and rejects prefixes or malformed IDs", () => {
    expect(validateToken(validToken("pat"))).toBe(validToken("pat"));
    expect(() => validateToken(`scl_pat_agc_${"A".repeat(20)}_${"B".repeat(43)}`)).toThrow(CliError);
    expect(() => validateToken(`sc_pat_bad_${"A".repeat(20)}_${"B".repeat(43)}`)).toThrow(CliError);
    expect(() => validateToken(`sc_pat_agc_${"A".repeat(19)}_${"B".repeat(43)}`)).toThrow(CliError);
    expect(() => validateToken(`sc_pat_agc_${"A".repeat(20)}_${"B".repeat(42)}`)).toThrow(CliError);
  });

  it("requires an origin and prevents server path injection", () => {
    expect(normalizeServer("https://api.example.com/")).toBe("https://api.example.com");
    expect(normalizeServer("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => normalizeServer("http://api.example.com")).toThrow("HTTPS");
    expect(() => normalizeServer("https://api.example.com/evil")).toThrow("origin");
    expect(() => normalizeServer("https://user:pass@api.example.com")).toThrow("origin");
  });

  it("uses SCALIUS_TOKEN ephemerally without persisting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-cli-"));
    const token = validToken();
    const runtime = createTestRuntime({ directory, env: { SCALIUS_TOKEN: token } });
    const store = new ConfigStore(runtime);
    await store.putProfile("default", "https://api.example.com");
    const profile = await store.resolveProfile(undefined, true);
    expect(profile.token).toBe(token);
    expect(profile.tokenSource).toBe("environment");
    expect((await store.loadCredentials()).credentials).toEqual({});
  });

  it("streams downloads atomically and refuses to replace existing files by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-download-"));
    const destination = join(directory, "report.csv");
    const first = new Response("a,b\n1,2\n");
    expect(await writeAtomicOutput(destination, first.body, false, { maximumBytes: 8 })).toBe(8);
    expect(await readFile(destination, "utf8")).toBe("a,b\n1,2\n");
    await expect(writeAtomicOutput(destination, new Response("replacement").body, false, { maximumBytes: 20 })).rejects.toMatchObject({
      errorCode: "output_exists",
      exitCode: 2,
    });
    expect(await readFile(destination, "utf8")).toBe("a,b\n1,2\n");
    await writeAtomicOutput(destination, new Response("replacement").body, true, { maximumBytes: 20 });
    expect(await readFile(destination, "utf8")).toBe("replacement");
  });
});
