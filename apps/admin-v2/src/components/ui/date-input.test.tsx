// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "~/i18n";
import { DateInput } from "./date-input";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ initial, min }: { initial: string; min?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <DateInput id="when" aria-label="Start date" value={value} min={min} onValueChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe("DateInput", () => {
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
    setLocale("en");
  });

  /** The calendar's code arrives when the field is opened. */
  const opened = async () => {
    await act(async () => field().click());
    for (let attempt = 0; attempt < 60 && !document.querySelector("[data-day]"); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    }
  };
  const field = () => host.querySelector<HTMLButtonElement>("#when")!;
  const value = () => host.querySelector("output")!.textContent;

  it("writes the day with its month as a word, never 07/10/2026", async () => {
    await act(async () => root.render(<Harness initial="2026-10-07" />));
    expect(field().textContent).toBe("Oct 7, 2026");
    expect(field().textContent).not.toMatch(/\d{2}\/\d{2}/);
  });

  it("says so when there is no day yet, in the dashboard language", async () => {
    await act(async () => root.render(<Harness initial="" />));
    expect(field().textContent).toBe("Pick a date");
    setLocale("bn");
    await act(async () => root.render(<Harness initial="" />));
    expect(field().textContent).toBe("তারিখ বাছাই করুন");
  });

  it.each(["en", "bn"] as const)("includes the field name and visible date or placeholder in its accessible name in %s", async (locale) => {
    setLocale(locale);
    for (const current of ["2026-10-07", ""]) {
      await act(async () => root.render(<DateInput id="when" aria-label="Start date" value={current} onValueChange={() => {}} />));
      expect(field().textContent?.trim()).not.toBe("");
      expect(field().getAttribute("aria-label")).toBe(`Start date: ${field().textContent}`);
    }
  });

  it("picks a day from the calendar as YYYY-MM-DD, and clears it", async () => {
    await act(async () => root.render(<Harness initial="2026-10-07" />));
    await opened();
    const day = document.querySelector<HTMLButtonElement>('button[data-day="2026-10-15"]');
    expect(day).not.toBeNull();
    await act(async () => day!.click());
    expect(value()).toBe("2026-10-15");
    expect(field().textContent).toBe("Oct 15, 2026");
    expect(field().getAttribute("aria-label")).toBe("Start date: Oct 15, 2026");

    await opened();
    const clear = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Clear date");
    await act(async () => clear!.click());
    expect(value()).toBe("");
    expect(field().getAttribute("aria-label")).toBe("Start date: Pick a date");
  });

  it("does not offer days before the earliest", async () => {
    await act(async () => root.render(<Harness initial="2026-10-20" min="2026-10-10" />));
    await opened();
    expect(document.querySelector<HTMLButtonElement>('button[data-day="2026-10-09"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[data-day="2026-10-11"]')?.disabled).toBe(false);
  });
});
