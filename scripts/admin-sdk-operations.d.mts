// Types for scripts/admin-sdk-operations.mjs (imported by apps/admin-v2/vite.config.ts).

import type { Plugin } from "vite";

export declare const SDK_SOURCE: string;
export declare const SDK_OPERATION_PREFIX: string;
export declare function isSdkOperationChunk(chunkName: string): boolean;
export declare function adminSdkOperationsPlugin(options?: { source?: string }): Plugin;
