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
// - Payments (sslcommerz.ts): SSLCommerz as a hosted payment provider
//   (cards, mobile wallets, internet banking): sessions, IPN and return
//   validation through SSLCommerz's validation API, refunds. The old
//   /webhooks/sslcommerz and /payment/sslcommerz/* URLs keep reaching it.
// - Couriers (couriers.ts): Pathao and Steadfast as courier providers:
//   booking, tracking, Steadfast's lookup by order number, and tracking pushes
//   (the platform's courier webhook route, and the old /webhooks/pathao and
//   /webhooks/steadfast URLs). Pathao books by its own place ids, which the
//   platform reads from the places (`locations`).
// - Places (places.ts): the City/Thana/Area directory, loaded through the
//   place import on activation and kept current by the hourly `places-sync`;
//   "Refresh from Pathao" (pathao-places.ts) re-reads Pathao's live list.
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
import { PATHAO_HOSTS, STEADFAST_HOSTS, courierProviders } from "./couriers";
import { FRAUD_CHECKERS, fraudProviders } from "./fraud";
import { continuePathaoRefresh, pathaoRefreshRunning, readPathaoRefresh, startPathaoRefresh, type PathaoRefreshState } from "./pathao-places";
import { PLACES_TOTAL, PLACES_VERSION, placesCurrent, readPlacesState, seedPlaces, type PlacesState } from "./places";
import { SMS_HOSTS, smsProviders } from "./sms";
import { SSLCOMMERZ_AMOUNT_LIMITS, SSLCOMMERZ_HOSTS, paymentProviders } from "./sslcommerz";

// Each field belongs to one provider (`group: <provider id>`): the dashboard
// shows it only in that provider's setup sheet, where the provider is in
// Settings (Notifications, Shipping, Payments, Apps and integrations), so the
// labels need no provider prefix.
type Group = "smsnetbd" | "bdbulksms" | "mimsms" | "gennet" | "fraudchecker" | "fraudbd" | "fraudguard" | "ecourier" | "pathao" | "steadfast" | "sslcommerz";
const secret = (group: Group, key: string, label: string, help?: string) => ({ key, label, type: "secret" as const, group, ...(help ? { help } : {}) });
const text = (group: Group, key: string, label: string, maxLength: number, help?: string) =>
  ({ key, label, type: "text" as const, maxLength, group, ...(help ? { help } : {}) });
const url = (group: Group, key: string, label: string, fallback: string, help = "Change it only when the service gives you another address.") =>
  ({ key, label, type: "url" as const, default: fallback, help, group });
const choice = (group: Group, key: string, label: string, options: Array<[string, string]>, fallback: string) =>
  ({ key, label, type: "select" as const, options: options.map(([value, text]) => ({ value, label: text })), default: fallback, group });

