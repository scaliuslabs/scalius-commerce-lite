import {
  SandboxOperationUnsupportedError,
  createSandboxSessionEnv,
  type SandboxApi,
  type SandboxFactory,
} from "@flue/runtime";

const PROVIDER = "scalius-capability-only";

function unsupported(operation: string): never {
  throw new SandboxOperationUnsupportedError({
    operation,
    provider: PROVIDER,
    options: [],
  });
}

const capabilityOnlyApi: SandboxApi = Object.freeze({
  readFile: async () => unsupported("readFile"),
  readFileBuffer: async () => unsupported("readFileBuffer"),
  writeFile: async () => unsupported("writeFile"),
  stat: async () => unsupported("stat"),
  readdir: async () => [],
  exists: async () => false,
  mkdir: async () => unsupported("mkdir"),
  rm: async () => unsupported("rm"),
  exec: async () => unsupported("exec"),
});

/**
 * Flue's omitted-sandbox default exposes shell and filesystem tools. The
 * storefront agent needs application capabilities only, so this factory
 * supplies an empty context filesystem and deliberately replaces every
 * adapter-provided model tool with an empty list.
 */
export const storefrontCapabilityOnlySandbox: SandboxFactory = Object.freeze({
  async createSessionEnv() {
    return createSandboxSessionEnv(capabilityOnlyApi, "/workspace");
  },
  tools: () => [],
});
