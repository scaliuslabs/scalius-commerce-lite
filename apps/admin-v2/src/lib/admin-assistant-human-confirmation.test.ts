import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_ASSISTANT_HUMAN_ACTIONS,
  adminAssistantHumanActionId,
  cancelAdminAssistantHumanAction,
  claimAdminAssistantHumanAction,
  finishAdminAssistantHumanAction,
  subscribeAdminAssistantHumanConfirmation,
} from "./admin-assistant-human-confirmation";

describe("Admin assistant human confirmation broker", () => {
  it("delivers only a bounded app action and outcome to active subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAdminAssistantHumanConfirmation(listener);

    const operation = claimAdminAssistantHumanAction(
      adminAssistantHumanActionId(
        ADMIN_ASSISTANT_HUMAN_ACTIONS.generateImage,
        "library-page",
        "panel-a",
      ),
      trustedClick(),
    );
    if (!operation) throw new Error("trusted activation was not claimed");
    finishAdminAssistantHumanAction(operation, "succeeded");
    finishAdminAssistantHumanAction(operation, "failed");
    unsubscribe();
    const ignoredAfterUnsubscribe = claimAdminAssistantHumanAction(
      adminAssistantHumanActionId(
        ADMIN_ASSISTANT_HUMAN_ACTIONS.saveGeneratedImage,
        "media-picker",
        "panel-b",
      ),
      trustedClick(),
    );
    if (!ignoredAfterUnsubscribe) {
      throw new Error("trusted activation was not claimed");
    }
    finishAdminAssistantHumanAction(ignoredAfterUnsubscribe, "failed");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, {
      actionId: "admin.media.image.generate.library-page.panel-a",
      operationId: expect.stringMatching(/^aho_[a-f0-9]{24}$/u),
      phase: "started",
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      actionId: "admin.media.image.generate.library-page.panel-a",
      operationId: operation.operationId,
      phase: "finished",
      outcome: "succeeded",
    });
  });

  it("never claims a synthetic model click and emits cancellation without a success token", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAdminAssistantHumanConfirmation(listener);
    const actionId = adminAssistantHumanActionId(
      ADMIN_ASSISTANT_HUMAN_ACTIONS.saveGeneratedImage,
      "library-page",
      "panel-c",
    );

    expect(claimAdminAssistantHumanAction(actionId, new Event("click")))
      .toBeNull();
    cancelAdminAssistantHumanAction(actionId);
    unsubscribe();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      actionId,
      phase: "cancelled",
    });
  });
});

function trustedClick(): Event {
  const event = new Event("click");
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}