const SETTINGS = [
  secret("smsnetbd", "smsnetbd_api_key", "API key"),
  text("smsnetbd", "smsnetbd_sender_id", "Sender ID", 128, "Only when SMS.net.bd approved a sender ID for you."),
  secret("bdbulksms", "bdbulksms_token", "Token"),
  text("mimsms", "mimsms_username", "Username (email)", 320),
  secret("mimsms", "mimsms_api_key", "API key"),
  text("mimsms", "mimsms_sender_name", "Sender name", 128, "The sender name registered with MIM SMS."),
  secret("gennet", "gennet_api_token", "API token"),
  { key: "gennet_base_url", label: "Account address", type: "url" as const, group: "gennet" as const, help: "Your account's address, for example https://yourshop.gennet.com.bd." },
  text("gennet", "gennet_sid", "Sender ID (SID)", 128),
  url("fraudchecker", "fraudchecker_api_url", "API URL", "https://fraudchecker.link/api/v1/qc/"),
  secret("fraudchecker", "fraudchecker_token", "Bearer token"),
  url("fraudbd", "fraudbd_api_url", "API URL", "https://fraudbd.com/api/check-courier-info"),
  secret("fraudbd", "fraudbd_api_key", "API key"),
  text("fraudbd", "fraudbd_username", "Username", 200),
  secret("fraudbd", "fraudbd_password", "Password"),
  url("fraudguard", "fraudguard_api_url", "API URL", "https://fraudguard.slope.com.bd/api/v1/fraud-check"),
  secret("fraudguard", "fraudguard_api_key", "API key"),
  secret("fraudguard", "fraudguard_api_secret", "API secret"),
  url("ecourier", "ecourier_api_url", "API URL", "https://backoffice.ecourier.com.bd/api/fraud-status-check"),
  secret("ecourier", "ecourier_api_key", "API key"),
  secret("ecourier", "ecourier_api_secret", "API secret"),
  text("ecourier", "ecourier_user_id", "User ID", 200),
  url("pathao", "pathao_base_url", "API address", "https://api-hermes.pathao.com", "Live: https://api-hermes.pathao.com. Test account: https://courier-api-sandbox.pathao.com."),
  text("pathao", "pathao_client_id", "Client ID", 500),
  secret("pathao", "pathao_client_secret", "Client secret"),
  text("pathao", "pathao_username", "Username (email)", 320),
  secret("pathao", "pathao_password", "Password"),
  text("pathao", "pathao_store_id", "Store ID", 100, "The pickup store in your Pathao merchant account."),
  choice("pathao", "pathao_delivery_type", "Delivery type", [["48", "Regular"], ["12", "Express"]], "48"),
  choice("pathao", "pathao_item_type", "Item type", [["2", "Parcel"], ["1", "Document"]], "2"),
  { key: "pathao_item_weight", label: "Default weight (kg)", type: "number" as const, default: 0.5, min: 0.1, max: 50, group: "pathao" as const, help: "Used when a booking does not give a weight." },
  secret("pathao", "pathao_webhook_secret", "Webhook secret", "A long random text. Enter the same in Pathao's webhook settings, with the URL from Settings → Shipping → Couriers."),
  url("steadfast", "steadfast_base_url", "API address", "https://portal.packzy.com/api/v1"),
  secret("steadfast", "steadfast_api_key", "API key"),
  secret("steadfast", "steadfast_secret_key", "Secret key"),
  secret("steadfast", "steadfast_webhook_secret", "Webhook token", "The Bearer token Steadfast sends with its updates. Left empty, the secret key is used."),
  // No default: a store chooses test or live payments itself (activation moves a choice saved before the move).
  {
    key: "sslcommerz_environment",
    label: "Environment",
    type: "select" as const,
    options: [{ value: "sandbox", label: "Sandbox (test payments)" }, { value: "live", label: "Live" }],
    group: "sslcommerz" as const,
    help: "Sandbox uses SSLCommerz's test system. Switch to Live together with your live store ID and password.",
  },
  text("sslcommerz", "sslcommerz_store_id", "Store ID", 200, "From the store credentials SSLCommerz sent you."),
  secret("sslcommerz", "sslcommerz_store_password", "Store password"),
];

/** The field labels in Bangla (the dashboard's other language); help stays English. */
const BN_LABELS: Record<string, string> = {
  "API key": "এপিআই কী",
  "API token": "এপিআই টোকেন",
  "API secret": "এপিআই সিক্রেট",
  "API URL": "এপিআই ইউআরএল",
  "API address": "এপিআই ঠিকানা",
  "Account address": "অ্যাকাউন্টের ঠিকানা",
  "Bearer token": "বেয়ারার টোকেন",
  "Client ID": "ক্লায়েন্ট আইডি",
  "Client secret": "ক্লায়েন্ট সিক্রেট",
  "Default weight (kg)": "ডিফল্ট ওজন (কেজি)",
  "Delivery type": "ডেলিভারির ধরন",
  Environment: "পরিবেশ",
  "Store password": "স্টোর পাসওয়ার্ড",
  "Item type": "পার্সেলের ধরন",
  Password: "পাসওয়ার্ড",
  "Secret key": "সিক্রেট কী",
  "Sender ID": "সেন্ডার আইডি",
  "Sender ID (SID)": "সেন্ডার আইডি (SID)",
  "Sender name": "প্রেরকের নাম",
  "Store ID": "স্টোর আইডি",
  Token: "টোকেন",
  "User ID": "ইউজার আইডি",
  Username: "ইউজারনেম",
  "Username (email)": "ইউজারনেম (ইমেইল)",
  "Webhook secret": "ওয়েবহুক সিক্রেট",
  "Webhook token": "ওয়েবহুক টোকেন",
};

