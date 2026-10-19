export declare const MANIFEST_PATH: string;
export declare const SOURCE_PATH: string;
export declare const REFERENCE_MAX_BYTES: number;
export declare function loadManifest(path?: string): unknown;
export declare function loadSource(path?: string): unknown;
export declare function requiredInputs(manifest: unknown, operation: unknown): string[];
export declare function generateRecipeFiles(manifest: unknown, source: unknown): Array<{ path: string; content: string }>;
export declare function referencedOperations(source: unknown): Array<{ id: string; planned: boolean }>;
