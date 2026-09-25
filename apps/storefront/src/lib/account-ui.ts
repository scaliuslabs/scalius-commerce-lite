// The account pages' one visual vocabulary. Every class reads the active
// theme's tokens (colours, radius, fonts), so the pages look native in every
// template: nothing here names a colour or a font.

/** One content width for every account page, so the nav never shifts. */
export const ACCOUNT_CONTAINER = "mx-auto w-full max-w-5xl px-4 pb-16 pt-6 sm:px-6 sm:pt-8";

export const accountUi = {
  card: "rounded-xl border border-border bg-card text-card-foreground",
  cardBody: "p-4 sm:p-5",
  cardTitle: "text-base font-semibold text-foreground",
  muted: "text-sm text-muted-foreground",
  primaryButton:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60",
  secondaryButton:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60",
  textButton: "inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline",
  field:
    "w-full rounded-lg border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 aria-[invalid=true]:border-destructive disabled:opacity-50 sm:text-sm",
  label: "mb-1.5 block text-sm font-medium text-foreground",
  fieldError: "mt-1 text-sm text-destructive",
  empty: "rounded-xl border border-dashed border-border px-6 py-12 text-center",
  emptyTitle: "text-base font-semibold text-foreground",
  emptyBody: "mx-auto mt-1 max-w-sm text-sm text-muted-foreground",
  notice: "rounded-xl border border-border bg-muted/40 p-4 text-sm text-foreground",
  errorNotice: "rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm font-medium text-destructive",
} as const;

export type AccountTone = "success" | "danger" | "warning" | "neutral";

const TONES: Record<AccountTone, string> = {
  success: "bg-primary/10 text-primary",
  danger: "bg-destructive/10 text-destructive",
  warning: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
  neutral: "bg-muted text-foreground",
};

/** A status pill in the given tone. */
export function accountPill(tone: AccountTone): string {
  return `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`;
}

/** An order status in buyer tones: delivered green, cancelled red, the rest neutral. */
export function orderStatusTone(status: string): AccountTone {
  if (status === "cancelled" || status === "returned") return "danger";
  if (status === "delivered" || status === "completed") return "success";
  return "neutral";
}
