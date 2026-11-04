// Types for scripts/admin-chunk-graph.mjs (imported by apps/admin-v2/vite.config.ts).

import type { Plugin } from "vite";

export declare const ADMIN_BUILD_CACHE_DIR: string;
export declare function sha256(content: string | Uint8Array): string;
export declare function chunkGraphPath(adminDir: string, outDir: string): string;
export declare function adminChunkGraphPlugin(): Plugin;
