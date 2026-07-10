import { describe, expect, it } from "vitest";

import {
  assertFlueAdmissionSession,
  createFlueAgentEnvelope,
  deriveFlueThreadIdentity,
  deriveHiddenAdminAssistantCredential,
  requireAssistantThreadSigningKey,
} from "./flue-thread-admission";

const SIGNING_KEY = "dedicated-thread-admission-signing-key-32-bytes";
const THREAD_ID = "conv_abcdefghijklmnopqrstuv";

describe("Flue thread admission primitives", () => {
  it("measures dedicated signing keys in UTF-8 bytes and rejects secret reuse", () => {
    expect(requireAssistantThreadSigningKey({
      ASSISTANT_THREAD_SIGNING_KEY: "🔑".repeat(8),
    } as Env)).toBe("🔑".repeat(8));
    expect(() => requireAssistantThreadSigningKey({
      ASSISTANT_THREAD_SIGNING_KEY: "🔑".repeat(7),
    } as Env)).toThrow("Assistant thread admission is unavailable.");
    expect(() => requireAssistantThreadSigningKey({
      ASSISTANT_THREAD_SIGNING_KEY: SIGNING_KEY,
      JWT_SECRET: SIGNING_KEY,
    } as Env)).toThrow("Assistant thread admission is unavailable.");
    expect(() => requireAssistantThreadSigningKey({
      ASSISTANT_THREAD_SIGNING_KEY: `  ${SIGNING_KEY}  `,
      JWT_SECRET: SIGNING_KEY,
    } as Env)).toThrow("Assistant thread admission is unavailable.");
  });

  it("derives deterministic opaque identity and hidden authority credentials", async () => {
    const input = {
      surface: "admin" as const,
      deploymentBindingHash: "d".repeat(64),
      actorBinding: {
        actorId: "raw_admin_id",
        dashboardSessionHash: "s".repeat(64),
      },
      threadId: THREAD_ID,
      signingKey: SIGNING_KEY,
    };
    const first = await deriveFlueThreadIdentity(input);
    const replay = await deriveFlueThreadIdentity(input);
    const otherActor = await deriveFlueThreadIdentity({
      ...input,
      actorBinding: { ...input.actorBinding, actorId: "raw_admin_id_2" },
    });
    const otherDeployment = await deriveFlueThreadIdentity({
      ...input,
      deploymentBindingHash: "e".repeat(64),
    });

    expect(replay).toEqual(first);
    expect(otherActor.principalId).not.toBe(first.principalId);
    expect(otherActor.tenantId).toBe(first.tenantId);
    expect(otherDeployment.tenantId).not.toBe(first.tenantId);
    expect(JSON.stringify(first)).not.toMatch(/raw_admin_id|dashboardSessionHash/);

    const credential = await deriveHiddenAdminAssistantCredential({
      deploymentBindingHash: input.deploymentBindingHash,
      actorId: input.actorBinding.actorId,
      dashboardSessionHash: input.actorBinding.dashboardSessionHash,
      permissionSnapshotHash: "p".repeat(64),
      threadId: THREAD_ID,
      signingKey: SIGNING_KEY,
    });
    expect(credential).toMatch(/^session_asst_[A-Za-z0-9_-]{43}$/u);
    expect(credential).not.toContain(input.actorBinding.actorId);

    const envelope = await createFlueAgentEnvelope({
      surface: "admin",
      identity: first,
      signingKey: SIGNING_KEY,
      expiresAt: 1_900_000_000_000,
    });
    expect(envelope).toMatchObject({
      surface: "admin",
      instanceId: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/u),
      ...first,
    });
  });

  it("rejects mismatched, revoked, and expired authority sessions", () => {
    const active = {
      id: "as_1",
      surface: "storefront" as const,
      actorType: "guest" as const,
      actorId: "guest_1",
      conversationKey: THREAD_ID,
      status: "active" as const,
      permissionSnapshotHash: null,
      safeMetadata: null,
      lastEventSequence: 0,
      expiresAt: 2_000,
      lastSeenAt: 1_000,
    };
    expect(() => assertFlueAdmissionSession(
      active,
      { surface: "storefront", threadId: THREAD_ID },
      1_000,
    )).not.toThrow();
    expect(() => assertFlueAdmissionSession(
      { ...active, status: "revoked" },
      { surface: "storefront", threadId: THREAD_ID },
      1_000,
    )).toThrow();
    expect(() => assertFlueAdmissionSession(
      active,
      { surface: "storefront", threadId: "conv_abcdefghijklmnopqrstuw" },
      1_000,
    )).toThrow();
    expect(() => assertFlueAdmissionSession(
      active,
      { surface: "storefront", threadId: THREAD_ID },
      2_000,
    )).toThrow();
  });
});
