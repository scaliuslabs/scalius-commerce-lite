import { cn } from "@scalius/shared/utils";

export type ProviderMarkId =
  | "stripe"
  | "sslcommerz"
  | "polar"
  | "cloudflare"
  | "resend"
  | "meta"
  | "google-analytics"
  | "google-tag-manager"
  | "tiktok"
  | "firebase"
  | "whatsapp"
  | "pathao"
  | "steadfast"
  | "fraudbd"
  | "ecourier"
  | "smsnetbd"
  | "bdbulksms"
  | "mimsms"
  | "gennet";

export interface ProviderMarkManifestEntry {
  label: string;
  lightSrc: string;
  darkSrc?: string;
  kind: "icon" | "wordmark";
  firstPartyAssetUrl: string;
  governingTermsUrl: string;
  retrievedAt: string;
  sha256: string;
  darkSha256?: string;
  minimumCssPixels: number;
  allowedSurface:
    | "direct-provider-settings"
    | "direct-provider-settings-and-storefront-checkout";
  derivative?: {
    operation: string;
    sourceSha256: string;
  };
}

export const PROVIDER_MARKS: Record<ProviderMarkId, ProviderMarkManifestEntry> = {
  stripe: {
    label: "Stripe",
    lightSrc: "/provider-marks/stripe-blurple.svg",
    kind: "wordmark",
    firstPartyAssetUrl:
      "https://assets.stripeassets.com/fzn2n1nzq965/7q0dJGs6fRS1LRmMpChoAF/87def4edfbb7fd5aef4ab9baf904b2db/Stripe_logo_kit.zip",
    governingTermsUrl: "https://stripe.com/legal/marks",
    retrievedAt: "2026-07-14",
    sha256: "ff9ed9bc349274d92a49b47e191a135e29cd6519d27311061ecb2ab6b47fa023",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings-and-storefront-checkout",
  },
  sslcommerz: {
    label: "SSLCommerz",
    lightSrc: "/provider-marks/sslcommerz.png",
    kind: "wordmark",
    firstPartyAssetUrl:
      "https://sslcommerz.com/wp-content/uploads/2021/11/logo.png",
    governingTermsUrl: "https://sslcommerz.com/",
    retrievedAt: "2026-07-14",
    sha256: "b98954ed65588a8ee0a0438eeb1c380dfb0b92c4f4eef0c65d1d12433f2bd7ed",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings-and-storefront-checkout",
    derivative: {
      operation:
        "Cropped the transparent outer margin to its alpha bounds with two source pixels retained on each side; artwork pixels were not recolored or redrawn.",
      sourceSha256: "7907eaf8fd5ecd525bef3ccefac93f6df2eb5314dca5d0a947185d5f7df64ba6",
    },
  },
  polar: {
    label: "Polar",
    lightSrc: "/provider-marks/polar-black.svg",
    darkSrc: "/provider-marks/polar-white.svg",
    kind: "icon",
    firstPartyAssetUrl: "https://polar.sh/assets/brand/polar_brand.zip",
    governingTermsUrl: "https://polar.sh/brand",
    retrievedAt: "2026-07-14",
    sha256: "a96f2cc562f1ac1eac4f864b943d313e145626d8fa0cebe12c61b1af80bbb670",
    darkSha256: "4ccc963c7284172dcc475aee1ad4fc5bfe3d10caaf7fbde446451f3f983d2ef4",
    minimumCssPixels: 16,
    allowedSurface: "direct-provider-settings-and-storefront-checkout",
  },
  cloudflare: {
    label: "Cloudflare",
    lightSrc: "/provider-marks/cloudflare.png",
    kind: "wordmark",
    firstPartyAssetUrl:
      "https://cf-assets.www.cloudflare.com/dzlvafdwdttg/2Twekn3xyYyd94qDYAl0ed/9ab649caa40958f195166e0d9f5d9a04/Logos.zip?download=true",
    governingTermsUrl: "https://www.cloudflare.com/trademark/",
    retrievedAt: "2026-07-14",
    sha256: "400b70b8bb7db80da137ef8e8fcb835a692410a3083598964da08ed1756df145",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
  resend: {
    label: "Resend",
    lightSrc: "/provider-marks/resend-black.svg",
    darkSrc: "/provider-marks/resend-white.svg",
    kind: "icon",
    firstPartyAssetUrl: "https://cdn.resend.com/brand/resend-icon-black.svg",
    governingTermsUrl: "https://resend.com/brand",
    retrievedAt: "2026-07-14",
    sha256: "605a8980bb45b91de1c5480162b107c3bec1d3dc0fbb4ef27427bd2c3e68496e",
    darkSha256: "7e36ff446b8dac0b7f299c2461126f3254a440af5b226447e70a673c961361d5",
    minimumCssPixels: 24,
    allowedSurface: "direct-provider-settings",
  },
  meta: {
    label: "Meta",
    lightSrc: "/provider-marks/meta.svg",
    kind: "icon",
    firstPartyAssetUrl: "https://static.xx.fbcdn.net/rsrc.php/yf/r/-7pQO6hUGK_.svg",
    governingTermsUrl: "https://www.meta.com/brand/resources/meta/company-brand/",
    retrievedAt: "2026-07-14",
    sha256: "9c354dc7d40f7862df2dfb34df05ae08c3e956d55a450379803d6cac6878a63e",
    minimumCssPixels: 16,
    allowedSurface: "direct-provider-settings",
  },
  "google-analytics": {
    label: "Google Analytics",
    lightSrc: "/provider-marks/google-analytics.svg",
    kind: "icon",
    firstPartyAssetUrl: "https://www.gstatic.com/analytics-suite/header/suite/v2/ic_analytics.svg",
    governingTermsUrl: "https://developers.google.com/analytics/terms/branding-policy",
    retrievedAt: "2026-07-14",
    sha256: "aa7d39ae684b9dc29b319257ad078f97fd90350aa6ace71fc9cfb66eb316c045",
    minimumCssPixels: 24,
    allowedSurface: "direct-provider-settings",
  },
  "google-tag-manager": {
    label: "Google Tag Manager",
    lightSrc: "/provider-marks/google-tag-manager.svg",
    kind: "icon",
    firstPartyAssetUrl: "https://www.gstatic.com/analytics-suite/header/suite/v2/ic_tag_manager.svg",
    governingTermsUrl: "https://about.google/brand-resource-center/products-and-services/",
    retrievedAt: "2026-07-14",
    sha256: "d495f3b6d843a9f5f90ddb1dfedfaa7f48babd4179ce75f534b794d54e7bd621",
    minimumCssPixels: 24,
    allowedSurface: "direct-provider-settings",
  },
  tiktok: {
    label: "TikTok",
    lightSrc: "/provider-marks/tiktok.png",
    kind: "icon",
    firstPartyAssetUrl:
      "https://sf16-va.tiktokcdn.com/obj/eden-va2/uvzhqeh7nuhd/tt4d/logo-pack.zip",
    governingTermsUrl: "https://developers.tiktok.com/doc/getting-started-design-guidelines",
    retrievedAt: "2026-07-14",
    sha256: "e8013e14350422f54f4b61735d91e232bf02972f6156d979cd82905559f5ee2e",
    minimumCssPixels: 24,
    allowedSurface: "direct-provider-settings",
  },
  firebase: {
    label: "Firebase",
    lightSrc: "/provider-marks/firebase.svg",
    kind: "icon",
    firstPartyAssetUrl:
      "https://firebase.google.com/static/downloads/brand-guidelines/SVG/logo-logomark.svg",
    governingTermsUrl: "https://firebase.google.com/brand-guidelines",
    retrievedAt: "2026-07-14",
    sha256: "120799f51cff880e87bdc5c3954f1938ecc4cd401bec3fe188e1e22db641c556",
    minimumCssPixels: 24,
    allowedSurface: "direct-provider-settings",
  },
  whatsapp: {
    label: "WhatsApp",
    lightSrc: "/provider-marks/whatsapp.webp",
    kind: "icon",
    firstPartyAssetUrl: "https://static.xx.fbcdn.net/rsrc.php/yQ/r/iu_mCuZziJB.webp",
    governingTermsUrl: "https://www.meta.com/brand/resources/whatsapp/whatsapp-brand/",
    retrievedAt: "2026-07-14",
    sha256: "a936aa671e367472b7d21155eb55c4f850ae168b8e36c622de7d682659e2ad25",
    minimumCssPixels: 24,
    allowedSurface: "direct-provider-settings",
  },
  pathao: {
    label: "Pathao",
    lightSrc: "/provider-marks/pathao.svg",
    kind: "wordmark",
    firstPartyAssetUrl: "https://pathao.com/wp-content/uploads/2023/10/Pathao-logo.svg",
    governingTermsUrl: "https://pathao.com/press-kit/",
    retrievedAt: "2026-07-14",
    sha256: "5561a988e6c53ef678536d4c1db5df94f1ab18557b11a5d231d37c3635dd9946",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
  steadfast: {
    label: "Steadfast",
    lightSrc: "/provider-marks/steadfast.svg",
    kind: "wordmark",
    firstPartyAssetUrl: "https://steadfast.com.bd/landing-page/asset/images/logo/logo.svg",
    governingTermsUrl: "https://steadfast.com.bd/",
    retrievedAt: "2026-07-14",
    sha256: "da7dd2aa0efafa0cad3d6572f196f0e9021a1f0c7beba76057a94df5734d98cd",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
  fraudbd: {
    label: "FraudBD",
    lightSrc: "/provider-marks/fraudbd.png",
    kind: "wordmark",
    firstPartyAssetUrl: "https://fraudbd.com/storage/assets/images/logo_with_name.png",
    governingTermsUrl: "https://fraudbd.com/api-documentation",
    retrievedAt: "2026-07-14",
    sha256: "750c31e0e25cd1e1e19f8c0fa15d5da4a5359a22c1dab90c834d216f5a083628",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
  ecourier: {
    label: "eCourier",
    lightSrc: "/provider-marks/ecourier.svg",
    kind: "wordmark",
    firstPartyAssetUrl: "https://ecourier.com.bd/wp-content/themes/ecourier-2.0/images/logo.svg",
    governingTermsUrl: "https://ecourier.com.bd/resources/",
    retrievedAt: "2026-07-14",
    sha256: "066318b0d1289a0dafd202ea2b8ab3f065f91216a5b589c9f781a39f89fb9d62",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
  smsnetbd: {
    label: "SMS.net.bd",
    lightSrc: "/provider-marks/smsnetbd.svg",
    kind: "wordmark",
    firstPartyAssetUrl: "https://sms.net.bd/Content/img/logo/alphasms.svg",
    governingTermsUrl: "https://sms.net.bd/",
    retrievedAt: "2026-07-14",
    sha256: "59b1664ea2072b9c2487a55d3d13e5f1e4ad97e27dbc2fe7f7272dc6189323c6",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
  bdbulksms: {
    label: "BDBulkSMS by GreenWeb",
    lightSrc: "/provider-marks/bdbulksms.webp",
    kind: "wordmark",
    firstPartyAssetUrl: "https://cdn.bdbulksms.com/logo_bdbulksms.webp",
    governingTermsUrl: "https://bdbulksms.com/terms-and-conditions.php",
    retrievedAt: "2026-07-14",
    sha256: "c7b132756409ccf57d49d15afabd07c2d45dc2aecfa0b30ab939a16df2656f15",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
  mimsms: {
    label: "MIM SMS",
    lightSrc: "/provider-marks/mimsms.png",
    kind: "wordmark",
    firstPartyAssetUrl: "https://www.mimsms.com/storage/2021/04/MiM-SMS-Transparent-Logo.png",
    governingTermsUrl: "https://www.mimsms.com/",
    retrievedAt: "2026-07-14",
    sha256: "659e42d7026f718bdab726c929c827a117719cf49dff5d8703910f18b2f3e5d1",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
  gennet: {
    label: "Gennet iSMS",
    lightSrc: "/provider-marks/gennet.png",
    kind: "wordmark",
    firstPartyAssetUrl: "https://www.gennet.com.bd/assets/img/logo.png",
    governingTermsUrl: "https://www.gennet.com.bd/",
    retrievedAt: "2026-07-14",
    sha256: "f05a55a94aa32d4155e3e28808dc311668093e103ed5895ca930e67a268664a0",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
  },
};

export function OfficialProviderMark({
  provider,
  size = "md",
  className,
}: {
  provider: ProviderMarkId;
  size?: "sm" | "md";
  className?: string;
}) {
  const mark = PROVIDER_MARKS[provider];
  const imageClassName = cn("h-full w-full object-contain", className);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        mark.kind === "wordmark"
          ? cn(
              "rounded-sm bg-white px-1 ring-1 ring-black/5",
              size === "sm" ? "h-6 w-16" : "h-8 w-20",
            )
          : size === "sm"
            ? "h-6 w-6 p-px"
            : "h-8 w-8 p-0.5",
      )}
      aria-hidden="true"
      title={mark.label}
    >
      <img src={mark.lightSrc} alt="" className={cn(imageClassName, mark.darkSrc && "dark:hidden")} />
      {mark.darkSrc ? (
        <img src={mark.darkSrc} alt="" className={cn(imageClassName, "hidden dark:block")} />
      ) : null}
    </span>
  );
}
