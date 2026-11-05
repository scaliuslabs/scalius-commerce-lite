/**
 * The buyer's own pages as the editor's blocks: the cart page and the cart
 * drawer, the payment step, the order confirmation and the account. Each is
 * a few choices from closed lists (`blocks.cart`, `cartDrawer`, `checkout`,
 * `receipt`, `account`); the store draws the pages and keeps everything a
 * buyer must see and do there whatever is chosen, so nothing here hides a
 * part. This module loads only when one of these parts is selected.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  STOREFRONT_ACCOUNT_NAVIGATION_STYLES,
  STOREFRONT_CART_DRAWER_WIDTHS,
  STOREFRONT_PAYMENT_CHOICE_STYLES,
  STOREFRONT_PRIVATE_SUMMARY_PLACEMENTS,
  STOREFRONT_RECEIPT_LAYOUTS,
  type StorefrontPrivatePageBlock,
  type StorefrontReceiptSection,
} from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { ChoiceField, FieldSet } from "~/components/ui/field";
import { Switch } from "~/components/ui/switch";
import { useMessages } from "~/i18n";
import { themeEditorPrivatePageMessages } from "~/i18n/theme-editor-private-pages";
import type { SetTheme, Theme } from "../theme-fields";
import { Sketch, VisualChoice, type SketchPalette } from "../ThemeChoices";

const paletteOf = (theme: Theme): SketchPalette => {
  const { colors } = theme.tokens;
  return { paper: colors.background, ink: colors.foreground, line: colors["muted-foreground"], soft: colors.muted, edge: colors.border, accent: colors.primary };
};

/** One block of the document with some of its choices changed. */
function useBlock<Key extends StorefrontPrivatePageBlock>(key: Key, setDraft: SetTheme) {
  return (patch: Partial<Theme["blocks"][Key]>) =>
    setDraft((current) => ({ ...current, blocks: { ...current.blocks, [key]: { ...current.blocks[key], ...patch } } }));
}

/** A page with its form (or payment) and its summary: side by side, or the summary above. */
function SummarySketch({ placement, theme }: { placement: "side" | "top"; theme: Theme }) {
  const form = (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      {[0, 1, 2].map((row) => <span key={row} className="h-1.5 rounded-xs border border-(--sk-edge)" />)}
      <span className="mt-auto h-2 rounded-xs bg-(--sk-accent)" />
    </span>
  );
  const summary = <span className="flex flex-col gap-0.5 rounded-xs bg-(--sk-soft) p-1"><span className="h-0.5 w-3/4 bg-(--sk-line)" /><span className="h-0.5 w-1/2 bg-(--sk-ink)" /></span>;
  return (
    <Sketch palette={paletteOf(theme)} className="h-16">
      <span data-summary-sketch={placement} className={placement === "side" ? "flex min-h-0 flex-1 gap-1.5" : "mx-auto flex min-h-0 w-2/3 flex-1 flex-col gap-1"}>
        {placement === "side" ? <>{form}<span className="w-1/3">{summary}</span></> : <>{summary}{form}</>}
      </span>
    </Sketch>
  );
}

function PaymentSketch({ look: style, theme }: { look: "list" | "tiles"; theme: Theme }) {
  return (
    <Sketch palette={paletteOf(theme)} className="h-16">
      <span data-payment-sketch={style} className={style === "list" ? "flex min-h-0 flex-1 flex-col gap-1" : "grid min-h-0 flex-1 grid-cols-2 gap-1"}>
        {[0, 1, 2].map((index) => (
          <span key={index} className={`flex items-center gap-1 rounded-xs border p-0.5 ${index === 0 ? "border-(--sk-accent)" : "border-(--sk-edge)"} ${style === "tiles" && index === 2 ? "col-span-2 h-2 bg-(--sk-accent)/30" : ""}`}>
            <span className="size-1.5 rounded-full border border-(--sk-line)" />
            <span className="h-0.5 w-1/2 bg-(--sk-ink)" />
          </span>
        ))}
      </span>
    </Sketch>
  );
}

function ColumnsSketch({ columns, theme }: { columns: 1 | 2; theme: Theme }) {
  return (
    <Sketch palette={paletteOf(theme)} className="h-16">
      <span className={columns === 1 ? "mx-auto flex min-h-0 w-2/3 flex-1 flex-col gap-1" : "grid min-h-0 flex-1 grid-cols-[3fr_2fr] gap-1"}>
        <span className="rounded-xs border border-(--sk-edge) bg-(--sk-soft)" />
        <span className="flex flex-col gap-1">
          <span className="flex-1 rounded-xs border border-(--sk-edge)" />
          {columns === 2 && <span className="flex-1 rounded-xs border border-(--sk-edge)" />}
        </span>
      </span>
    </Sketch>
  );
}