export const manifest = {
  id: "scalius.bangladesh",
  name: "Bangladesh pack",
  version: "1.3.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Everything a store in Bangladesh needs in one app: take online payments (cards, bKash, Nagad, Rocket and internet banking) with SSLCommerz; book, track and follow deliveries with Pathao and Steadfast; send order messages and sign-in codes through SMS.net.bd, BDBulkSMS, MIM SMS or GenNet; check a buyer's courier history with FraudBD, FraudGuard, eCourier or FraudChecker from the order page; and load the City, Thana and Area list (Pathao's delivery places) for addresses and shipping zones.",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  tagline: "Bangladesh pack: SSLCommerz, couriers, SMS, fraud checks, places",
  categories: ["payments", "shipping", "notifications"],
  countries: ["BD"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  documentationUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/blob/mono-repo/plugins/bangladesh/README.md",
  changelogUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/commits/mono-repo/plugins/bangladesh",
  minPlatformVersion: "1.0.0",
  // The place import (dashboard.delivery_locations.import): it adds and updates places, never deletes.
  permissions: ["settings.delivery_locations.import"],
  allowedHosts: [
    ...SMS_HOSTS,
    ...new Set(Object.values(FRAUD_CHECKERS).flatMap((checker) => checker.hosts)),
    ...PATHAO_HOSTS,
    ...STEADFAST_HOSTS,
    SSLCOMMERZ_HOSTS.sandbox,
    SSLCOMMERZ_HOSTS.live,
  ],
  settings: SETTINGS,
  providers: {
    payment: [
      {
        id: "sslcommerz",
        name: "SSLCommerz",
        icon: "assets/sslcommerz.png",
        // The name buyers saw before the move: SSLCommerz's page offers cards, wallets and banking.
        checkoutName: "Online Payment",
        flow: "hosted",
        chargeCurrencies: ["BDT"],
        amountLimits: SSLCOMMERZ_AMOUNT_LIMITS,
        operations: ["verifyReturn", "queryPayment", "refund", "refundStatus", "testConnection"],
        settings: ["sslcommerz_environment", "sslcommerz_store_id", "sslcommerz_store_password"],
        environmentSetting: "sslcommerz_environment",
        // A failed or cancelled return posts the merchant reference unsigned: it only names the attempt to release.
        returnCorrelationField: "tran_id",
      },
    ],
    courier: [
      {
        id: "pathao",
        name: "Pathao",
        icon: "assets/pathao.svg",
        countries: ["BD"],
        operations: ["verifyWebhook", "testConnection"],
        settings: ["pathao_base_url", "pathao_client_id", "pathao_client_secret", "pathao_username", "pathao_password", "pathao_store_id"],
        trackingUrl: "https://merchant.pathao.com/tracking?consignment_id={trackingId}",
        // Pathao books by its own city and zone (and area) ids, kept on the places.
        locations: { key: "pathao", required: ["city", "zone"], numeric: true },
      },
      {
        id: "steadfast",
        name: "Steadfast",
        icon: "assets/steadfast.svg",
        countries: ["BD"],
        operations: ["findShipment", "verifyWebhook", "testConnection"],
        settings: ["steadfast_base_url", "steadfast_api_key", "steadfast_secret_key"],
        trackingUrl: "https://steadfast.com.bd/t/{trackingId}",
      },
    ],
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
      { name: "refresh-pathao-places", methods: ["POST"], description: "Reads Pathao's live place list into the store's places." },
    ],
  },
  admin: {
    pages: [{ id: "places", title: "Bangladesh places", placement: "settings", route: "places" }],
  },
  cron: [
    { name: "places-sync", schedule: "17 * * * *" },
    // Continues a Pathao refresh under way (a few dozen Pathao calls a run); otherwise it reads one KV key.
    { name: "pathao-places", schedule: "*/5 * * * *" },
  ],
  // Activation loads the places (24 import calls) and a fraud service may take its full 10 s.
  limits: { wallMs: 30_000 },
  translations: {
    bn: {
      name: "বাংলাদেশ প্যাক",
      tagline: "বাংলাদেশ প্যাক: SSLCommerz, কুরিয়ার, এসএমএস, ফ্রড চেক, এলাকা",
      description: "বাংলাদেশের দোকানের যা দরকার, এক অ্যাপে: SSLCommerz দিয়ে অনলাইন পেমেন্ট নিন (কার্ড, বিকাশ, নগদ, রকেট ও ইন্টারনেট ব্যাংকিং); Pathao আর Steadfast দিয়ে ডেলিভারি বুক করুন ও ট্র্যাক করুন; SMS.net.bd, BDBulkSMS, MIM SMS বা GenNet দিয়ে অর্ডারের মেসেজ আর সাইন-ইন কোড পাঠান; অর্ডার পেজ থেকে FraudBD, FraudGuard, eCourier বা FraudChecker দিয়ে ক্রেতার কুরিয়ার ইতিহাস দেখুন; আর ঠিকানা ও শিপিং জোনের জন্য শহর, থানা ও এলাকার তালিকা (Pathao-র ডেলিভারি এলাকা) লোড করুন।",
      pages: { places: "বাংলাদেশের এলাকা" },
      settings: Object.fromEntries(SETTINGS.flatMap((field) => (BN_LABELS[field.label] ? [[field.key, { label: BN_LABELS[field.label] }]] : []))),
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
    next: "Next: set up SSLCommerz in Settings → Payments, add Pathao or Steadfast in Settings → Shipping → Couriers, choose your SMS gateway in Settings → Notifications, and turn on a fraud checker in Settings → Apps and integrations. Each one's keys are entered where you set it up.",
    pathaoTitle: "Pathao's live places",
    pathaoDescription: "Reads Pathao's current cities, thanas and areas into your places, a few dozen at a time, and links them for Pathao bookings. It needs Pathao's keys (Settings → Shipping → Couriers).",
    pathaoIdle: "Not refreshed",
    pathaoRunning: "Refreshing",
    pathaoDone: "Refreshed",
    pathaoPhase: "Step",
    phases: { cities: "Cities", zones: "Thanas", areas: "Areas", done: "Done" },
    pathaoNext: "Read so far",
    pathaoStarted: "Started",
    pathaoRefresh: "Refresh from Pathao",
    pathaoContinue: "Continue now",
    pathaoToastDone: "Pathao's places are refreshed.",
    pathaoToastRunning: "Refreshing Pathao's places. It continues every few minutes.",
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
    next: "এরপর: Settings → Payments-এ SSLCommerz চালু করুন, Settings → Shipping → Couriers-এ Pathao বা Steadfast যোগ করুন, Settings → Notifications-এ আপনার এসএমএস গেটওয়ে বাছুন, আর Settings → Apps and integrations-এ একটি ফ্রড চেকার চালু করুন। যেখানে চালু করবেন, সেখানেই তার কী দিন।",
    pathaoTitle: "Pathao-র হালনাগাদ এলাকা",
    pathaoDescription: "Pathao-র বর্তমান শহর, থানা ও এলাকা অল্প অল্প করে আপনার এলাকায় আনে, আর Pathao বুকিংয়ের জন্য যুক্ত করে। এর জন্য Pathao-র কী লাগবে (Settings → Shipping → Couriers)।",
    pathaoIdle: "হালনাগাদ হয়নি",
    pathaoRunning: "হালনাগাদ হচ্ছে",
    pathaoDone: "হালনাগাদ হয়েছে",
    pathaoPhase: "ধাপ",
    phases: { cities: "শহর", zones: "থানা", areas: "এলাকা", done: "শেষ" },
    pathaoNext: "এ পর্যন্ত পড়া",
    pathaoStarted: "শুরু",
    pathaoRefresh: "Pathao থেকে হালনাগাদ করুন",
    pathaoContinue: "এখনই চালিয়ে যান",
    pathaoToastDone: "Pathao-র এলাকা হালনাগাদ হয়েছে।",
    pathaoToastRunning: "Pathao-র এলাকা হালনাগাদ হচ্ছে। কয়েক মিনিট পরপর চলতে থাকবে।",
  },
} as const;

function pathaoCard(request: PluginRouteRequest, refresh: PathaoRefreshState | null) {
  const t = COPY[adminLocale(request)];
  const running = pathaoRefreshRunning(refresh);
  const status = running ? ui.badge(t.pathaoRunning, "warning") : refresh ? ui.badge(t.pathaoDone, "success") : ui.badge(t.pathaoIdle, "neutral");
  return ui.card(t.pathaoTitle, [
    ...(refresh?.error ? [ui.banner("warning", refresh.error)] : []),
    ui.text(t.pathaoDescription, { tone: "neutral", size: "sm" }),
    status,
    ...(refresh ? [ui.keyValue([
      { label: t.pathaoPhase, value: t.phases[refresh.phase] },
      { label: t.pathaoNext, value: String(refresh.next) },
      { label: t.created, value: String(refresh.created) },
      { label: t.updated, value: String(refresh.updated) },
      { label: t.pathaoStarted, value: refresh.startedAt.slice(0, 16).replace("T", " ") },
    ])] : []),
    ui.button(running ? t.pathaoContinue : t.pathaoRefresh, { route: "refresh-pathao-places" }),
  ]);
}

function placesPage(request: PluginRouteRequest, state: PlacesState | null, refresh: PathaoRefreshState | null) {
  const t = COPY[adminLocale(request)];
  const current = placesCurrent(state);
  const status = current ? ui.badge(t.loaded, "success") : state && state.version === PLACES_VERSION ? ui.badge(t.loading, "warning") : ui.badge(t.notLoaded, "warning");
  return ui.page([
    ...(state?.error ? [ui.banner("critical", state.error)] : []),
    ui.card(t.title, [
      status,
      ui.keyValue([
        { label: t.places, value: PLACES_TOTAL },
        { label: t.sent, value: state && state.version === PLACES_VERSION ? state.next : 0 },
        { label: t.created, value: state?.created ?? 0 },
        { label: t.updated, value: state?.updated ?? 0 },
        { label: t.conflicts, value: state?.conflicts ?? 0 },
        { label: t.version, value: PLACES_VERSION.slice(0, 12) },
      ]),
      ui.text(t.keep, { tone: "neutral", size: "sm" }),
    ]),
    pathaoCard(request, refresh),
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
  providers: { ...paymentProviders, ...courierProviders, ...smsProviders, ...fraudProviders },
  routes: {
    admin: {
      places: async (request, ctx) => ({ body: placesPage(request, await readPlacesState(ctx), await readPathaoRefresh(ctx)) }),
      "load-places": async (request, ctx) => {
        const t = COPY[adminLocale(request)];
        const state = await seed(ctx);
        if (state.error) return { body: ui.result({ toast: { message: state.error, tone: "critical" }, refresh: true }) };
        return { body: ui.result({ toast: state.done ? t.loadedToast : t.partialToast, refresh: true }) };
      },
      "refresh-pathao-places": async (request, ctx) => {
        const t = COPY[adminLocale(request)];
        await startPathaoRefresh(ctx);
        const state = await continuePathaoRefresh(ctx);
        if (state?.error) return { body: ui.result({ toast: { message: state.error, tone: "critical" }, refresh: true }) };
        return { body: ui.result({ toast: pathaoRefreshRunning(state) ? t.pathaoToastRunning : t.pathaoToastDone, refresh: true }) };
      },
    },
  },
  cron: {
    // Finishes a load that activation could not complete, and loads a newer dataset after an update.
    "places-sync": async (ctx) => {
      if (placesCurrent(await readPlacesState(ctx))) return;
      await seed(ctx);
    },
    // Continues a Pathao refresh a merchant started; nothing to do otherwise.
    "pathao-places": async (ctx) => {
      if (pathaoRefreshRunning(await readPathaoRefresh(ctx))) await continuePathaoRefresh(ctx);
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
