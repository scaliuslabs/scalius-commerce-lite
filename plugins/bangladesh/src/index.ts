// Scalius Bangladesh pack (`scalius.bangladesh`): what a Bangladeshi store
// needs that a store elsewhere does not, as one first-party app built only on
// the public plugin contract. A store outside Bangladesh carries none of it.
//
// - SMS (sms.ts): SMS.net.bd, BDBulkSMS, MIM SMS and GenNet iSMS as SMS
//   providers. The merchant chooses one in Settings → Notifications; order
//   messages and sign-in codes go through it.
// - Fraud checks (fraud.ts): FraudBD, FraudGuard, eCourier Fraud Alert and
//   the custom fraudchecker.link API on the order page (advice, never
//   blocking), for Bangladesh buyers only.
// - Places (places.ts): the City/Thana/Area directory, loaded through the
//   place import on activation and kept current by the hourly `places-sync`.
//
// Each provider names the settings it needs (`providers.*[].settings`), so
// the dashboard shows each one ready or not on its own. The stores that set
// these up in core before the move keep them: activating the pack moves the
// saved keys into its settings (apps/api/src/plugins/provider-handoff.ts).

import {
  adminLocale,
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  type PluginContext,
  type PluginManifestInput,
  type PluginRouteRequest,
} from "@scalius/plugin-sdk";
import { FRAUD_CHECKERS, fraudProviders } from "./fraud";
import { PLACES_TOTAL, PLACES_VERSION, placesCurrent, readPlacesState, seedPlaces, type PlacesState } from "./places";
import { SMS_HOSTS, smsProviders } from "./sms";

const secret = (key: string, label: string, help?: string) => ({ key, label, type: "secret" as const, ...(help ? { help } : {}) });
const text = (key: string, label: string, maxLength: number, help?: string) => ({ key, label, type: "text" as const, maxLength, ...(help ? { help } : {}) });
const url = (key: string, label: string, fallback: string) => ({ key, label, type: "url" as const, default: fallback, help: "Change it only when the service gives you another address." });

