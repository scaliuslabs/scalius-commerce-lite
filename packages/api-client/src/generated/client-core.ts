// Generated post-process shim for dev/runtime module resolution.
// The generated SDK sources need a stable local module, while the repo runs the
// packages directly from source in Vite/Workers dev. Re-export the official ESM
// runtime package instead of the generated CommonJS bundle.
export * from "@hey-api/client-fetch";
