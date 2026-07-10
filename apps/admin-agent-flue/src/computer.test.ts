import { expect, it } from "vitest";
import { createAdminComputerTool } from "./computer";

const INSTANCE_ID = `v1.${"a".repeat(43)}`;
const SIGNING_KEY = "admin-computer-test-signing-key-32-bytes-minimum";

it("exposes one compact computer tool whose result remains pending", async () => {
  const tool = createAdminComputerTool(INSTANCE_ID, SIGNING_KEY, {
    now: 1_800_000_000_000,
    randomBytes: new Uint8Array(16).fill(1),
  });
  expect(tool.name).toBe("computer");
  expect(tool.input).toBeDefined();
  expect(tool.output).toBeDefined();
  const result = await tool.run({ input: { program: "observe" } });
  expect(result).toMatchObject({
    type: "client_command",
    status: "awaiting_client_execution",
    authoritative: false,
    surface: "admin",
    program: "observe",
  });
  expect(result).not.toHaveProperty("ok");
});

it("rejects invalid and oversized programs before handoff", async () => {
  const tool = createAdminComputerTool(INSTANCE_ID, SIGNING_KEY);
  await expect(tool.run({ input: { program: "javascript alert(1)" } })).rejects.toThrow(
    "Invalid computer program",
  );
  await expect(tool.run({ input: { program: "x".repeat(4_097) } })).rejects.toThrow(
    "Invalid computer program",
  );
});
