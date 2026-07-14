// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GeneralSettingsPanel,
  GeneralSettingsSection,
} from "./general-settings-sections";

vi.mock("../header-builder", () => ({
  HeaderBuilder: () => {
    throw new Error("Header editor render failure");
  },
}));

vi.mock("../footer-builder", () => ({
  FooterBuilder: () => <div>Footer editor ready</div>,
}));

import GeneralSettingsPage from "./GeneralSettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("GeneralSettingsPage editor isolation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    consoleError.mockRestore();
    document.body.innerHTML = "";
  });

  function Harness() {
    const [section, setSection] = useState<GeneralSettingsSection>("header");
    const [panel, setPanel] = useState<GeneralSettingsPanel | undefined>();

    return (
      <GeneralSettingsPage
        section={section}
        panel={panel}
        onSectionChange={setSection}
        onPanelChange={setPanel}
      />
    );
  }

  it("keeps the settings workspace usable when one editor crashes", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Header settings could not be opened.",
    );
    expect(host.textContent).toContain("General Settings");
    expect(host.textContent).not.toContain("Something went wrong loading settings");

    const footerTab = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.trim() === "Footer");
    if (!footerTab) throw new Error("Expected Footer settings tab");

    await act(async () => {
      footerTab.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });

    expect(host.textContent).toContain("Footer editor ready");
    expect(host.textContent).toContain("General Settings");
  });
});
