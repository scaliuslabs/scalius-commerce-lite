import { expect, it } from "vitest";
import { createStorefrontComputerTool } from "./computer";

const INSTANCE_ID = `v1.${"b".repeat(43)}`;
const SIGNING_KEY = "storefront-computer-test-signing-key-32-bytes";

it("exposes one compact computer tool whose result remains pending", async () => {
  const tool = createStorefrontComputerTool(INSTANCE_ID, SIGNING_KEY, {
    now: 1_800_000_000_000,
    randomBytes: new Uint8Array(16).fill(2),
  });
  expect(tool.name).toBe("computer");
  expect(tool.input).toBeDefined();
  expect(tool.output).toBeDefined();
  const result = await tool.run({ input: { program: "goto /products" } });
  expect(result).toMatchObject({
    type: "client_command",
    status: "awaiting_client_execution",
    authoritative: false,
    surface: "storefront",
    program: "goto /products",
  });
  expect(result).not.toHaveProperty("ok");
});

it("rejects arbitrary URLs and JavaScript instead of handing them to the client", async () => {
  const tool = createStorefrontComputerTool(INSTANCE_ID, SIGNING_KEY);
  await expect(tool.run({ input: { program: "goto https://evil.test" } })).rejects.toThrow(
    "Invalid computer program",
  );
  await expect(tool.run({ input: { program: "javascript alert(1)" } })).rejects.toThrow(
    "Invalid computer program",
  );
});
