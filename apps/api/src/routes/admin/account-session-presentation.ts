export type AccountSessionDeviceType =
    | "desktop"
    | "mobile"
    | "tablet"
    | "unknown";

export interface AccountSessionPresentationInput {
    id: string;
    ipAddress: string | null;
    userAgent: string | null;
    impersonatedBy: string | null;
    twoFactorVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
}

export interface AccountSessionPresentation {
    commandId: string;
    current: boolean;
    deviceLabel: string;
    deviceType: AccountSessionDeviceType;
    networkHint: string | null;
    /** Signed in from this machine or its local network (loopback, private or unspecified address). */
    localNetwork: boolean;
    twoFactorVerified: boolean;
    impersonated: boolean;
    createdAt: string;
    lastActiveAt: string;
    expiresAt: string;
}

const ACCOUNT_SESSION_COMMAND_ID_PREFIX = "acs_";
const ACCOUNT_SESSION_COMMAND_ID_CONTEXT = "scalius:account-session-command:v1:";

function encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

export async function createAccountSessionCommandIdFactory(
    secret: string,
): Promise<(sessionId: string) => Promise<string>> {
    const normalizedSecret = secret.trim();
    if (!normalizedSecret) {
        throw new Error("Account session command secret is required");
    }

    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(normalizedSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const encoder = new TextEncoder();

    return async (sessionId: string) => {
        const signature = await crypto.subtle.sign(
            "HMAC",
            key,
            encoder.encode(`${ACCOUNT_SESSION_COMMAND_ID_CONTEXT}${sessionId}`),
        );
        return `${ACCOUNT_SESSION_COMMAND_ID_PREFIX}${encodeBase64Url(new Uint8Array(signature))}`;
    };
}

function detectBrowser(userAgent: string): string | null {
    if (/Edg(?:A|iOS)?\//i.test(userAgent)) return "Edge";
    if (/OPR\/|OPiOS\/|Opera/i.test(userAgent)) return "Opera";
    if (/SamsungBrowser\//i.test(userAgent)) return "Samsung Internet";
    if (/UCBrowser\//i.test(userAgent)) return "UC Browser";
    if (/(?:Chrome|CriOS)\//i.test(userAgent)) return "Chrome";
    if (/(?:Firefox|FxiOS)\//i.test(userAgent)) return "Firefox";
    if (/Safari\//i.test(userAgent)) return "Safari";
    return null;
}

function detectPlatform(userAgent: string): {
    label: string | null;
    type: AccountSessionDeviceType;
} {
    if (/iPad/i.test(userAgent)) return { label: "iPad", type: "tablet" };
    if (/iPhone|iPod/i.test(userAgent)) return { label: "iPhone", type: "mobile" };
    if (/Android/i.test(userAgent)) {
        return /Mobile/i.test(userAgent)
            ? { label: "Android", type: "mobile" }
            : { label: "Android tablet", type: "tablet" };
    }
    if (/Windows/i.test(userAgent)) return { label: "Windows", type: "desktop" };
    if (/Macintosh|Mac OS X/i.test(userAgent)) return { label: "macOS", type: "desktop" };
    if (/CrOS/i.test(userAgent)) return { label: "ChromeOS", type: "desktop" };
    if (/Linux/i.test(userAgent)) return { label: "Linux", type: "desktop" };
    return { label: null, type: "unknown" };
}

/** Browser and system names only (language-neutral); an empty label is an unknown device the dashboard names. */
export function describeAccountSessionDevice(userAgent: string | null): {
    label: string;
    type: AccountSessionDeviceType;
} {
    const normalized = userAgent?.trim();
    if (!normalized) return { label: "", type: "unknown" };

    const browser = detectBrowser(normalized);
    const platform = detectPlatform(normalized);
    if (browser && platform.label) {
        return { label: `${browser} · ${platform.label}`, type: platform.type };
    }
    if (browser) return { label: browser, type: platform.type };
    if (platform.label) return { label: platform.label, type: platform.type };
    return { label: "", type: "unknown" };
}

function maskIpv4(value: string): string | null {
    const octets = value.split(".");
    if (
        octets.length !== 4 ||
        octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
    ) {
        return null;
    }
    return `${octets[0]}.${octets[1]}.${octets[2]}.x`;
}

function ipv4Octets(value: string): number[] | null {
    const octets = value.split(".");
    if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
    return octets.map(Number);
}

/** The eight 16-bit groups of an IPv6 address, expanding `::` and an embedded IPv4 tail. */
function ipv6Groups(value: string): number[] | null {
    let text = value.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
    const tail = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (tail) {
        const v4 = ipv4Octets(tail[2]!);
        if (!v4) return null;
        text = `${tail[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
    }
    if (!/^[0-9a-f:]+$/.test(text) || !text.includes(":")) return null;
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const parse = (part: string) => (part ? part.split(":") : []);
    const head = parse(halves[0]!);
    const rest = halves.length === 2 ? parse(halves[1]!) : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
}

function isLocalIpv4([a, b]: number[]): boolean {
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
        || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

/**
 * Loopback, private, link-local or unspecified addresses: the session came
 * from this machine or its local network (a dev server, a shop's LAN), so a
 * masked hex prefix would tell the person nothing.
 */
export function isLocalNetworkAddress(ipAddress: string | null): boolean {
    const normalized = ipAddress?.split(",")[0]?.trim();
    if (!normalized) return false;
    const v4 = ipv4Octets(normalized);
    if (v4) return isLocalIpv4(v4);
    const groups = ipv6Groups(normalized);
    if (!groups) return false;
    const [first] = groups;
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7]! <= 1) return true; // :: and ::1
    if ((first! & 0xfe00) === 0xfc00 || (first! & 0xffc0) === 0xfe80) return true; // fc00::/7, fe80::/10
    // Better Auth keeps only the /64 prefix of IPv6 addresses, so the loopback ::1 arrives as all zeros.
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
        return isLocalIpv4([groups[6]! >> 8, groups[6]! & 0xff]);
    }
    return false;
}

export function maskAccountSessionIp(ipAddress: string | null): string | null {
    const normalized = ipAddress?.split(",")[0]?.trim();
    if (!normalized) return null;

    const ipv4 = maskIpv4(normalized);
    if (ipv4) return ipv4;

    const mappedIpv4 = normalized.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4) {
        const masked = maskIpv4(mappedIpv4[2] ?? "");
        return masked ? `…:${masked}` : null;
    }

    const unwrapped = normalized.replace(/^\[|\]$/g, "");
    if (!/^[0-9a-f:]+$/i.test(unwrapped) || !unwrapped.includes(":")) {
        return null;
    }
    const segments = unwrapped.split(":").filter(Boolean);
    if (segments.length === 0) return null;
    return `${segments.slice(0, 3).join(":")}:…`;
}

export function presentAccountSession(
    session: AccountSessionPresentationInput,
    currentSessionId: string,
    commandId: string,
): AccountSessionPresentation {
    const device = describeAccountSessionDevice(session.userAgent);
    return {
        commandId,
        current: session.id === currentSessionId,
        deviceLabel: device.label,
        deviceType: device.type,
        networkHint: isLocalNetworkAddress(session.ipAddress) ? null : maskAccountSessionIp(session.ipAddress),
        localNetwork: isLocalNetworkAddress(session.ipAddress),
        twoFactorVerified: session.twoFactorVerified,
        impersonated: Boolean(session.impersonatedBy),
        createdAt: session.createdAt.toISOString(),
        lastActiveAt: session.updatedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
    };
}
