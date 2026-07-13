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
    if (/OPR\//i.test(userAgent)) return "Opera";
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

export function describeAccountSessionDevice(userAgent: string | null): {
    label: string;
    type: AccountSessionDeviceType;
} {
    const normalized = userAgent?.trim();
    if (!normalized) return { label: "Unknown device", type: "unknown" };

    const browser = detectBrowser(normalized);
    const platform = detectPlatform(normalized);
    if (browser && platform.label) {
        return { label: `${browser} on ${platform.label}`, type: platform.type };
    }
    if (browser) return { label: browser, type: platform.type };
    if (platform.label) return { label: platform.label, type: platform.type };
    return { label: "Unknown device", type: "unknown" };
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
        networkHint: maskAccountSessionIp(session.ipAddress),
        twoFactorVerified: session.twoFactorVerified,
        impersonated: Boolean(session.impersonatedBy),
        createdAt: session.createdAt.toISOString(),
        lastActiveAt: session.updatedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
    };
}
