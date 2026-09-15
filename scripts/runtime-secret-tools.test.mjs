import { describe, expect, it, vi } from "vitest";

import {
  DERIVABLE_AUTOMATION_SECRETS,
  main as deriveMain,
  parseDeriveArgs,
  readMasterSecretInput,
  resolvePurpose,
} from "./derive-runtime-secret.mjs";
import {
  buildHandoffClaims,
  buildHandoffUrl,
  main as mintMain,
  MAX_HANDOFF_LIFETIME_SECONDS,
  parseMintArgs,
  signCompactHs256,
  verifyCompactHs256,
} from "./mint-identity-handoff-token.mjs";
import {
  deriveRuntimeSecret,
  RUNTIME_SECRET_PURPOSES,
} from "../packages/shared/src/runtime-secrets.ts";
import {
  IdentityHandoffError,
  verifyIdentityHandoffToken,
} from "../packages/core/src/auth/identity-handoff.ts";

const MASTER = "operator-master-secret-with-enough-length-0123456789";

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)) };
}

/** Collects stderr without letting a warning reach the test reporter. */
function quiet() {
  return { warn: vi.fn(), isTty: () => false };
}

describe("derive-runtime-secret argument contract", () => {
  it("never accepts the master secret as an argument", () => {
    for (const argument of ["--secret=abc", "--master", "--master-secret=abc", "--scalius-secret=abc"]) {
      expect(() => parseDeriveArgs([argument, "--purpose", "admin-setup"]))
        .toThrow("never accepted as an argument");
    }
  });

  it("requires a purpose and rejects unknown or non-automation purposes", () => {
    expect(() => parseDeriveArgs([])).toThrow("--purpose is required");
    expect(() => parseDeriveArgs(["--purpose"])).toThrow("requires a value");
    expect(() => parseDeriveArgs(["--stdin", "--from-env", "--purpose", "admin-setup"]))
      .toThrow("either --stdin or --from-env");
    expect(() => resolvePurpose("jwt-signing")).toThrow("Unknown purpose");
    expect(() => resolvePurpose("BETTER_AUTH_SECRET")).toThrow("Unknown purpose");
    expect(() => resolvePurpose("")).toThrow("Unknown purpose");
  });

  it("accepts either the purpose label or the secret name for every automation secret", () => {
    expect(Object.values(DERIVABLE_AUTOMATION_SECRETS)).toEqual([
      RUNTIME_SECRET_PURPOSES.ADMIN_SETUP_TOKEN,
      RUNTIME_SECRET_PURPOSES.FRONT_PROXY_SECRET,
      RUNTIME_SECRET_PURPOSES.IDENTITY_HANDOFF_SECRET,
    ]);
    for (const [name, purpose] of Object.entries(DERIVABLE_AUTOMATION_SECRETS)) {
      expect(resolvePurpose(purpose)).toEqual({ name, purpose });
      expect(resolvePurpose(name)).toEqual({ name, purpose });
    }
  });
});

