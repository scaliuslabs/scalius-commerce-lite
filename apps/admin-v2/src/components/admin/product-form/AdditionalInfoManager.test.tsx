// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/components/ui/tiptap/DeferredTiptapEditor", () => ({
  DeferredTiptapEditor: ({
    content,
    onChange,
    placeholder,
  }: {
    content: string;
    onChange: (content: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "Rich text editor"}
      value={content}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

import { AdditionalInfoManager, type RichContentItem } from "./AdditionalInfoManager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AdditionalInfoManager", () => {
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
  });

  it("keeps a newly added rich-text section controlled without a render loop", async () => {
    function Harness() {
      const [items, setItems] = React.useState<RichContentItem[]>([]);
      return (
        <>
          <AdditionalInfoManager initialContent={items} onContentChange={setItems} />
          <output>{JSON.stringify(items)}</output>
        </>
      );
    }

    await act(async () => root.render(<Harness />));

    const addButton = [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Add section"));
    expect(addButton).toBeTruthy();
    await act(async () => addButton?.click());

    const titleInput = host.querySelector<HTMLInputElement>(
      'input[placeholder="Section title (e.g., Specifications)"]',
    );
    expect(titleInput).toBeTruthy();
    await changeInput(titleInput!, "Compatibility and setup");

    const contentInput = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Add content for this section..."]',
    );
    expect(contentInput).toBeTruthy();
    await changeInput(
      contentInput!,
      "Choose the finish, plug standard, and pack size required for installation.",
    );

    expect(host.querySelector("output")?.textContent).toContain("Compatibility and setup");
    expect(host.querySelector("output")?.textContent).toContain("plug standard");
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
  });
});

async function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
