import { cn } from "@scalius/shared/utils";

export type ProviderMarkId =
  | "stripe"
  | "sslcommerz"
  | "polar"
  | "cloudflare"
  | "resend";

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
  allowedSurface: "direct-provider-settings";
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
    allowedSurface: "direct-provider-settings",
  },
  sslcommerz: {
    label: "SSLCommerz",
    lightSrc: "/provider-marks/sslcommerz.png",
    kind: "wordmark",
    firstPartyAssetUrl:
      "https://sslcommerz.com/wp-content/uploads/2021/11/logo.png",
    governingTermsUrl: "https://sslcommerz.com/",
    retrievedAt: "2026-07-14",
    sha256: "7907eaf8fd5ecd525bef3ccefac93f6df2eb5314dca5d0a947185d5f7df64ba6",
    minimumCssPixels: 48,
    allowedSurface: "direct-provider-settings",
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
    allowedSurface: "direct-provider-settings",
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
};

export function OfficialProviderMark({
  provider,
  className,
}: {
  provider: ProviderMarkId;
  className?: string;
}) {
  const mark = PROVIDER_MARKS[provider];
  const imageClassName = cn("h-full w-full object-contain", className);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        mark.kind === "wordmark"
          ? "h-8 w-14 rounded-sm bg-white px-1 ring-1 ring-black/5"
          : "h-8 w-8 p-1",
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
