import {
  createSandboxSessionEnv,
  type DurabilityConfig,
  type SandboxFactory,
} from "@flue/runtime";

export const ADMIN_AGENT_DURABILITY: Readonly<DurabilityConfig> = Object.freeze({
  maxAttempts: 1,
  timeoutMs: 120_000,
});

export const ADMIN_AGENT_CAPABILITY_CALL_LIMIT = 4;

const unavailable = (): Error => new Error("The agent workspace is unavailable");

/**
 * Flue otherwise installs its default shell/filesystem tools. Admin work must
 * go through the authenticated `computer` and `scalius` capabilities only.
 */
export const ADMIN_CAPABILITY_ONLY_SANDBOX: SandboxFactory = Object.freeze({
  async createSessionEnv() {
    return createSandboxSessionEnv(
      {
        async exec() {
          throw unavailable();
        },
        async readFile() {
          throw unavailable();
        },
        async readFileBuffer() {
          throw unavailable();
        },
        async writeFile() {
          throw unavailable();
        },
        async stat() {
          throw unavailable();
        },
        async readdir() {
          return [];
        },
        async exists() {
          return false;
        },
        async mkdir() {},
        async rm() {},
      },
      "/",
    );
  },
  tools: () => [],
});

export function createAdminCapabilityCallBudget(
  limit = ADMIN_AGENT_CAPABILITY_CALL_LIMIT,
): () => void {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls > limit) {
      throw new Error("The capability call limit for this request was reached");
    }
  };
}
