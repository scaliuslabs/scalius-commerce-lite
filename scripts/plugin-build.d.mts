// Types for scripts/plugin-build.mjs (imported by the API's plugin tests).

export interface PackedPlugin {
  id: string;
  version: string;
  sha256: string;
  /** The validated manifest, defaults filled. */
  manifest: Record<string, unknown>;
  code: string;
  entry: string;
  /** The listing images (icon, screenshots), checked. */
  assets: PackedPluginAsset[];
}

export interface PackedPluginAsset {
  path: string;
  role: "icon" | "screenshot";
  contentType: string;
  sha256: string;
  bytes: Uint8Array;
}

/** A packed plugin with the lockfile source it came from. */
export type SourcedPackedPlugin = PackedPlugin & { source: string };

export interface PluginLockfile {
  version: 1;
  sandbox: boolean;
  plugins: Array<{ id: string; version: string; source: string; sha256: string }>;
}

export declare const root: string;
export declare const LOCKFILE: string;
export declare const BUNDLED_GEN: string;
export declare const SANDBOX_RUNTIME_GEN: string;
export declare const ASSETS_GEN: string;
export declare const CATALOG_GEN: string;
export declare function sha256(text: string): string;
export declare function readLockfile(path?: string): PluginLockfile;
export declare function renderLockfile(lockfile: PluginLockfile): string;
export declare function packPlugin(source: string): Promise<PackedPlugin>;
export declare function renderBundledGen(lockfile: PluginLockfile): string;
export declare function sealBundle(code: string, assets: ReadonlyArray<{ path: string; sha256: string }>): string;
export declare function packForGenerated(lockfile: PluginLockfile): Promise<{ bundled: SourcedPackedPlugin[]; catalog: SourcedPackedPlugin[] }>;
export declare function renderAssetsGen(packed: readonly PackedPlugin[]): string;
export declare function renderCatalogGen(packed: readonly SourcedPackedPlugin[]): string;
export declare function buildSandboxRuntime(): Promise<string>;
export declare function renderSandboxRuntimeGen(code: string): string;
