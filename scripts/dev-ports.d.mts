// Types for scripts/dev-ports.mjs (imported by apps/admin-v2/vite.config.ts).

export interface DevPorts {
  api: number;
  storefront: number;
  admin: number;
}

export interface DevOrigins {
  apiUrl: string;
  storefrontUrl: string;
  dashboardUrl: string;
  mediaUrl: string;
}

export declare const DEFAULT_DEV_PORTS: Readonly<DevPorts>;
export declare const DEV_PORT_ENV: Readonly<Record<keyof DevPorts, string>>;
export declare const PLATFORM_KV_KEY: string;
export declare function readDevPorts(env?: Record<string, string | undefined>): DevPorts;
export declare function devOrigins(ports?: DevPorts): DevOrigins;
export declare function platformSyncSql(origins: DevOrigins): string;
export declare function syncLocalPlatform(options?: {
  env?: Record<string, string | undefined>;
  state?: string;
}): Promise<{ origins: DevOrigins; changed: boolean; wranglerState: string }>;
