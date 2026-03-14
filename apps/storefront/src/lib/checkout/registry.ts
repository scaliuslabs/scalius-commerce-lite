import type { GatewayHandler } from "./types";

const handlers = new Map<string, GatewayHandler>();

export function registerGateway(handler: GatewayHandler): void {
  handlers.set(handler.id, handler);
}

export function getGateway(id: string): GatewayHandler | undefined {
  return handlers.get(id);
}

export function getAllGateways(): GatewayHandler[] {
  return Array.from(handlers.values());
}
