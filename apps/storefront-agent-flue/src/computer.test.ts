import { expect, it } from "vitest";
import {
  parseScaliusComputerProgram,
  SCALIUS_COMPUTER_LIMITS,
} from "@scalius/shared/assistant-computer";
import {
  createStorefrontComputerTool,
  STOREFRONT_COMPUTER_DOCUMENTED_PROGRAMS,
  STOREFRONT_COMPUTER_TOOL_DESCRIPTION,
} from "./computer";

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
  await expect(tool.run({
    input: { program: "x".repeat(SCALIUS_COMPUTER_LIMITS.programChars + 1) },
  })).rejects.toThrow("Invalid computer program");
});

it("hands off one boundary-sized rich value", async () => {
  const tool = createStorefrontComputerTool(INSTANCE_ID, SIGNING_KEY);
  const value = `<p>${"x".repeat(3_993)}</p>`;
  const program = `fill @r1.e1 ${JSON.stringify(value)}`;
  await expect(tool.run({ input: { program } })).resolves.toMatchObject({
    program,
    surface: "storefront",
  });
});

it("keeps every documented computer form parser-valid and its batching constraints exact", () => {
  for (const program of STOREFRONT_COMPUTER_DOCUMENTED_PROGRAMS) {
    expect(
      parseScaliusComputerProgram(program),
      `documented program: ${program}`,
    ).toMatchObject({ ok: true });
  }
  expect(STOREFRONT_COMPUTER_TOOL_DESCRIPTION).toContain("help [command]");
  expect(STOREFRONT_COMPUTER_TOOL_DESCRIPTION).toContain("submit @rN.eN");
  expect(STOREFRONT_COMPUTER_TOOL_DESCRIPTION).toContain("with semicolons");
  expect(STOREFRONT_COMPUTER_TOOL_DESCRIPTION).not.toContain(
    "/categories/shoes",
  );

  const invalidBatches = [
    "observe; click @r1.e1",
    "help goto; click @r1.e1",
    'goto "/known-route"; click @r1.e1',
    "refresh; click @r1.e1",
    'fill @r1.e1 "text"; select @r2.e2 "value"',
    'click @r1.e1; fill @r1.e2 "text"',
    "click @r1.e1; submit @r1.e2",
  ];
  for (const program of invalidBatches) {
    expect(
      parseScaliusComputerProgram(program),
      `invalid batch: ${program}`,
    ).toMatchObject({ ok: false });
  }
});
