// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TemplateSelect } from "./TemplateSelect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps an unknown saved template selectable and restores the empty theme default", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let saved: string | null = "retired";
  function Form() {
    const [value, setValue] = useState<string | null>(saved);
    return <TemplateSelect kind="listing" value={value} onChange={(next) => { saved = next; setValue(next); }} />;
  }
  try {
    act(() => root.render(<Form />));
    const trigger = host.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    expect(trigger.textContent).toContain("retired (no longer offered)");
    expect(host.querySelector("select")).toBeNull();
    act(() => trigger.click());
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.some((option) => option.textContent?.includes("retired (no longer offered)"))).toBe(true);
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("Layout");
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("Filters");
    act(() => options.find((option) => option.textContent?.trim() === "Theme default")!.click());
    expect(saved).toBeNull();
    expect(trigger.textContent).toBe("Theme default");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("closes an open picker on permission revocation and shows the saved template as text", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  try {
    act(() => root.render(<TemplateSelect kind="listing" value="retired" onChange={onChange} />));
    act(() => host.querySelector<HTMLButtonElement>('button[role="combobox"]')!.click());
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    act(() => root.render(<TemplateSelect kind="listing" value="retired" onChange={onChange} readOnly />));
    expect(host.textContent).toContain("retired (no longer offered)");
    expect(host.querySelector("button")).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
