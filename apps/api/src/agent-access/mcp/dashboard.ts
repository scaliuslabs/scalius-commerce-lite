import { AgentMcpHandler } from "./handler";

export class DashboardMcpHandler extends AgentMcpHandler {
  readonly surface = "dashboard" as const;
}
