import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(new URL("..", import.meta.url).pathname);
const adminConfig = readJson("apps/admin-agent/wrangler.jsonc");
const storefrontConfig = readJson("apps/storefront-agent/wrangler.jsonc");
const adminPackage = readJson("apps/admin-agent/package.json");
const storefrontPackage = readJson("apps/storefront-agent/package.json");
const runtimePackage = readJson("packages/agent-runtime/package.json");
const rootPackage = readJson("package.json");

const forbiddenBindingKeys = [
  "ai",
  "browser",
  "d1_databases",
  "hyperdrive",
  "kv_namespaces",
  "queues",
  "r2_buckets",
  "send_email",
  "vectorize",
];

describe("dedicated Agent Worker manifests", () => {
  it("defines two independent Worker identities and public exposure policies", () => {
    expect(adminConfig).toMatchObject({
      name: "scalius-admin-agent",
      main: "./src/worker.ts",
      compatibility_date: "2026-07-09",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      observability: {
        enabled: true,
        head_sampling_rate: 1,
      },
    });
    expect(storefrontConfig).toMatchObject({
      name: "scalius-storefront-agent",
      main: "./src/worker.ts",
      compatibility_date: "2026-07-09",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: true,
      routes: [
        {
          pattern: "agent.scalius.com",
          custom_domain: true,
        },
      ],
      observability: {
        enabled: true,
        head_sampling_rate: 1,
      },
    });
    expect(adminConfig.name).not.toBe(storefrontConfig.name);
  });

  it("gives each Worker only the API service binding and surface-safe variables", () => {
    expect(adminConfig.services).toEqual([
      { binding: "API", service: "scalius-api" },
    ]);
    expect(storefrontConfig.services).toEqual([
      { binding: "API", service: "scalius-api" },
    ]);
    expect(Object.keys(adminConfig.vars).sort()).toEqual([
      "AGENT_NAME",
      "AGENT_VERSION",
    ]);
    expect(Object.keys(storefrontConfig.vars).sort()).toEqual([
      "AGENT_NAME",
      "AGENT_PROFILE_URL",
      "AGENT_VERSION",
      "STOREFRONT_URL",
    ]);

    expect(adminConfig.durable_objects).toEqual({
      bindings: [{
        name: "ADMIN_CONVERSATIONS",
        class_name: "AdminConversationDurableObject",
      }],
    });
    expect(adminConfig.migrations).toEqual([{
      tag: "v1",
      new_sqlite_classes: ["AdminConversationDurableObject"],
    }]);
    expect(storefrontConfig.durable_objects).toEqual({
      bindings: [{
        name: "STOREFRONT_CONVERSATIONS",
        class_name: "StorefrontConversationDurableObject",
      }],
    });
    expect(storefrontConfig.migrations).toEqual([{
      tag: "v1",
      new_sqlite_classes: ["StorefrontConversationDurableObject"],
    }]);

    for (const config of [adminConfig, storefrontConfig]) {
      for (const key of forbiddenBindingKeys) {
        expect(config, `${config.name} must not declare ${key}`).not.toHaveProperty(
          key,
        );
      }
    }
  });

  it("keeps the runtime in packages with only explicit surface subpaths", () => {
    expect(existsSync(resolve(root, "apps/agent"))).toBe(false);
    expect(runtimePackage.name).toBe("@scalius/agent-runtime");
    expect(runtimePackage.exports).toEqual({
      "./admin": "./src/admin-runtime.ts",
      "./conversation": "./src/conversation/index.ts",
      "./storefront": "./src/storefront-runtime.ts",
      "./http": "./src/http.ts",
    });
    expect(runtimePackage).not.toHaveProperty("main");
  });

  it("wires independent package and root deploy commands", () => {
    expect(adminPackage.name).toBe("@scalius/admin-agent");
    expect(storefrontPackage.name).toBe("@scalius/storefront-agent");
    expect(adminPackage.dependencies).toEqual({
      "@scalius/agent-runtime": "workspace:*",
    });
    expect(storefrontPackage.dependencies).toEqual({
      "@scalius/agent-runtime": "workspace:*",
    });
    expect(rootPackage.scripts["deploy:admin-agent"]).toContain(
      "--only admin-agent",
    );
    expect(rootPackage.scripts["deploy:storefront-agent"]).toContain(
      "--only storefront-agent",
    );
    expect(rootPackage.scripts).not.toHaveProperty("deploy:agent");
    expect(runtimePackage.dependencies).toMatchObject({
      "@scalius/shared": "workspace:*",
    });
  });

  it("prevents either entrypoint from importing the other surface", () => {
    const adminSource = readText("apps/admin-agent/src/worker.ts");
    const storefrontSource = readText("apps/storefront-agent/src/worker.ts");

    expect(adminSource).toContain("@scalius/agent-runtime/admin");
    expect(adminSource).toContain("AdminConversationDurableObject");
    expect(adminSource).not.toContain("@scalius/agent-runtime/storefront");
    expect(storefrontSource).toContain("@scalius/agent-runtime/storefront");
    expect(storefrontSource).toContain("StorefrontConversationDurableObject");
    expect(storefrontSource).not.toContain("@scalius/agent-runtime/admin");
  });
});

function readText(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}
