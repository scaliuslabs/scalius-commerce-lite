export interface TestExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
  exports: Record<string, unknown>;
}
export function trackBackground(promise: Promise<unknown>): void;
export function testExecutionContext<T extends object = Record<string, never>>(extra?: T): TestExecutionContext & T;
export function settleTestBackground(): Promise<void>;
export function unsettledBackground(): { pending: number; rejected: Array<{ error: unknown }> };