function NavigationSketch({ look: style, theme }: { look: "tabs" | "sidebar"; theme: Theme }) {
  return (
    <Sketch palette={paletteOf(theme)} className="h-16">
      <span className={style === "tabs" ? "flex min-h-0 flex-1 flex-col gap-1" : "flex min-h-0 flex-1 gap-1.5"}>
        <span className={style === "tabs" ? "flex gap-1 border-b border-(--sk-edge) pb-0.5" : "flex w-1/4 flex-col gap-1 border-e border-(--sk-edge) pe-1"}>
          {[0, 1, 2].map((index) => <span key={index} className={`h-0.5 ${style === "tabs" ? "w-1/5" : "w-full"} ${index === 0 ? "bg-(--sk-accent)" : "bg-(--sk-line)"}`} />)}
        </span>
        <span className="grid min-h-0 flex-1 grid-cols-2 gap-1">
          {[0, 1].map((index) => <span key={index} className="rounded-xs border border-(--sk-edge)" />)}
        </span>
      </span>
    </Sketch>
  );
}

function MandatoryNote() {
  const t = useMessages(themeEditorPrivatePageMessages);
  return <p className="text-body text-muted-foreground">{t("mandatoryNote")}</p>;
}

/** The cart page's layout and the cart drawer. */
export function CartPresentationSettings({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(themeEditorPrivatePageMessages);
  const setCart = useBlock("cart", setDraft);
  const setDrawer = useBlock("cartDrawer", setDraft);
  return (
    <div className="space-y-5" data-private-page-settings="cart">
      <VisualChoice
        label={t("cartLayout")}
        showLabel
        value={theme.blocks.cart.summary}
        className="grid-cols-2"
        options={STOREFRONT_PRIVATE_SUMMARY_PLACEMENTS.map((value) => ({
          value,
          label: t(`cartSummary_${value}`),
          help: t(`cartSummary_${value}Help`),
          sketch: <SummarySketch placement={value} theme={theme} />,
        }))}
        onChange={(summary) => setCart({ summary })}
      />
      <VisualChoice
        label={t("drawerWidth")}
        showLabel
        value={theme.blocks.cartDrawer.width}
        className="grid-cols-2"
        options={STOREFRONT_CART_DRAWER_WIDTHS.map((value) => ({
          value,
          label: t(`drawerWidth_${value}`),
          help: t(`drawerWidth_${value}Help`),
          sketch: <ColumnsSketch columns={value === "wide" ? 2 : 1} theme={theme} />,
        }))}
        onChange={(width) => setDrawer({ width })}
      />
      <ChoiceField
        id="cart-drawer-recommendations"
        label={t("drawerRecommendations")}
        help={t("drawerRecommendationsHelp")}
        controlAt="end"
        control={(
          <Switch
            id="cart-drawer-recommendations"
            checked={theme.blocks.cartDrawer.recommendations === "shown"}
            onCheckedChange={(checked) => setDrawer({ recommendations: checked ? "shown" : "hidden" })}
          />
        )}
      />
      <MandatoryNote />
    </div>
  );
}

/** The payment step: where the summary sits and how the payment methods look. */
export function CheckoutPresentationSettings({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(themeEditorPrivatePageMessages);
  const setCheckout = useBlock("checkout", setDraft);
  return (
    <div className="space-y-5" data-private-page-settings="checkout">
      <VisualChoice
        label={t("checkoutSummary")}
        showLabel
        value={theme.blocks.checkout.summary}
        className="grid-cols-2"
        options={STOREFRONT_PRIVATE_SUMMARY_PLACEMENTS.map((value) => ({
          value,
          label: t(`checkoutSummary_${value}`),
          help: t(`checkoutSummary_${value}Help`),
          sketch: <SummarySketch placement={value} theme={theme} />,
        }))}
        onChange={(summary) => setCheckout({ summary })}
      />
      <VisualChoice
        label={t("paymentChoices")}
        showLabel
        value={theme.blocks.checkout.paymentChoices}
        className="grid-cols-2"
        options={STOREFRONT_PAYMENT_CHOICE_STYLES.map((value) => ({
          value,
          label: t(`paymentChoices_${value}`),
          help: t(`paymentChoices_${value}Help`),
          sketch: <PaymentSketch look={value} theme={theme} />,
        }))}
        onChange={(paymentChoices) => setCheckout({ paymentChoices })}
      />
      <MandatoryNote />
    </div>
  );
}

/** The order confirmation: its layout and the order of its cards (each always shown). */
export function ReceiptPresentationSettings({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(themeEditorPrivatePageMessages);
  const setReceipt = useBlock("receipt", setDraft);
  const sections = theme.blocks.receipt.sections;
  const [announcement, setAnnouncement] = useState("");
  const list = useRef<HTMLOListElement>(null);
  // The moved card keeps the focus: on the button it was moved with, or on its other one when
  // that button is now disabled (the card reached the top or the bottom).
  const moved = useRef<{ section: StorefrontReceiptSection; by: -1 | 1 } | null>(null);
  useEffect(() => {
    const last = moved.current;
    moved.current = null;
    if (!last) return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>(`[data-receipt-section="${last.section}"] button`) ?? [])];
    const [up, down] = buttons;
    const preferred = last.by === -1 ? up : down;
    (preferred && !preferred.disabled ? preferred : last.by === -1 ? down : up)?.focus();
  }, [sections]);
  const move = (section: StorefrontReceiptSection, by: -1 | 1) => {
    const from = sections.indexOf(section);
    const to = from + by;
    if (from < 0 || to < 0 || to >= sections.length) return;
    const next = [...sections];
    [next[from], next[to]] = [next[to]!, next[from]!];
    setReceipt({ sections: next });
    setAnnouncement(t("moved", { name: t(`receiptSection_${section}`), position: to + 1, count: next.length }));
    moved.current = { section, by };
  };
  return (
    <div className="space-y-5" data-private-page-settings="receipt">
      <VisualChoice
        label={t("receiptLayout")}
        showLabel
        value={theme.blocks.receipt.layout}
        className="grid-cols-2"
        options={STOREFRONT_RECEIPT_LAYOUTS.map((value) => ({
          value,
          label: t(`receiptLayout_${value}`),
          help: t(`receiptLayout_${value}Help`),
          sketch: <ColumnsSketch columns={value === "split" ? 2 : 1} theme={theme} />,
        }))}
        onChange={(layout) => setReceipt({ layout })}
      />
      <FieldSet label={t("receiptOrder")} help={t("receiptOrderHelp")}>
        <ol ref={list} className="divide-y divide-border rounded-lg border border-border" data-receipt-order>
          {sections.map((section, index) => {
            const name = t(`receiptSection_${section}`);
            return (
              <li key={section} className="flex min-h-11 items-center justify-between gap-2 ps-3 pe-1" data-receipt-section={section}>
                <span className="text-body">{name}</span>
                <span className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={t("moveUp", { name })} disabled={index === 0} onClick={() => move(section, -1)}>
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={t("moveDown", { name })} disabled={index === sections.length - 1} onClick={() => move(section, 1)}>
                    <ArrowDown aria-hidden="true" />
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>
      </FieldSet>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <MandatoryNote />
    </div>
  );
}

/** The account: where its menu sits. */
export function AccountPresentationSettings({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(themeEditorPrivatePageMessages);
  const setAccount = useBlock("account", setDraft);
  return (
    <div className="space-y-5" data-private-page-settings="account">
      <VisualChoice
        label={t("accountNavigation")}
        showLabel
        value={theme.blocks.account.navigation}
        className="grid-cols-2"
        options={STOREFRONT_ACCOUNT_NAVIGATION_STYLES.map((value) => ({
          value,
          label: t(`accountNavigation_${value}`),
          help: t(`accountNavigation_${value}Help`),
          sketch: <NavigationSketch look={value} theme={theme} />,
        }))}
        onChange={(navigation) => setAccount({ navigation })}
      />
    </div>
  );
}

/** The panel of one private-page part, by its editor part id. */
export default function PrivatePagePanel({ part, theme, setDraft }: { part: "cart" | "checkout" | "receipt" | "account"; theme: Theme; setDraft: SetTheme }) {
  switch (part) {
    case "cart": return <CartPresentationSettings theme={theme} setDraft={setDraft} />;
    case "checkout": return <CheckoutPresentationSettings theme={theme} setDraft={setDraft} />;
    case "receipt": return <ReceiptPresentationSettings theme={theme} setDraft={setDraft} />;
    case "account": return <AccountPresentationSettings theme={theme} setDraft={setDraft} />;
  }
}