describe("derive-runtime-secret derivation", () => {
  it("prints exactly the value the Worker derives at request time", async () => {
    for (const [name, purpose] of Object.entries(DERIVABLE_AUTOMATION_SECRETS)) {
      const { lines, log } = capture();
      await expect(deriveMain(["--purpose", purpose, "--from-env"], {
        log, ...quiet(), env: { SCALIUS_SECRET: MASTER },
      })).resolves.toBe(0);
      expect(lines).toEqual([await deriveRuntimeSecret(MASTER, RUNTIME_SECRET_PURPOSES[name])]);
    }
  });

  it("reads the master secret from standard input and reports it in JSON mode", async () => {
    const { lines, log } = capture();
    await expect(deriveMain(["--purpose", "front-proxy", "--stdin", "--json"], {
      log, ...quiet(), input: [Buffer.from(`${MASTER}\n`)],
    })).resolves.toBe(0);
    expect(JSON.parse(lines[0])).toEqual({
      name: "FRONT_PROXY_SECRET",
      purpose: "front-proxy",
      secret: await deriveRuntimeSecret(MASTER, RUNTIME_SECRET_PURPOSES.FRONT_PROXY_SECRET),
    });
  });

  it("never echoes the master secret and fails closed when no secret arrives", async () => {
    const { lines, log } = capture();
    await deriveMain(["--purpose", "admin-setup", "--from-env"], {
      log, ...quiet(), env: { SCALIUS_SECRET: MASTER },
    });
    expect(lines.join("\n")).not.toContain(MASTER);

    await expect(readMasterSecretInput({ fromEnv: true }, { env: {} }))
      .rejects.toThrow("SCALIUS_SECRET is not set");
    await expect(readMasterSecretInput({ stdin: true }, { input: [Buffer.from("  \n")] }))
      .rejects.toThrow("No master secret arrived");
    await expect(readMasterSecretInput({}, { hiddenReader: async () => "" }))
      .rejects.toThrow("A master secret is required");
  });

  it("warns when a derived secret lands in a terminal", async () => {
    const warn = vi.fn();
    await deriveMain(["--purpose", "admin-setup", "--from-env"], {
      log: vi.fn(), warn, isTty: () => true, env: { SCALIUS_SECRET: MASTER },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ADMIN_SETUP_TOKEN"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain(MASTER);
  });
});

describe("mint-identity-handoff-token argument contract", () => {
  const base = ["--issuer", "https://cp.example", "--audience", "scalius:store-1", "--email", "op@example.com"];

  it("requires the claims the Worker needs before it will mint anything", () => {
    expect(() => parseMintArgs([])).toThrow("--issuer is required");
    expect(() => parseMintArgs(["--issuer", "https://cp.example"])).toThrow("--audience is required");
    expect(() => parseMintArgs([...base.slice(0, 4), "--email", "not-an-email"])).toThrow("complete e-mail");
    expect(() => parseMintArgs(base)).toThrow("--role is required");
    expect(() => parseMintArgs([...base, "--mode", "sideways"])).toThrow('must be "handoff" or "revoke"');
    expect(() => parseMintArgs([...base, "--suspend", "--role", "manager"])).toThrow("only with --mode revoke");
    expect(() => parseMintArgs([...base, "--secret=abc"])).toThrow("never accepted as an argument");
  });

  it("caps the lifetime at the Worker's maximum", () => {
    expect(parseMintArgs([...base, "--role", "owner"]).lifetime).toBe(60);
    expect(parseMintArgs([...base, "--role", "owner", "--lifetime", "120"]).lifetime)
      .toBe(MAX_HANDOFF_LIFETIME_SECONDS);
    expect(() => parseMintArgs([...base, "--role", "owner", "--lifetime", "121"])).toThrow("between 1 and 120");
    expect(() => parseMintArgs([...base, "--role", "owner", "--lifetime", "0"])).toThrow("between 1 and 120");
  });

  it("mints a revoke token without a role and builds the endpoint URLs", () => {
    const revoke = parseMintArgs([...base, "--mode", "revoke", "--suspend"]);
    expect(revoke).toMatchObject({ mode: "revoke", suspend: true });
    expect(revoke.role).toBeUndefined();
    expect(parseMintArgs([...base, "--role", "owner", "--dashboard-url", "https://shop.example.com/dashboard/"]).dashboardUrl)
      .toBe("https://shop.example.com/dashboard");
    expect(() => parseMintArgs([...base, "--role", "owner", "--dashboard-url", "shop.example.com"]))
      .toThrow("absolute URL");
    expect(buildHandoffUrl("https://shop.example.com/dashboard", "handoff", "tok"))
      .toBe("https://shop.example.com/dashboard/api/auth/handoff?token=tok");
    expect(buildHandoffUrl("https://shop.example.com/dashboard", "revoke", "tok"))
      .toBe("https://shop.example.com/dashboard/api/auth/handoff/revoke");
    expect(buildHandoffUrl(undefined, "handoff", "tok")).toBeUndefined();
  });

  it("signs and verifies its own compact HS256 tokens", () => {
    const token = signCompactHs256("key-material", { sub: "a" });
    expect(verifyCompactHs256("key-material", token)).toBe(true);
    expect(verifyCompactHs256("other-key", token)).toBe(false);
    expect(verifyCompactHs256("key-material", "not.a.token")).toBe(false);
    expect(verifyCompactHs256("key-material", "missing-parts")).toBe(false);
  });
});

describe("minted tokens against the Worker's own verifier", () => {
  const CONFIG = {
    enabled: true,
    issuer: "https://cp.example",
    audience: "scalius:store-1",
    jwksUrl: "",
    localLoginDisabled: false,
  };
  const NOW_SECONDS = Math.floor(Date.parse("2026-09-16T12:00:00.000Z") / 1000);
  const NOW = new Date(NOW_SECONDS * 1000);

  async function mintToken(argv) {
    const { lines, log } = capture();
    await expect(mintMain([
      "--issuer", CONFIG.issuer, "--audience", CONFIG.audience,
      "--email", "Ops@Example.com", "--from-env", "--json", ...argv,
    ], { log, ...quiet(), env: { SCALIUS_SECRET: MASTER }, now: NOW_SECONDS })).resolves.toBe(0);
    return JSON.parse(lines[0]);
  }

  async function verify(token) {
    return verifyIdentityHandoffToken(token, {
      config: CONFIG,
      hmacSecret: await deriveRuntimeSecret(MASTER, RUNTIME_SECRET_PURPOSES.IDENTITY_HANDOFF_SECRET),
      now: () => NOW,
    });
  }

  it("verifies a sign-in token with every claim the dashboard consumes", async () => {
    const minted = await mintToken(["--role", "manager", "--name", "Ops Person", "--subject", "idp-user-1"]);

    await expect(verify(minted.token)).resolves.toEqual({
      purpose: "dashboard-handoff",
      jti: minted.jti,
      subject: "idp-user-1",
      email: "ops@example.com",
      name: "Ops Person",
      role: "manager",
      suspend: false,
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
    });
    expect(minted.expiresAt).toBe(NOW_SECONDS + 60);
  });

  it("verifies a revoke token and carries the suspend intent", async () => {
    const minted = await mintToken(["--mode", "revoke", "--suspend"]);

    await expect(verify(minted.token)).resolves.toMatchObject({
      purpose: "dashboard-revoke",
      email: "ops@example.com",
      suspend: true,
    });
  });

  it("mints a single-use identity every time", async () => {
    const [first, second] = await Promise.all([
      mintToken(["--role", "owner"]),
      mintToken(["--role", "owner"]),
    ]);
    expect(first.jti).not.toBe(second.jti);
    expect(first.jti.length).toBeGreaterThanOrEqual(8);
  });

  it("is rejected by the verifier when the master secret differs", async () => {
    const minted = await mintToken(["--role", "owner"]);
    const error = await verifyIdentityHandoffToken(minted.token, {
      config: CONFIG,
      hmacSecret: await deriveRuntimeSecret(`${MASTER}-other`, RUNTIME_SECRET_PURPOSES.IDENTITY_HANDOFF_SECRET),
      now: () => NOW,
    }).then(() => null, (caught) => caught);
    expect(error).toBeInstanceOf(IdentityHandoffError);
    expect(error.code).toBe("HANDOFF_TOKEN_INVALID");
  });

  it("builds claims that never exceed the Worker's lifetime ceiling", () => {
    const claims = buildHandoffClaims(
      { issuer: "i", audience: "a", email: "e@x.test", mode: "handoff", role: "owner", lifetime: MAX_HANDOFF_LIFETIME_SECONDS },
      { now: NOW_SECONDS, jti: "fixed-jti-value" },
    );
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(MAX_HANDOFF_LIFETIME_SECONDS);
    expect(claims).toMatchObject({ sub: "e@x.test", email_verified: true, purpose: "dashboard-handoff" });
  });
});