export const manifest = {
  id: "scalius.bangladesh",
  name: "Bangladesh pack",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Everything a store in Bangladesh needs in one app: send order messages and sign-in codes through SMS.net.bd, BDBulkSMS, MIM SMS or GenNet; check a buyer's courier history with FraudBD, FraudGuard, eCourier or FraudChecker from the order page; and load the City, Thana and Area list (Pathao's delivery places) for addresses and shipping zones.",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  tagline: "Bangladesh pack: SMS, fraud checks, places",
  categories: ["notifications", "orders", "shipping"],
  countries: ["BD"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  documentationUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/blob/mono-repo/plugins/bangladesh/README.md",
  changelogUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/commits/mono-repo/plugins/bangladesh",
  minPlatformVersion: "1.0.0",
  // The place import (dashboard.delivery_locations.import).
  permissions: ["settings.delivery_locations.edit"],
  allowedHosts: [...SMS_HOSTS, ...new Set(Object.values(FRAUD_CHECKERS).flatMap((checker) => checker.hosts))],
  settings: [
    secret("smsnetbd_api_key", "SMS.net.bd: API key"),
    text("smsnetbd_sender_id", "SMS.net.bd: sender ID", 128, "Only when SMS.net.bd approved a sender ID for you."),
    secret("bdbulksms_token", "BDBulkSMS: token"),
    text("mimsms_username", "MIM SMS: username (email)", 320),
    secret("mimsms_api_key", "MIM SMS: API key"),
    text("mimsms_sender_name", "MIM SMS: sender name", 128, "The sender name registered with MIM SMS."),
    secret("gennet_api_token", "GenNet: API token"),
    { key: "gennet_base_url", label: "GenNet: account address", type: "url", help: "Your account's address, for example https://yourshop.gennet.com.bd." },
    text("gennet_sid", "GenNet: sender ID (SID)", 128),
    url("fraudchecker_api_url", "FraudChecker: API URL", "https://fraudchecker.link/api/v1/qc/"),
    secret("fraudchecker_token", "FraudChecker: bearer token"),
    url("fraudbd_api_url", "FraudBD: API URL", "https://fraudbd.com/api/check-courier-info"),
    secret("fraudbd_api_key", "FraudBD: API key"),
    text("fraudbd_username", "FraudBD: username", 200),
    secret("fraudbd_password", "FraudBD: password"),
    url("fraudguard_api_url", "FraudGuard: API URL", "https://fraudguard.slope.com.bd/api/v1/fraud-check"),
    secret("fraudguard_api_key", "FraudGuard: API key"),
    secret("fraudguard_api_secret", "FraudGuard: API secret"),
    url("ecourier_api_url", "eCourier: API URL", "https://backoffice.ecourier.com.bd/api/fraud-status-check"),
    secret("ecourier_api_key", "eCourier: API key"),
    secret("ecourier_api_secret", "eCourier: API secret"),
    text("ecourier_user_id", "eCourier: user ID", 200),
  ],
  providers: {
    sms: [
      { id: "smsnetbd", name: "SMS.net.bd", settings: ["smsnetbd_api_key"] },
      { id: "bdbulksms", name: "BDBulkSMS (GreenWeb)", settings: ["bdbulksms_token"] },
      { id: "mimsms", name: "MIM SMS", settings: ["mimsms_username", "mimsms_api_key", "mimsms_sender_name"] },
      { id: "gennet", name: "GenNet iSMS", settings: ["gennet_api_token", "gennet_base_url", "gennet_sid"] },
    ],
    fraud: [
      { id: "fraudbd", name: "FraudBD", countries: ["BD"], operations: ["testConnection"], settings: ["fraudbd_api_url", "fraudbd_api_key", "fraudbd_username", "fraudbd_password"] },
      { id: "fraudguard", name: "FraudGuard", countries: ["BD"], operations: ["testConnection"], settings: ["fraudguard_api_url", "fraudguard_api_key", "fraudguard_api_secret"] },
      { id: "ecourier", name: "eCourier Fraud Alert", countries: ["BD"], operations: ["testConnection"], settings: ["ecourier_api_url", "ecourier_api_key", "ecourier_api_secret", "ecourier_user_id"] },
      { id: "fraudchecker", name: "FraudChecker (custom API)", countries: ["BD"], operations: ["testConnection"], settings: ["fraudchecker_api_url", "fraudchecker_token"] },
    ],
  },
  routes: {
    admin: [
      { name: "places", methods: ["GET"], description: "Whether the Bangladesh places are loaded." },
      { name: "load-places", methods: ["POST"], description: "Loads the Bangladesh places now." },
    ],
  },
  admin: {
    pages: [{ id: "places", title: "Bangladesh places", placement: "settings", route: "places" }],
  },
  cron: [{ name: "places-sync", schedule: "17 * * * *" }],
  // Activation loads the places (24 import calls) and a fraud service may take its full 10 s.
  limits: { wallMs: 30_000 },
  translations: {
    bn: {
      name: "বাংলাদেশ প্যাক",
      tagline: "বাংলাদেশ প্যাক: এসএমএস, ফ্রড চেক, এলাকা",
      description: "বাংলাদেশের দোকানের যা দরকার, এক অ্যাপে: SMS.net.bd, BDBulkSMS, MIM SMS বা GenNet দিয়ে অর্ডারের মেসেজ আর সাইন-ইন কোড পাঠান; অর্ডার পেজ থেকে FraudBD, FraudGuard, eCourier বা FraudChecker দিয়ে ক্রেতার কুরিয়ার ইতিহাস দেখুন; আর ঠিকানা ও শিপিং জোনের জন্য শহর, থানা ও এলাকার তালিকা (Pathao-র ডেলিভারি এলাকা) লোড করুন।",
      pages: { places: "বাংলাদেশের এলাকা" },
    },
  },
} satisfies PluginManifestInput;

/** Activation and the admin button stop starting chunks after this, inside the 30 s limit. */
const SEED_BUDGET_MS = 20_000;

