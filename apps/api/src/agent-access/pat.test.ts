import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  getAgentTokenSafeHint,
  getBearerToken,
  hashAgentCredential,
  issueAgentCredential,
  parseAgentCredential,
  verifyAgentCredentialHash,
} from "./pat";

const PEPPER = "agent-test-pepper-that-is-longer-than-thirty-two-characters";

describe("agent credential tokens", () => {
  it.each(["pat", "cli"] as const)("issues and verifies %s credentials", async (kind) => {
    const issued = await issueAgentCredential(kind, "agc_0123456789abcdefghij", PEPPER);
    const parsed = parseAgentCredential(issued.token);

    expect(parsed).toEqual({
      kind,
      credentialId: "agc_0123456789abcdefghij",
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(issued.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.tokenHint).not.toContain(parsed!.secret);
    expect(await verifyAgentCredentialHash(parsed!, issued.tokenHash, PEPPER)).toBe(true);
    expect(await verifyAgentCredentialHash(parsed!, "0".repeat(64), PEPPER)).toBe(false);
  });

  it("binds hashes to kind, public ID, secret, and pepper", async () => {
    const issued = await issueAgentCredential("pat", "agc_0123456789abcdefghij", PEPPER);
    const parsed = parseAgentCredential(issued.token)!;

    const cliHash = await hashAgentCredential({ ...parsed, kind: "cli" }, PEPPER);
    const idHash = await hashAgentCredential({ ...parsed, credentialId: "agc_9876543210zyxwvutsrq" }, PEPPER);
    const pepperHash = await hashAgentCredential(parsed, `${PEPPER}-different`);

    expect(new Set([issued.tokenHash, cliHash, idHash, pepperHash])).toHaveLength(4);
  });

  it("rejects malformed or ambiguous credentials", () => {
    expect(parseAgentCredential("sc_pat_short_secret")).toBeNull();
    expect(parseAgentCredential("scl_pat_agc_0123456789abcdefghij_" + "a".repeat(43))).toBeNull();
    expect(parseAgentCredential("sc_pat_bad_0123456789abcdefghij_" + "a".repeat(43))).toBeNull();
    expect(parseAgentCredential("sc_pat_agc_0123456789abcdefghi_" + "a".repeat(43))).toBeNull();
    expect(parseAgentCredential("sc_pat_agc_0123456789abcdefghij_" + "a".repeat(42))).toBeNull();
    expect(getBearerToken("Basic abc")).toBeNull();
    expect(getBearerToken("Bearer one two")).toBeNull();
  });

  it("extracts bearer tokens and returns a non-secret display hint", async () => {
    const issued = await issueAgentCredential("cli", "agc_0123456789abcdefghij", PEPPER);
    expect(getBearerToken(`bearer ${issued.token}`)).toBe(issued.token);
    const hint = getAgentTokenSafeHint(issued.token);
    expect(hint).toBe(issued.tokenHint);
    expect(hint).not.toBe(issued.token);
  });

  it("uses a constant-time comparison contract for unequal lengths", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("fails closed without a strong pepper", async () => {
    await expect(issueAgentCredential("pat", "agc_0123456789abcdefghij", "short")).rejects.toThrow(
      "AGENT_TOKEN_PEPPER",
    );
    await expect(
      issueAgentCredential("pat", "credential_0123456789abcdef", PEPPER),
    ).rejects.toThrow("invalid format");
  });
});
