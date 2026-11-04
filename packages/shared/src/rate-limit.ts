/**
 * Client addresses for rate limiting. The API reads the client address only
 * through apps/api/src/utils/client-ip.ts, which trusts `cf-connecting-ip`
 * (and `x-forwarded-for` only on a loopback platform); rate limiting itself
 * uses the native Workers Rate Limiting bindings (apps/api/src/utils/rate-limit.ts).
 *
 * A limiter subject groups an IPv6 client by its /64: one subscriber or host
 * gets a whole /64 and can rotate through it at will, so a per-address bucket
 * would give it billions of fresh budgets. IPv4 addresses stay as they are, and
 * an IPv4-mapped IPv6 address counts as its IPv4 address.
 */

/**
 * The limiter subject of one address: an IPv6 address becomes its /64 prefix
 * (`2001:db8:1:2::/64`), an IPv4-mapped IPv6 address its IPv4 address, an
 * IPv4 address itself. Anything that is not an IP address is returned trimmed
 * (callers pass `"unknown"` when no address is known).
 */
export function rateLimitIpSubject(address: string): string {
  const value = address.trim();
  if (!value.includes(":")) return value;
  const hextets = expandIpv6(value.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (!hextets) return value;
  if (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) {
    return `${hextets[6]! >> 8}.${hextets[6]! & 0xff}.${hextets[7]! >> 8}.${hextets[7]! & 0xff}`;
  }
  return `${hextets.slice(0, 4).map((part) => part.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function expandIpv6(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (half === "") return [];
    const groups: number[] = [];
    const parts = half.split(":");
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (index === parts.length - 1 && part.includes(".")) {
        const octets = part.split(".");
        if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return null;
        const [a, b, c, d] = octets.map(Number) as [number, number, number, number];
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}
