import { describe, expect, it, vi } from "vitest";
import {
  MAX_WEB_PUSH_PLAINTEXT,
  WebPushError,
  deriveVapidKeys,
  encryptWebPushPayload,
  isAllowedPushEndpoint,
  sendWebPush,
  vapidAuthorization,
} from "./index";
import { base64UrlDecode, base64UrlEncode, importVapidScalar } from "./vapid";

// RFC 8291 Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

const SECRET = "test-master-secret-0123456789abcdef0123456789";
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

async function importPair(privateB64: string, publicB64: string): Promise<CryptoKeyPair> {
  const point = base64UrlDecode(publicB64);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(point.slice(1, 33)),
    y: base64UrlEncode(point.slice(33, 65)),
  };
  return {
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: privateB64 }, ECDH, false, [
      "deriveBits",
    ]),
    publicKey: await crypto.subtle.importKey("jwk", jwk, ECDH, true, []),
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
      key,
      length * 8,
    ),
  );
}

/** Independent receiver, written from the RFC, used to prove round trips. */
async function decrypt(message: Uint8Array, receiver: CryptoKeyPair, authB64: string) {
  const enc = new TextEncoder();
  const salt = message.slice(0, 16);
  const idLen = message[20] ?? 0;
  const asPublic = message.slice(21, 21 + idLen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey));
  const asKey = await crypto.subtle.importKey("raw", asPublic as BufferSource, ECDH, false, []);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, receiver.privateKey, 256),
  );
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(base64UrlDecode(authB64), secret, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      message.slice(21 + idLen) as BufferSource,
    ),
  );
  expect(record[record.length - 1]).toBe(0x02);
  return record.slice(0, -1);
}

async function subscriptionKeys() {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, keys: { p256dh: base64UrlEncode(raw), auth: base64UrlEncode(auth) } };
}

describe("encryptWebPushPayload", () => {
  it("matches the RFC 8291 Appendix A message byte for byte", async () => {
    const message = await encryptWebPushPayload(
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      new TextEncoder().encode(RFC.plaintext),
      {
        salt: base64UrlDecode(RFC.salt),
        localKeyPair: await importPair(RFC.asPrivate, RFC.asPublic),
      },
    );
    expect(base64UrlEncode(message.slice(0, 16))).toBe(RFC.salt);
    expect(new DataView(message.buffer).getUint32(16, false)).toBe(4096);
    expect(message[20]).toBe(65);
    expect(base64UrlEncode(message.slice(21, 86))).toBe(RFC.asPublic);
    expect(base64UrlEncode(message.slice(86))).toBe(RFC.body);
  });

  it("decrypts back to the plaintext with the receiver's private key", async () => {
    const { pair, keys } = await subscriptionKeys();
    const text = "Order #1042 shipped \u{1F69A}";
    const message = await encryptWebPushPayload(keys, new TextEncoder().encode(text));
    const plain = await decrypt(message, pair, keys.auth);
    expect(new TextDecoder().decode(plain)).toBe(text);
  });

  it("accepts the largest payload and rejects one byte more", async () => {
    const { keys } = await subscriptionKeys();
    const max = await encryptWebPushPayload(keys, new Uint8Array(MAX_WEB_PUSH_PLAINTEXT));
    expect(max.length).toBe(4096);
    expect(MAX_WEB_PUSH_PLAINTEXT).toBe(3993);
    await expect(
      encryptWebPushPayload(keys, new Uint8Array(MAX_WEB_PUSH_PLAINTEXT + 1)),
    ).rejects.toMatchObject({ code: "payload_too_large" });
  });

  it("rejects malformed subscription keys with a typed error", async () => {
    const { keys } = await subscriptionKeys();
    await expect(
      encryptWebPushPayload({ ...keys, auth: "AAAA" }, new Uint8Array(1)),
    ).rejects.toBeInstanceOf(WebPushError);
    await expect(
      encryptWebPushPayload({ ...keys, p256dh: "AAAA" }, new Uint8Array(1)),
    ).rejects.toMatchObject({ code: "invalid_subscriber_key" });
  });
});

