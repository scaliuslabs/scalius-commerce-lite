import { AgentMcpHandler } from "./handler";

export class StorefrontMcpHandler extends AgentMcpHandler {
  readonly surface = "storefront" as const;
}
