// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", symbol: "৳", priceIncrementMinor: 100 }) }));

import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { ChoiceField, Field, FieldRow, FieldSet, ReadOnlyValue } from "./field";
import { Input } from "./input";
import { PercentInput } from "./number-input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { SearchableSelect } from "./searchable-select";
import { Textarea } from "./textarea";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Field", () => {
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
  const render = (node: React.ReactNode) => act(() => root.render(node));

  it("draws label, control and help with the harness slots, 4px apart", () => {
    render(<Field id="name" label="Name" help="Shown on the receipt."><Input /></Field>);
    const field = host.querySelector('[data-slot="field"]')!;
    expect(field.className).toContain("flex-col");
    expect(field.className).toContain("gap-1");
    expect([...field.children].map((child) => child.getAttribute("data-slot"))).toEqual(["field-label", "field-control", "field-help"]);
    const input = host.querySelector("input")!;
    expect(host.querySelector("label")!.htmlFor).toBe("name");
    expect(input.id).toBe("name");
    expect(input.getAttribute("aria-describedby")).toBe("name-help");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("replaces the help with the error and marks the control invalid (S3)", () => {
    render(<Field id="name" label="Name" help="Help" error="Enter a name."><Textarea /></Field>);
    expect(host.querySelector('[data-slot="field-help"]')).toBeNull();
    expect(host.querySelector('[data-slot="field-error"]')!.textContent).toBe("Enter a name.");
    const textarea = host.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.getAttribute("aria-describedby")).toBe("name-error");
  });

  it("makes up an id when none is given and lets the control's own props win", () => {
    render(<Field label="Code"><Input id="own" aria-describedby="elsewhere" /></Field>);
    const input = host.querySelector("input")!;
    expect(input.id).toBe("own");
    expect(input.getAttribute("aria-describedby")).toBe("elsewhere");
    render(<Field label="Code"><Input /></Field>);
    expect(host.querySelector("input")!.id).toBe(host.querySelector("label")!.htmlFor);
  });

  it("marks optional fields in words, never required ones (F7)", () => {
    render(<Field label="Company" optional><Input /></Field>);
    expect(host.querySelector("label")!.textContent).toBe("Company (optional)");
  });

  it("gives the field's id to a select's trigger", () => {
    render(
      <Field id="status" label="Status" error="Pick one">
        <SearchableSelect value="" onValueChange={() => {}} options={[{ value: "a", label: "A" }]} />
      </Field>,
    );
    const trigger = host.querySelector("#status")!;
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
  });

  it("never lends its id to a control inside a popover opened from the field", () => {
    render(
      <Field id="color" label="Colour">
        <Popover open>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent><Input data-testid="inside" /></PopoverContent>
        </Popover>
      </Field>,
    );
    expect(document.querySelector('[data-testid="inside"]')!.id).toBe("");
  });

  it("puts the currency and the percent sign inside the control, never in the label (F3)", () => {
    render(<Field label="Price"><MoneyInput currencyCode="BDT" value={720} onValueChange={() => {}} /></Field>);
    const box = host.querySelector('[data-slot="input-affix"]')!;
    expect(box.firstElementChild!.textContent).toBe("৳");
    expect(box.querySelector("input")!.value).toBe("720.00");
    expect(host.querySelector("label")!.textContent).toBe("Price");
    render(<Field label="Fee"><PercentInput value={2.5} onValueChange={() => {}} /></Field>);
    expect(host.querySelector('[data-slot="input-affix"]')!.lastElementChild!.textContent).toBe("%");
  });

  it("shows a value that cannot be edited as text, with a dash when empty (R5)", () => {
    render(<ReadOnlyValue label="SKU" value="" mono />);
    expect(host.querySelector('[data-slot="field-control"]')!.textContent).toBe("—");
    expect(host.querySelector("input")).toBeNull();
  });

  it("lays a row out on one grid and a choice with its label after the control", () => {
    render(
      <>
        <FieldRow><Field label="A"><Input /></Field><Field label="B"><Input /></Field></FieldRow>
        <ChoiceField id="track" label="Track quantity" help="Counts stock" control={<input type="checkbox" id="track" />} />
        <FieldSet label="Applies to"><button type="button">Pick</button></FieldSet>
      </>,
    );
    expect(host.querySelector('[data-slot="field-row"]')!.className).toContain("@md:grid-cols-2");
    const choice = host.querySelectorAll('[data-slot="field"]')[2]!;
    expect(choice.firstElementChild!.getAttribute("data-slot")).toBe("field-control");
    const group = host.querySelector('[role="group"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Applies to");
  });
});