describe("VAPID", () => {
  it("derives the same keys for the same secret and different keys for another", async () => {
    const a = await deriveVapidKeys(SECRET);
    const b = await deriveVapidKeys(SECRET);
    const c = await deriveVapidKeys(`${SECRET}-other`);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.publicKey).not.toBe(c.publicKey);
    const point = base64UrlDecode(a.publicKey);
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
  });

  it("gives the same public point from PKCS#8 import and from the BigInt path", async () => {
    for (const seed of [SECRET, `${SECRET}-2`, `${SECRET}-3`]) {
      const jwk = await crypto.subtle.exportKey("jwk", (await deriveVapidKeys(seed)).privateKey);
      const d = base64UrlDecode(jwk.d as string);
      const viaRuntime = await importVapidScalar(d);
      const viaBigInt = await importVapidScalar(d, { forceFallback: true });
      expect(base64UrlEncode(viaBigInt.x)).toBe(base64UrlEncode(viaRuntime.x));
      expect(base64UrlEncode(viaBigInt.y)).toBe(base64UrlEncode(viaRuntime.y));
    }
  });

  it("signs a verifiable ES256 JWT with the right claims", async () => {
    const keys = await deriveVapidKeys(SECRET);
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const header = await vapidAuthorization(
      keys,
      "https://fcm.googleapis.com/fcm/send/abc",
      "mailto:ops@example.com",
      now,
    );
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h = "", c = "", s = "", k = ""] = match as RegExpExecArray;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(h)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(c)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: "mailto:ops@example.com",
    });
    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(keys.publicKey) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = base64UrlDecode(s);
    expect(signature.length).toBe(64);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature as BufferSource,
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });

  it("rejects subjects that are not mailto: or https:", async () => {
    const keys = await deriveVapidKeys(SECRET);
    for (const subject of ["", "mailto:", "http://example.com", "ops@example.com"]) {
      await expect(
        vapidAuthorization(keys, "https://fcm.googleapis.com/x", subject),
      ).rejects.toMatchObject({ code: "invalid_subject" });
    }
    await expect(
      vapidAuthorization(keys, "https://fcm.googleapis.com/x", "https://example.com/contact"),
    ).resolves.toContain("vapid t=");
  });
});

describe("isAllowedPushEndpoint", () => {
  it("allows only https on known push services", () => {
    const allowed = [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://android.googleapis.com/gcm/send/abc",
    ];
    for (const url of allowed) expect(isAllowedPushEndpoint(url), url).toBe(true);
    const refused = [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://example.com/push",
      "https://evil-fcm.googleapis.com.example.com/x",
      "https://notpush.apple.com.evil.test/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "not a url",
    ];
    for (const url of refused) expect(isAllowedPushEndpoint(url), url).toBe(false);
  });
});

describe("sendWebPush", () => {
  async function setup() {
    const { keys } = await subscriptionKeys();
    return {
      vapid: await deriveVapidKeys(SECRET),
      subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys },
    };
  }

  it("maps response statuses to outcomes", async () => {
    const { vapid, subscription } = await setup();
    const cases: Array<[number, string]> = [
      [201, "sent"],
      [202, "sent"],
      [404, "gone"],
      [410, "gone"],
      [429, "retry"],
      [500, "retry"],
      [503, "retry"],
      [400, "rejected"],
      [403, "rejected"],
      [413, "rejected"],
      [302, "rejected"],
    ];
    for (const [status, outcome] of cases) {
      const fetchStub = vi.fn(async () => new Response(null, { status }));
      const result = await sendWebPush({
        subscription,
        payload: "hello",
        vapid,
        subject: "mailto:ops@example.com",
        fetch: fetchStub as unknown as typeof fetch,
      });
      expect(result, String(status)).toEqual({ outcome, httpStatus: status });
    }
  });

  it("sends the encrypted body with the required headers", async () => {
    const { vapid, subscription } = await setup();
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 201 }));
    await sendWebPush({
      subscription,
      payload: "hello",
      vapid,
      subject: "mailto:ops@example.com",
      urgency: "high",
      topic: "order-1",
      ttlSeconds: 10,
      fetch: fetchStub as unknown as typeof fetch,
    });
    const [url, init] = fetchStub.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(url).toBe(subscription.endpoint);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(headers.TTL).toBe("10");
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers.Urgency).toBe("high");
    expect(headers.Topic).toBe("order-1");
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect((init?.body as Uint8Array).length).toBe(86 + "hello".length + 17);
  });

  it("sends an empty body without Content-Encoding for a null payload", async () => {
    const { vapid, subscription } = await setup();
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 201 }));
    await sendWebPush({
      subscription,
      payload: null,
      vapid,
      subject: "mailto:ops@example.com",
      ttlSeconds: 99_999_999,
      fetch: fetchStub as unknown as typeof fetch,
    });
    const init = fetchStub.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(init?.body).toBeUndefined();
    expect(headers["Content-Encoding"]).toBeUndefined();
    expect(headers.TTL).toBe("2419200");
  });

  it("returns retry on a network error", async () => {
    const { vapid, subscription } = await setup();
    const result = await sendWebPush({
      subscription,
      payload: "x",
      vapid,
      subject: "mailto:ops@example.com",
      fetch: (async () => {
        throw new TypeError("network");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ outcome: "retry", httpStatus: null });
  });

  it("refuses a disallowed endpoint without calling fetch", async () => {
    const { vapid, subscription } = await setup();
    const fetchStub = vi.fn();
    const result = await sendWebPush({
      subscription: { ...subscription, endpoint: "https://internal.example.com/push" },
      payload: "x",
      vapid,
      subject: "mailto:ops@example.com",
      fetch: fetchStub as unknown as typeof fetch,
    });
    expect(result).toEqual({ outcome: "rejected", httpStatus: null });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("throws when the payload is too large", async () => {
    const { vapid, subscription } = await setup();
    const fetchStub = vi.fn();
    await expect(
      sendWebPush({
        subscription,
        payload: new Uint8Array(MAX_WEB_PUSH_PLAINTEXT + 1),
        vapid,
        subject: "mailto:ops@example.com",
        fetch: fetchStub as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
