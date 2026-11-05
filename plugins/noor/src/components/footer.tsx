// The Noor footer: an optional sign-up band, the store's identity and
// contact beside its footer menus (two columns on phones), then the legal line
// with the payment methods it takes. A landing page in campaign mode gets
// only the legal line.

import { Image, Slot, editable, t, type FooterProps } from "@scalius/plugin-sdk/storefront";
import { MenuLinks } from "./header";
import { Icon, SocialIcon } from "./icons";
import { choice, cx, digits, text } from "./ui";

export interface FooterSettings {
  newsletter_heading: string | null;
  newsletter_text: string | null;
  newsletter_button: string | null;
  tagline: string | null;
  payments: Array<{ name: string | null }>;
  tone: string;
  landing_footer: string;
}

type FooterStore = FooterProps<FooterSettings>["data"]["store"];
type Logo = NonNullable<FooterStore["logo"]>;

/**
 * The footer's logo for the surface it sits on in each scheme. A dark surface
 * takes the store's logo for dark pages, the one logo made for dark; without
 * one, its logo is knocked out in white, as the footer always drew it, since
 * a footer or header logo may be dark. The dark footer (`ink`, the store's
 * ink) is dark in both schemes. The soft and plain footers follow the page:
 * light with the footer logo (the header's when there is none), dark while
 * the store paints its dark colours. `dark` is the image dark pages show
 * instead, set only when it differs; `knockout` names where the white
 * knockout applies.
 */
export function footerLogos(store: Pick<FooterStore, "logo" | "darkLogo" | "footerLogo">, tone: "ink" | "soft" | "plain"): { light: Logo | null; dark: Logo | null; knockout: "always" | "dark-pages" | null } {
  // The store hands the header's logo as the footer logo when the theme names none.
  const own = store.footerLogo && store.footerLogo.url !== store.logo?.url ? store.footerLogo : null;
  if (tone === "ink") {
    const light = store.darkLogo ?? own ?? store.logo;
    return { light, dark: null, knockout: light !== null && light !== store.darkLogo ? "always" : null };
  }
  const light = own ?? store.logo;
  if (store.darkLogo) return { light, dark: store.darkLogo.url !== light?.url ? store.darkLogo : null, knockout: null };
  return { light, dark: null, knockout: light ? "dark-pages" : null };
}

export function Footer({ data, settings, context }: FooterProps<FooterSettings>) {
  const heading = text(settings.newsletter_heading);
  const payments = settings.payments.flatMap((payment) => (text(payment.name) ? [text(payment.name)!] : []));
  const tone = choice(settings.tone, ["ink", "soft", "plain"] as const, "ink");
  const logo = footerLogos(data.store, tone);
  const campaign = context.page.kind === "landing" && choice(settings.landing_footer, ["full", "campaign"] as const, "campaign") === "campaign";
  const legal = (
    <div class="noor-footer-legal">
      <p>
        © {digits(context, data.year)} {data.store.name}
        {data.policies.map((policy) => <><span aria-hidden="true"> · </span><a href={policy.url}>{policy.title}</a></>)}
      </p>
      {payments.length > 0 ? (
        <ul class="noor-payments" aria-label={t(context, { en: "We accept", bn: "আমরা গ্রহণ করি" })}>
          {payments.map((name) => <li>{name}</li>)}
        </ul>
      ) : null}
    </div>
  );
  if (campaign) return <footer class={cx("noor-footer is-campaign", `tone-${tone}`)}><div class="noor-wrap">{legal}</div></footer>;
  return (
    <footer class={cx("noor-footer", `tone-${tone}`)}>
      <div class="noor-wrap">
        {heading && data.newsletter ? (
          <section class="noor-footer-band" aria-labelledby="noor-footer-signup">
            <div>
              <h2 id="noor-footer-signup" class="noor-h3" {...editable(context, "newsletter_heading")}>{heading}</h2>
              {text(settings.newsletter_text) ? <p {...editable(context, "newsletter_text")}>{settings.newsletter_text}</p> : null}
            </div>
            <a class="noor-btn is-light" href={data.routes.newsletter}>
              <span {...editable(context, "newsletter_button")}>{text(settings.newsletter_button) ?? t(context, { en: "Join the list", bn: "যুক্ত হন" })}</span>
              <Icon name="arrow" size={16} />
            </a>
          </section>
        ) : null}
        <div class="noor-footer-main" style={{ "--noor-menus": Math.max(1, Math.min(4, data.menus.length)) }}>
          <div class="noor-footer-brand">
            <a class="noor-footer-logo" href={data.routes.home} aria-label={data.store.name}>
              {logo.light ? (
                <Image image={logo.light} alt={data.store.name} class={cx("noor-logo-img", logo.dark && "noor-logo-light", logo.knockout === "always" && "is-knockout", logo.knockout === "dark-pages" && "is-knockout-dark")} />
              ) : <span class={cx("noor-logo-text", logo.dark && "noor-logo-light")}>{data.store.name}</span>}
              {/* Dark pages show the store's logo for dark pages where the footer turns dark with them (CSS picks one). */}
              {logo.dark ? <Image image={logo.dark} alt={data.store.name} class="noor-logo-img noor-logo-dark" /> : null}
            </a>
            {text(settings.tagline) ? <p class="noor-footer-tagline" {...editable(context, "tagline")}>{settings.tagline}</p> : null}
            <ul class="noor-contact">
              {data.store.phone ? <li><Icon name="phone" size={16} /><a href={`tel:${data.store.phone.replace(/[^\d+]/g, "")}`}><bdi dir="ltr">{digits(context, data.store.phone)}</bdi></a></li> : null}
              {data.store.email ? <li><Icon name="mail" size={16} /><a href={`mailto:${data.store.email}`}>{data.store.email}</a></li> : null}
              {data.store.address ? <li><Icon name="pin" size={16} /><span>{data.store.address}</span></li> : null}
            </ul>
            {data.store.social.length > 0 ? (
              <ul class="noor-social">
                {data.store.social.map((link) => (
                  <li><a href={link.url} rel="noopener" target="_blank"><SocialIcon network={link.network} label={link.network} /></a></li>
                ))}
              </ul>
            ) : null}
          </div>
          {data.menus.map((menu) => (
            <nav class="noor-footer-menu" aria-label={menu.title}>
              <h2>{menu.title}</h2>
              <MenuLinks items={menu.items} />
            </nav>
          ))}
        </div>
        <Slot name="footer.columns" />
        {legal}
      </div>
    </footer>
  );
}
