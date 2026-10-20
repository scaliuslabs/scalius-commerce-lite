// The dispatcher's input shape and refusal, apart from the dispatcher itself:
// the confirmation gate and approvals run on every gated admin agent request
// and must not load the dispatcher (and with it the full operation manifest).

export type AgentInputPrimitive = string | number | boolean | null;

export interface AgentOperationInput {
  path?: Record<string, string | number | boolean>;
  query?: Record<string, AgentInputPrimitive | AgentInputPrimitive[]>;
  body?: unknown;
  idempotencyKey?: string;
}

export class AgentDispatchError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AgentDispatchError";
    this.code = code;
    this.status = status;
  }
}
