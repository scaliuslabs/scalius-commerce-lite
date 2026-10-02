// Account → Profile → News and offers: the posted preferences form, read the
// same way with and without JavaScript (a plain POST, Post/Redirect/Get).
// The form shows each channel the account has an address for as a box, with
// what it showed (`was_<channel>`), so a save sends only the channels the
// buyer changed: an e-mail already waiting for its link is not asked again.
// Only an outcome flag enters the URL.
import { MARKETING_CHANNELS, type MarketingChannel } from "@scalius/shared/customer-marketing";
import type { AccountMarketingChannel } from "@/lib/account-server";

export const ACCOUNT_MARKETING_INTENT = "marketing";
export const ACCOUNT_MARKETING_ANCHOR = "marketing";

export type AccountMarketingFlag = "saved" | "confirm";

/** A channel's box is ticked while it is subscribed or waiting for its e-mail link. */
export function accountMarketingOn(row: Pick<AccountMarketingChannel, "status">): boolean {
  return row.status === "subscribed" || row.status === "pending";
}

/** The channels the buyer changed, as the API's on/off update. */
export function readAccountMarketingForm(form: FormData): Partial<Record<MarketingChannel, boolean>> {
  const ticked = new Set(form.getAll("channel").filter((value): value is string => typeof value === "string"));
  const update: Partial<Record<MarketingChannel, boolean>> = {};
  for (const channel of MARKETING_CHANNELS) {
    const before = form.get(`was_${channel}`);
    if (before !== "on" && before !== "off") continue;
    const wanted = ticked.has(channel);
    if (wanted !== (before === "on")) update[channel] = wanted;
  }
  return update;
}

/** Where a save lands: the profile with only the outcome flag, at the section. */
export function accountMarketingLocation(flag: AccountMarketingFlag): string {
  return `/account/profile?${new URLSearchParams({ marketing: flag })}#${ACCOUNT_MARKETING_ANCHOR}`;
}

export function readAccountMarketingFlag(search: URLSearchParams): AccountMarketingFlag | null {
  const flag = search.get("marketing");
  return flag === "saved" || flag === "confirm" ? flag : null;
}
