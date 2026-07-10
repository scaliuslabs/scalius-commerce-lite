// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  subscribeAdminAssistantHumanConfirmation,
  type AdminAssistantHumanActionEvent,
} from "~/lib/admin-assistant-human-confirmation";

import { GeneratedImagePanel } from "./GeneratedImagePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("GeneratedImagePanel confirmation lifecycle", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("cancels disappeared actions and rotates the per-open random nonce", async () => {
    const events: AdminAssistantHumanActionEvent[] = [];
    const unsubscribe = subscribeAdminAssistantHumanConfirmation((event) => {
      events.push({ ...event });
    });
    act(() => {
      root.render(
        <GeneratedImagePanel
          confirmationScope="media-picker"
          onSaved={vi.fn()}
        />,
      );
    });

    await clickButton("Generate with AI");
    const firstGenerateId = confirmationId("Generate image");
    const firstSaveId = firstGenerateId.replace(".generate.", ".save.");
    expect(firstGenerateId).toMatch(
      /^admin\.media\.image\.generate\.media-picker\.p[a-f0-9]{24}$/u,
    );

    await clickButton("Close generator");
    expect(events).toEqual(expect.arrayContaining([
      { actionId: firstGenerateId, phase: "cancelled" },
      { actionId: firstSaveId, phase: "cancelled" },
    ]));

    await clickButton("Generate with AI");
    const secondGenerateId = confirmationId("Generate image");
    const secondSaveId = secondGenerateId.replace(".generate.", ".save.");
    expect(secondGenerateId).not.toBe(firstGenerateId);

    act(() => root.unmount());
    unsubscribe();
    expect(events).toEqual(expect.arrayContaining([
      { actionId: secondGenerateId, phase: "cancelled" },
      { actionId: secondSaveId, phase: "cancelled" },
    ]));
    root = createRoot(host);
  });

  function confirmationId(label: string): string {
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes(label),
    );
    const id = button?.getAttribute(
      "data-scalius-computer-human-confirmation",
    );
    if (!id) throw new Error(`Missing confirmation ID for ${label}`);
    return id;
  }

  async function clickButton(label: string): Promise<void> {
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes(label),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
});
