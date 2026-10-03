// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ code: "BDT", priceIncrementMinor: undefined as number | undefined }));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: store.code, priceIncrementMinor: store.priceIncrementMinor }) }));

import { Form, FormControl, FormField, FormItem, FormMessage } from "~/components/ui/form";
import { translate } from "~/i18n";
import { formMessages } from "~/i18n/forms";
import { useFormWithRefusals } from "~/lib/input-refusals";
import { MoneyInput } from "./MoneyInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MoneyInput", () => {
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

  it("takes whole taka only, and keeps cents for other currencies", () => {
    const onValueChange = vi.fn();
    act(() => root.render(<MoneyInput aria-label="Taka" currencyCode="BDT" value={null} onValueChange={onValueChange} />));
    const taka = host.querySelector("input")!;
    act(() => type(taka, "75.4"));
    // Refused (NaN), never rewritten to 754; number-input.test.tsx covers the kept text.
    expect(onValueChange).toHaveBeenLastCalledWith(Number.NaN);
    expect(taka.validationMessage).toBe("Taka amounts are whole numbers.");

    act(() => root.render(<MoneyInput aria-label="Dollars" currencyCode="USD" value={null} onValueChange={onValueChange} />));
    const dollars = host.querySelector("input")!;
    act(() => type(dollars, "75.4"));
    expect(onValueChange).toHaveBeenLastCalledWith(75.4);
    expect(dollars.inputMode).toBe("decimal");
  });

  describe("in a react-hook-form form", () => {
    const schema = z.object({ amount: z.number("Enter a number"), other: z.number("Enter a number").nullable() });
    type Values = z.infer<typeof schema>;
    const submitted = vi.fn();

    function Page({ refusals }: { refusals: boolean }) {
      const options = { resolver: zodResolver(schema), mode: "onBlur" as const, defaultValues: { amount: 10, other: 5 } };
      const refusing = useFormWithRefusals<Values>(options);
      const plain = useForm<Values>(options);
      const form = refusals ? refusing : plain;
      return (
        <Form {...form}>
          <form noValidate onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(submitted)(); }}>
            {(["amount", "other"] as const).map((name) => (
              <FormField
                key={name}
                control={form.control}
                name={name}
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <MoneyInput aria-label={name} name={field.name} currencyCode={store.code} value={field.value} onValueChange={field.onChange} onBlur={field.onBlur} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <button type="submit">Save</button>
          </form>
        </Form>
      );
    }

    const field = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label=${name}]`)!;
    const messages = () => [...host.querySelectorAll("p")].map((message) => message.textContent);
    const leave = (input: HTMLInputElement) => act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    const submit = () => act(async () => { host.querySelector("form")!.requestSubmit(); });

    beforeEach(() => {
      submitted.mockReset();
      store.code = "BDT";
      store.priceIncrementMinor = undefined;
    });

    it("tells any money field's form that a fraction is refused because the store prices in whole taka", async () => {
      await act(async () => root.render(<Page refusals />));
      await act(async () => type(field("other"), "75.4"));
      await leave(field("other"));
      expect(messages()).toEqual([translate(formMessages, "wholeTaka")]);

      // Submitting validates the whole form again: the reason survives it.
      await submit();
      expect(submitted).not.toHaveBeenCalled();
      expect(messages()).toEqual([translate(formMessages, "wholeTaka")]);

      await act(async () => type(field("other"), "75"));
      expect(messages()).toEqual([]);
      await submit();
      expect(submitted).toHaveBeenCalledTimes(1);
      expect(submitted.mock.calls[0]![0]).toEqual({ amount: 10, other: 75 });
    });

    it("uses the whole-amounts copy in another currency, and the schema's message for text that isn't a number", async () => {
      store.code = "USD";
      store.priceIncrementMinor = 100;
      await act(async () => root.render(<Page refusals />));
      await act(async () => type(field("amount"), "9.5"));
      await leave(field("amount"));
      expect(messages()).toEqual([translate(formMessages, "wholeUnits")]);
      await act(async () => type(field("amount"), "9x"));
      await leave(field("amount"));
      expect(messages()).toEqual(["Enter a number"]);
    });

    it("leaves a form built with plain useForm on the schema's message", async () => {
      await act(async () => root.render(<Page refusals={false} />));
      await act(async () => type(field("amount"), "75.4"));
      await leave(field("amount"));
      expect(messages()).toEqual(["Enter a number"]);
    });
  });
});
