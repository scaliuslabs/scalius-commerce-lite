import { describe, expect, it } from "vitest";

import {
  ADMIN_CONVERSATION_POLICY,
  SENSITIVE_CONVERSATION_OMISSION,
  STOREFRONT_CONVERSATION_POLICY,
  ConversationInputError,
  isStorefrontConversationSubject,
  normalizeConversationMessageInput,
} from "./contracts";
import { conversationObjectName, sha256Hex } from "./crypto";
import {
  matchInternalConversationRoute,
  proxyInternalConversationRequest,
  type ConversationObjectNamespace,
} from "./router";
import { ConversationStore, ConversationStoreError } from "./storage";
import type {
  ConversationStorage,
  ConversationStorageListOptions,
  ConversationStorageTransaction,
} from "./types";

class MemoryConversationStorage implements ConversationStorage {
  state = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.state.get(key) as T | undefined;
  }

  async list<T>(options: ConversationStorageListOptions = {}): Promise<Map<string, T>> {
    const entries = [...this.state.entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .filter(([key]) => !options.start || key >= options.start)
      .filter(([key]) => !options.end || key < options.end)
      .sort(([left], [right]) => left.localeCompare(right));
    const selected = options.limit === undefined
      ? entries
      : entries.slice(0, options.limit);
    return new Map(selected) as Map<string, T>;
  }

  async transaction<T>(
    closure: (transaction: ConversationStorageTransaction) => Promise<T>,
  ): Promise<T> {
    const staged = new Map(this.state);
    let stagedAlarm = this.alarm;
    const transaction: ConversationStorageTransaction = {
      get: async <TValue>(key: string) => staged.get(key) as TValue | undefined,
      list: async <TValue>(options: ConversationStorageListOptions = {}) => {
        const entries = [...staged.entries()]
          .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
          .filter(([key]) => !options.start || key >= options.start)
          .filter(([key]) => !options.end || key < options.end)
          .sort(([left], [right]) => left.localeCompare(right));
        const selected = options.limit === undefined
          ? entries
          : entries.slice(0, options.limit);
        return new Map(selected) as Map<string, TValue>;
      },
      put: async (key, value) => {
        staged.set(key, structuredClone(value));
      },
      delete: async (key) => {
        for (const item of Array.isArray(key) ? key : [key]) staged.delete(item);
      },
      setAlarm: async (scheduledTime) => {
        stagedAlarm = scheduledTime instanceof Date
          ? scheduledTime.getTime()
          : scheduledTime;
      },
      deleteAlarm: async () => {
        stagedAlarm = null;
      },
    };
    const result = await closure(transaction);
    this.state = staged;
    this.alarm = stagedAlarm;
    return result;
  }

  snapshot(): string {
    return JSON.stringify([...this.state.entries()]);
  }
}

async function append(
  store: ConversationStore,
  id: string,
  content: string,
  now: number,
) {
  const requestHash = await sha256Hex(id);
  const fingerprint = await sha256Hex(`user\u0000${content}\u0000admin:page`);
  return store.appendMessage({
    requestHash,
    fingerprint,
    role: "user",
    content,
    contextMarker: "admin:page",
  }, now);
}

