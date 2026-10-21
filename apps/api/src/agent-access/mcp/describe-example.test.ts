// scalius_describe's example input: what an agent copies must be sendable.
import { describe, expect, it } from "vitest";
import { AGENT_OPERATIONS } from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { describeForAgent, exampleInput } from "./describe";

function operationWithBody(schema: Record<string, unknown>): AgentOperationManifestEntry {
  return { inputSchema: { requestBody: { content: { "application/json": { schema } } } } } as unknown as AgentOperationManifestEntry;
}

describe("describe examples", () => {
  it("an id whose pattern fixes its prefix shows the prefix", () => {
    const example = exampleInput(operationWithBody({
      type: "object",
      required: ["imageId", "name"],
      properties: { imageId: { type: "string", pattern: "^pmed_[A-Za-z0-9_-]+$" }, name: { type: "string" } },
    }));
    expect(example).toEqual({ body: { imageId: "pmed_<imageId>", name: "<name>" } });
  });

  it("products.create takes media files by mediaId alone", () => {
    const create = AGENT_OPERATIONS.find((operation) => operation.operationId === "dashboard.products.create");
    expect(create).toBeDefined();
    const described = describeForAgent(create!, "compact").value as { inputs: { body: string[] } };
    expect(described.inputs.body).toContain("media:{id,mediaId!,altText,isPrimary}[]");
    // Media is optional: the example sends none rather than a placeholder attachment id.
    expect((exampleInput(create!, true) as { body: { media?: unknown[] } }).body.media).toEqual([]);
  });
});
