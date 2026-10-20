// The Bazaar footer: the full-width "Back to top" bar, the store's footer
// menus as the marketplace's four link columns, a divider row with the
// logo and the store's contact, an optional services grid (the merchant's
// own sister stores or programs: name and a one-line description), and the
// legal line with the store's policies and the copyright.

import { Image, t, type FooterProps } from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";
import { cx, text } from "./ui";

export interface FooterSettings {
  services: Array<{ name: string | null; text: string | null; link: string | null }>;
  show_back_to_top: boolean;
  copyright: string | null;
}

export function Footer({ data, settings, context }: FooterProps<FooterSettings>) {
  const services = (settings.services ?? []).flatMap((item) => (text(item.name) ? [{ name: text(item.name)!, text: text(item.text), link: text(item.link) }] : []));
  const logo = data.store.footerLogo ?? data.store.logo;
  return (
    <footer class="bz-footer">
      {settings.show_back_to_top !== false ? (
        <a class="bz-top-link" href="#">{t(context, { en: "Back to top", bn: "উপরে ফিরে যান" })}</a>
      ) : null}
      {data.menus.length > 0 ? (
        <div class="bz-footer-cols">
          {data.menus.slice(0, 4).map((menu) => (
            <section class="bz-footer-col">
              <h2>{menu.title}</h2>
              <ul>{menu.items.map((item) => <li><a href={item.url}>{item.title}</a></li>)}</ul>
            </section>
          ))}
        </div>
      ) : null}
      <div class="bz-footer-line">
        <a class="bz-footer-logo" href={data.routes.home} aria-label={data.store.name}>
          {logo ? <Image image={logo} alt={data.store.name} class="bz-footer-logo-img" /> : <span class="bz-logo-text">{data.store.name}<span class="bz-logo-smile" aria-hidden="true" /></span>}
        </a>
        <ul class="bz-footer-contact">
          {data.store.phone ? <li><a href={`tel:${data.store.phone.replace(/[^\d+]/g, "")}`}>{data.store.phone}</a></li> : null}
          {data.store.email ? <li><a href={`mailto:${data.store.email}`}>{data.store.email}</a></li> : null}
          {data.store.address ? <li><Icon name="globe" size={14} />{data.store.address}</li> : null}
        </ul>
        {data.store.social.length > 0 ? (
          <ul class="bz-footer-social">{data.store.social.map((entry) => <li><a href={entry.url} rel="noopener">{entry.network}</a></li>)}</ul>
        ) : null}
      </div>
      {services.length > 0 ? (
        <ul class="bz-services">
          {services.map((service) => (
            <li>
              {service.link ? <a href={service.link}><strong>{service.name}</strong>{service.text ? <span>{service.text}</span> : null}</a>
                : <span class="bz-service"><strong>{service.name}</strong>{service.text ? <span>{service.text}</span> : null}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      <div class={cx("bz-legal", services.length === 0 && "is-flush")}>
        {data.policies.length > 0 ? <ul>{data.policies.map((policy) => <li><a href={policy.url}>{policy.title}</a></li>)}</ul> : null}
        <p>{text(settings.copyright) ?? `© ${data.year}, ${data.store.name}`}</p>
      </div>
    </footer>
  );
}
