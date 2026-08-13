import app from "../app";
import { finalizeOpenApiContract } from "../openapi-contract";
import {
  writeAgentOperationManifest,
  writeOpenApiContractModule,
} from "./generate-agent-operation-manifest";

const spec = finalizeOpenApiContract(
  app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: {
      title: "Scalius Commerce API",
      version: "1.0.0",
      description: "E-commerce platform API powering admin dashboard and storefront",
    },
    servers: [{ url: "/", description: "Default" }],
  }),
);

const source = writeAgentOperationManifest(spec);
writeOpenApiContractModule(spec);
console.log(
  `Generated ${source.match(/"operationId":/g)?.length ?? 0} agent operation records.`,
);