describe("conversation privacy contract", () => {
  it("persists only redacted plain text and never arbitrary checkout objects", async () => {
    const normalized = normalizeConversationMessageInput(
      STOREFRONT_CONVERSATION_POLICY,
      {
        clientMessageId: "client_message_001",
        role: "user",
        contextMarker: "storefront:product",
        content: [
          "email buyer@example.test",
          "phone +8801712345678",
          "token: session_privatecredential",
          'address: "12 Private Road, Dhaka"',
          'name: "Private Buyer"',
          "otp: 654321",
        ].join("\n"),
      },
    );
    const storage = new MemoryConversationStorage();
    const store = new ConversationStore(storage, 60_000);
    await store.appendMessage({
      requestHash: await sha256Hex(normalized.clientMessageId),
      fingerprint: await sha256Hex(normalized.content),
      role: normalized.role,
      content: normalized.content,
      contextMarker: normalized.contextMarker,
    }, 1_000);
    await store.appendMessage({
      requestHash: await sha256Hex("storage_defense_message"),
      fingerprint: await sha256Hex("storage_defense_fingerprint"),
      role: "user",
      content: 'name: "Second Private Buyer"; address: "99 Hidden Lane"',
      contextMarker: "storefront:product",
    }, 1_001);

    const snapshot = storage.snapshot();
    expect(snapshot).not.toContain("buyer@example.test");
    expect(snapshot).not.toContain("8801712345678");
    expect(snapshot).not.toContain("session_privatecredential");
    expect(snapshot).not.toContain("12 Private Road");
    expect(snapshot).not.toContain("Private Buyer");
    expect(snapshot).not.toContain("Second Private Buyer");
    expect(snapshot).not.toContain("99 Hidden Lane");
    expect(snapshot).not.toContain("654321");
    expect(snapshot).not.toContain("client_message_001");
    expect(snapshot).toContain("[redacted");

    expect(() => normalizeConversationMessageInput(
      STOREFRONT_CONVERSATION_POLICY,
      {
        clientMessageId: "client_message_002",
        role: "user",
        contextMarker: "storefront:product",
        content: "hello",
        checkout: { address: "must never persist" },
      },
    )).toThrow(ConversationInputError);
  });

  it("replaces the complete turn on sensitive pages", () => {
    const normalized = normalizeConversationMessageInput(
      STOREFRONT_CONVERSATION_POLICY,
      {
        clientMessageId: "client_message_sensitive",
        role: "user",
        contextMarker: "storefront:sensitive",
        content: "Private Buyer, 12 Private Road, payment card 4111111111111111",
      },
    );

    expect(normalized.content).toBe(SENSITIVE_CONVERSATION_OMISSION);
  });

  it.each([
    [ADMIN_CONVERSATION_POLICY, "admin:page", "system"],
    [ADMIN_CONVERSATION_POLICY, "admin:page", "tool"],
    [STOREFRONT_CONVERSATION_POLICY, "storefront:product", "system"],
    [STOREFRONT_CONVERSATION_POLICY, "storefront:product", "tool"],
  ])("rejects API-authority role %s on both transcript surfaces", (policy, contextMarker, role) => {
    expect(() => normalizeConversationMessageInput(policy, {
      clientMessageId: "client_message_role_test",
      role,
      contextMarker,
      content: "must not persist",
    })).toThrow(ConversationInputError);
  });
});

describe("conversation durable store", () => {
  it("orders events, suppresses duplicate client messages, and rejects conflicting reuse", async () => {
    const storage = new MemoryConversationStorage();
    const store = new ConversationStore(storage, 60_000);
    const first = await append(store, "client_0001", "first", 1_000);
    const replay = await append(store, "client_0001", "first", 1_001);
    const second = await append(store, "client_0002", "second", 1_002);

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, event: { sequence: 1 } });
    expect(second.event.sequence).toBe(2);
    const events = await store.readEvents(0, 50, 1_003);
    expect(events.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.cursor).toBe(2);

    await expect(append(store, "client_0001", "changed", 1_004)).rejects.toMatchObject({
      code: "conversation_duplicate_conflict",
      status: 409,
    });
  });

  it("replays after a simulated object eviction using only durable storage", async () => {
    const storage = new MemoryConversationStorage();
    const firstWake = new ConversationStore(storage, 60_000);
    await append(firstWake, "client_0001", "persisted", 2_000);

    const secondWake = new ConversationStore(storage, 60_000);
    const replay = await secondWake.readEvents(0, 50, 2_001);
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({
      sequence: 1,
      type: "message.appended",
      message: { content: "persisted" },
    });
  });

  it("evicts old display events while retaining bounded duplicate tombstones", async () => {
    const storage = new MemoryConversationStorage();
    const store = new ConversationStore(storage, 60_000);
    for (let index = 0; index < 205; index += 1) {
      await append(store, `client_${String(index).padStart(4, "0")}`, `message ${index}`, 3_000 + index);
    }

    await expect(store.readEvents(0, 50, 4_000)).rejects.toMatchObject({
      code: "conversation_cursor_evicted",
      status: 409,
    });
    const latest = await store.readEvents(200, 50, 4_000);
    expect(latest.events.map((event) => event.sequence)).toEqual([201, 202, 203, 204, 205]);
    await expect(append(store, "client_0000", "message 0", 4_001)).rejects.toMatchObject({
      code: "conversation_duplicate_evicted",
      status: 409,
    });
  });

  it("stores only a hash for cancellation targets and expires state with its alarm", async () => {
    const storage = new MemoryConversationStorage();
    const store = new ConversationStore(storage, 10_000);
    const runId = "run_private_identifier";
    const requestHash = await sha256Hex("cancel_request_001");
    const runHash = await sha256Hex(runId);
    const fingerprint = await sha256Hex(`stream.cancelled\u0000${runHash}`);
    const result = await store.cancelRun({ requestHash, fingerprint, runHash }, 5_000);
    const secondRequestHash = await sha256Hex("cancel_request_002");
    const replay = await store.cancelRun({
      requestHash: secondRequestHash,
      fingerprint,
      runHash,
    }, 5_001);

    expect(result.event).toMatchObject({ type: "stream.cancelled", sequence: 1 });
    expect(replay).toMatchObject({ replayed: true, event: { sequence: 1 } });
    await expect(store.appendMessage({
      requestHash: secondRequestHash,
      fingerprint: await sha256Hex("different-message"),
      role: "user",
      content: "different",
      contextMarker: "admin:page",
    }, 5_002)).rejects.toMatchObject({
      code: "conversation_duplicate_conflict",
    });
    expect(storage.snapshot()).not.toContain(runId);
    expect(storage.alarm).toBe(15_000);
    expect(await store.expire(14_999)).toBe(false);
    expect(await store.expire(15_000)).toBe(true);
    expect(storage.state.size).toBe(0);
    expect(storage.alarm).toBeNull();
  });
});