const COPY = {
  en: {
    title: "Bangladesh places",
    description: "Cities, thanas and areas for addresses and shipping zones, from Pathao's delivery places.",
    loaded: "Loaded",
    loading: "Loading",
    notLoaded: "Not loaded",
    places: "Places in the dataset",
    sent: "Places sent",
    created: "Created",
    updated: "Updated",
    conflicts: "Not applied",
    version: "Dataset version",
    load: "Load places now",
    loadedToast: "The Bangladesh places are loaded.",
    partialToast: "Some places are loaded. The rest load within the hour.",
    keep: "Removing the app keeps every place: zones, tax regions and addresses use them.",
    next: "Next: choose your SMS gateway in Settings → Notifications, and turn on a fraud checker in Settings → Apps and integrations. Enter their keys in this app's settings.",
  },
  bn: {
    title: "বাংলাদেশের এলাকা",
    description: "ঠিকানা ও শিপিং জোনের জন্য শহর, থানা ও এলাকা, Pathao-র ডেলিভারি এলাকা থেকে।",
    loaded: "লোড হয়েছে",
    loading: "লোড হচ্ছে",
    notLoaded: "লোড হয়নি",
    places: "ডেটাসেটের এলাকা",
    sent: "পাঠানো এলাকা",
    created: "তৈরি",
    updated: "হালনাগাদ",
    conflicts: "প্রয়োগ হয়নি",
    version: "ডেটাসেটের সংস্করণ",
    load: "এখনই এলাকা লোড করুন",
    loadedToast: "বাংলাদেশের এলাকা লোড হয়েছে।",
    partialToast: "কিছু এলাকা লোড হয়েছে। বাকিগুলো এক ঘণ্টার মধ্যে লোড হবে।",
    keep: "অ্যাপ সরালেও সব এলাকা থাকে: জোন, ট্যাক্স অঞ্চল আর ঠিকানা এগুলো ব্যবহার করে।",
    next: "এরপর: Settings → Notifications-এ আপনার এসএমএস গেটওয়ে বাছুন, আর Settings → Apps and integrations-এ একটি ফ্রড চেকার চালু করুন। তাদের কী এই অ্যাপের সেটিংসে দিন।",
  },
} as const;

function placesPage(request: PluginRouteRequest, state: PlacesState | null) {
  const t = COPY[adminLocale(request)];
  const current = placesCurrent(state);
  const status = current ? ui.badge(t.loaded, "success") : state && state.version === PLACES_VERSION ? ui.badge(t.loading, "warning") : ui.badge(t.notLoaded, "warning");
  return ui.page([
    ...(state?.error ? [ui.banner("critical", state.error)] : []),
    ui.card(t.title, [
      status,
      ui.keyValue([
        { label: t.places, value: PLACES_TOTAL.toLocaleString("en-US") },
        { label: t.sent, value: (state && state.version === PLACES_VERSION ? state.next : 0).toLocaleString("en-US") },
        { label: t.created, value: String(state?.created ?? 0) },
        { label: t.updated, value: String(state?.updated ?? 0) },
        { label: t.conflicts, value: String(state?.conflicts ?? 0) },
        { label: t.version, value: PLACES_VERSION.slice(0, 12) },
      ]),
      ui.text(t.keep, { tone: "neutral", size: "sm" }),
    ]),
    ui.text(t.next),
  ], {
    title: t.title,
    description: t.description,
    ...(current ? {} : { actions: [ui.button(t.load, { route: "load-places" })] }),
  });
}

const seed = (ctx: PluginContext) => seedPlaces(ctx, { budgetMs: SEED_BUDGET_MS });

export default definePlugin({
  manifest,
  providers: { ...smsProviders, ...fraudProviders },
  routes: {
    admin: {
      places: async (request, ctx) => ({ body: placesPage(request, await readPlacesState(ctx)) }),
      "load-places": async (request, ctx) => {
        const t = COPY[adminLocale(request)];
        const state = await seed(ctx);
        if (state.error) return { body: ui.result({ toast: { message: state.error, tone: "critical" }, refresh: true }) };
        return { body: ui.result({ toast: state.done ? t.loadedToast : t.partialToast, refresh: true }) };
      },
    },
  },
  cron: {
    // Finishes a load that activation could not complete, and loads a newer dataset after an update.
    "places-sync": async (ctx) => {
      if (placesCurrent(await readPlacesState(ctx))) return;
      await seed(ctx);
    },
  },
  lifecycle: {
    activate: async (ctx) => {
      const state = await seed(ctx);
      if (state.error) throw new Error(state.error);
    },
    // Places stay: zones, tax regions and addresses point at them.
    uninstall: (ctx, { keepData }) => {
      ctx.log.info("Bangladesh pack removed; the places stay in the store", { keepData });
    },
  },
});
