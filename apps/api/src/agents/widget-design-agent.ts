import { Agent } from "agents";
import {
  createInitialWidgetDesignAgentState,
  type WidgetDesignAgentStoredEvent,
  type WidgetDesignAgentState,
} from "./widget-design-agent-types";

export class WidgetDesignAgent extends Agent<Env, WidgetDesignAgentState> {
  initialState = createInitialWidgetDesignAgentState();
  private designSchemaReady = false;

  private ensureDesignSchema(): void {
    if (this.designSchemaReady) return;
    const _createEventsTableResult = this.sql`
      CREATE TABLE IF NOT EXISTS widget_design_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    const _createEventsIndexResult = this
      .sql`CREATE INDEX IF NOT EXISTS widget_design_events_run_idx ON widget_design_events (run_id, id)`;
    this.designSchemaReady = true;
  }

  private recordEvent(
    runId: string,
    event: WidgetDesignAgentStoredEvent,
  ): void {
    if (event.type === "draft.delta") return;
    this.ensureDesignSchema();
    const _insertEventResult = this.sql`
      INSERT INTO widget_design_events (run_id, type, payload, created_at)
      VALUES (${runId}, ${event.type}, ${JSON.stringify(event)}, ${Date.now()})
    `;
  }

  private updateRunState(next: Partial<WidgetDesignAgentState>): void {
    this.setState({
      ...this.state,
      ...next,
      lastEventAt: Date.now(),
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      return Response.json({ success: true, data: this.state });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const { streamWidgetDesignAgentRun } =
      await import("./widget-design-agent-runtime");
    return streamWidgetDesignAgentRun({
      env: this.env,
      request,
      recordEvent: (runId, event) => this.recordEvent(runId, event),
      updateRunState: (next) => this.updateRunState(next),
    });
  }
}