describe("conversation facade routing", () => {
  it("isolates object names by audience, subject, and conversation", async () => {
    const conversationId = "conv_abcdefghijklmnopqrstuv";
    const admin = await conversationObjectName("admin", "actor_1", conversationId);
    const storefront = await conversationObjectName("storefront", "actor_1", conversationId);
    const otherActor = await conversationObjectName("admin", "actor_2", conversationId);
    expect(new Set([admin, storefront, otherActor]).size).toBe(3);
    expect(admin).not.toContain("actor_1");
    expect(admin).not.toContain(conversationId);
  });

  it("rejects weak conversation and Storefront subject identifiers", () => {
    expect(matchInternalConversationRoute(
      new Request("http://storefront-agent.internal/internal/conversations/conv_short/events"),
      "http://storefront-agent.internal",
    )).toBeNull();
    expect(isStorefrontConversationSubject("guest_subject_001")).toBe(false);
    expect(isStorefrontConversationSubject(
      "storefront_subject_abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno12",
    )).toBe(true);
    expect(STOREFRONT_CONVERSATION_POLICY.audience).toBe("scalius-storefront-browser-v1");
  });

  it("matches only the exact internal origin and strips cookies, authorization, IP, and user-agent headers", async () => {
    const publicRequest = new Request(
      "https://agent.example.test/internal/conversations/conv_abcdefghijklmnopqrstuv/events",
    );
    expect(matchInternalConversationRoute(
      publicRequest,
      "http://storefront-agent.internal",
    )).toBeNull();

    const request = new Request(
      "http://storefront-agent.internal/internal/conversations/conv_abcdefghijklmnopqrstuv/events?after=0",
      {
        headers: {
          Cookie: "session=private",
          Authorization: "Bearer private",
          "CF-Connecting-IP": "203.0.113.10",
          "User-Agent": "private-agent",
        },
      },
    );
    const route = matchInternalConversationRoute(
      request,
      "http://storefront-agent.internal",
    );
    expect(route).not.toBeNull();

    let forwarded: Request | null = null;
    let objectName = "";
    const namespace: ConversationObjectNamespace = {
      getByName(name) {
        objectName = name;
        return {
          async fetch(input) {
            forwarded = input;
            return new Response("ok");
          },
        };
      },
    };
    await proxyInternalConversationRequest({
      request,
      route: route!,
      namespace,
      policy: STOREFRONT_CONVERSATION_POLICY,
      subject: "storefront_subject_abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno12",
      now: 10_000,
    });

    expect(objectName).not.toContain("storefront_subject_");
    expect(forwarded).not.toBeNull();
    const headers = (forwarded as unknown as Request).headers;
    expect(headers.has("Cookie")).toBe(false);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("CF-Connecting-IP")).toBe(false);
    expect(headers.has("User-Agent")).toBe(false);
  });
});

describe("conversation store errors", () => {
  it("uses typed, non-sensitive errors", () => {
    const error = new ConversationStoreError("safe_code", "Safe message", 409);
    expect(error).toMatchObject({ code: "safe_code", status: 409 });
  });
});
