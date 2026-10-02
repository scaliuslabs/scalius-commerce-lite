import { describe, expect, it } from "vitest";
import { checkOutboundUrl, isBlockedIpv4, isBlockedIpv6, parseIpv6 } from "./outbound-url";

describe("checkOutboundUrl (SSRF guard)", () => {
  it.each([
    ["https://hooks.example.com/scalius", true],
    ["https://hooks.example.com:8443/scalius?token=abc", true],
    ["https://93.184.216.34/hook", true],
    ["https://[2606:4700:4700::1111]/hook", true],
    ["https://xn--fsq.example/hook", true],
  ])("allows public https endpoint %s", (url, ok) => {
    expect(checkOutboundUrl(url).ok).toBe(ok);
  });

  it.each([
    ["", "invalid_url"],
    ["not a url", "invalid_url"],
    ["http://hooks.example.com/x", "not_https"],
    ["ftp://hooks.example.com/x", "not_https"],
    ["https://user:pass@hooks.example.com/x", "credentials"],
    ["https://hooks.example.com/x#frag", "fragment"],
    [`https://hooks.example.com/${"a".repeat(2050)}`, "too_long"],
    // Names that mean "this machine" or a private network.
    ["https://localhost/x", "blocked_host"],
    ["https://LOCALHOST./x", "blocked_host"],
    ["https://api.localhost/x", "blocked_host"],
    ["https://printer.local/x", "blocked_host"],
    ["https://db.internal/x", "blocked_host"],
    ["https://metadata.google.internal/computeMetadata/v1/", "blocked_host"],
    ["https://router.home.arpa/x", "blocked_host"],
    ["https://intranet/x", "blocked_host"],
    // IPv4 literals in every form WHATWG URL accepts.
    ["https://127.0.0.1/x", "private_address"],
    ["https://127.1/x", "private_address"],
    ["https://2130706433/x", "private_address"],
    ["https://0x7f000001/x", "private_address"],
    ["https://0177.0.0.1/x", "private_address"],
    ["https://10.1.2.3/x", "private_address"],
    ["https://172.16.0.1/x", "private_address"],
    ["https://172.31.255.255/x", "private_address"],
    ["https://192.168.1.1/x", "private_address"],
    ["https://169.254.169.254/latest/meta-data/", "private_address"],
    ["https://100.64.0.1/x", "private_address"],
    ["https://0.0.0.0/x", "private_address"],
    ["https://198.18.0.1/x", "private_address"],
    ["https://224.0.0.1/x", "private_address"],
    ["https://255.255.255.255/x", "private_address"],
    // IPv6 literals.
    ["https://[::1]/x", "private_address"],
    ["https://[::]/x", "private_address"],
    ["https://[::ffff:127.0.0.1]/x", "private_address"],
    ["https://[::ffff:7f00:1]/x", "private_address"],
    ["https://[::ffff:8.8.8.8]/x", "private_address"],
    ["https://[::127.0.0.1]/x", "private_address"],
    ["https://[64:ff9b::a00:1]/x", "private_address"],
    ["https://[fc00::1]/x", "private_address"],
    ["https://[fd12:3456::1]/x", "private_address"],
    ["https://[fe80::1]/x", "private_address"],
    ["https://[fec0::1]/x", "private_address"],
    ["https://[ff02::1]/x", "private_address"],
    ["https://[2001:db8::1]/x", "private_address"],
    ["https://[2002:7f00:1::]/x", "private_address"],
    ["https://[2001::1]/x", "private_address"],
  ])("refuses %s (%s)", (url, issue) => {
    const result = checkOutboundUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toBe(issue);
  });

  it("keeps public neighbours of private ranges", () => {
    expect(isBlockedIpv4("172.32.0.1")).toBe(false);
    expect(isBlockedIpv4("100.128.0.1")).toBe(false);
    expect(isBlockedIpv4("11.0.0.1")).toBe(false);
    expect(isBlockedIpv4("192.169.0.1")).toBe(false);
    expect(isBlockedIpv6("2606:4700::1")).toBe(false);
    expect(isBlockedIpv6("fbff::1")).toBe(false);
  });

  it("parses compressed and dotted IPv6 forms", () => {
    expect(parseIpv6("[::ffff:127.0.0.1]")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIpv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("1:2:3")).toBeNull();
    expect(parseIpv6("127.0.0.1")).toBeNull();
  });
});
