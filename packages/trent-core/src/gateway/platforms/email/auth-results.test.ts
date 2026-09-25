import { describe, it, expect } from "vitest";
import { checkSenderAuth, domainOf, isAligned, parseAuthenticationResults, parseReceivedSpf, type SenderAuthInput } from "./auth-results.js";

const GMAIL = [
  "mx.google.com;",
  "       dkim=pass header.i=@example.com header.s=sel1 header.b=AbCd1234;",
  "       spf=pass (google.com: domain of alice@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=alice@example.com;",
  "       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
].join(" ");

describe("parseAuthenticationResults (RFC 8601)", () => {
  it("reads the authserv-id and every method, result and property, with comments dropped", () => {
    expect(parseAuthenticationResults(GMAIL)).toEqual({
      authservId: "mx.google.com",
      results: [
        { method: "dkim", result: "pass", props: { "header.i": "@example.com", "header.s": "sel1", "header.b": "AbCd1234" } },
        { method: "spf", result: "pass", props: { "smtp.mailfrom": "alice@example.com" } },
        { method: "dmarc", result: "pass", props: { "header.from": "example.com" } },
      ],
    });
  });

  it("never reads a verdict out of a comment, even one carrying a semicolon", () => {
    const parsed = parseAuthenticationResults("mx.example.com; spf=fail (note; dmarc=pass header.from=example.com) smtp.mailfrom=evil.example");
    expect(parsed.results).toEqual([{ method: "spf", result: "fail", props: { "smtp.mailfrom": "evil.example" } }]);
  });

  it("handles nested comments, quoted values, versions and any letter case", () => {
    expect(parseAuthenticationResults('MX.Example.COM 1 (a (b) c); DKIM/1=Pass Header.D="Example.COM" reason="good; sig"').results).toEqual([
      { method: "dkim", result: "pass", props: { "header.d": "Example.COM" } },
    ]);
  });

  it("reads a header that names no server (the first clause is already a result) with an empty authserv-id", () => {
    expect(parseAuthenticationResults("spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.com; dmarc=pass action=none header.from=example.com")).toEqual({
      authservId: "",
      results: [
        { method: "spf", result: "pass", props: { "smtp.mailfrom": "example.com" } },
        { method: "dmarc", result: "pass", props: { "header.from": "example.com" } },
      ],
    });
    const unnamed = { fromAddress: "alice@example.com", fromHeaderCount: 1, receivedSpf: [], authenticationResults: ["spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com"] };
    expect(checkSenderAuth({ ...unnamed, authservId: "mx.example.com" })).toEqual({ ok: false, verdict: "no Authentication-Results from mx.example.com" });
  });

  it("reads `none` as no results at all", () => {
    expect(parseAuthenticationResults("mx.example.com; none")).toEqual({ authservId: "mx.example.com", results: [] });
  });
});

describe("parseReceivedSpf (RFC 7208 section 9.1)", () => {
  it("reads the result and the envelope-from when the checked identity is the MAIL FROM", () => {
    const value = 'pass (mx.example.com: domain of alice@example.com designates 192.0.2.1 as permitted sender) receiver=mx.example.com; client-ip=192.0.2.1; envelope-from="alice@example.com"; helo=mail.example.com; identity=mailfrom';
    expect(parseReceivedSpf(value)).toEqual({ method: "spf", result: "pass", props: { "smtp.mailfrom": "alice@example.com" } });
  });

  it("does not report a MAIL FROM domain when only the HELO name was checked", () => {
    expect(parseReceivedSpf("Pass (mx: helo checked) envelope-from=<>; helo=mail.example.com; identity=helo")).toEqual({ method: "spf", result: "pass", props: {} });
  });
});

describe("domainOf and isAligned", () => {
  it("takes the domain of an address, a bare domain or a DKIM identity, lower-cased", () => {
    expect(domainOf("Alice <Alice@Example.COM>")).toBe("example.com");
    expect(domainOf("@example.com")).toBe("example.com");
    expect(domainOf('"bounces+1@mail.example.com"')).toBe("mail.example.com");
    expect(domainOf("example.com.")).toBe("example.com");
    expect(domainOf("")).toBe("");
  });

  it("aligns a domain with itself and with its own subtree, never with a sibling, a look-alike or a bare TLD", () => {
    expect(isAligned("example.com", "example.com")).toBe(true);
    expect(isAligned("mail.example.com", "example.com")).toBe(true);
    expect(isAligned("example.com", "bounce.mail.example.com")).toBe(true);
    expect(isAligned("a.example.com", "b.example.com")).toBe(false);
    expect(isAligned("notexample.com", "example.com")).toBe(false);
    expect(isAligned("com", "example.com")).toBe(false);
    expect(isAligned("", "example.com")).toBe(false);
  });
});

describe("checkSenderAuth", () => {
  const base: SenderAuthInput = { fromAddress: "alice@example.com", fromHeaderCount: 1, authenticationResults: [], receivedSpf: [] };
  const ar = (...values: string[]): SenderAuthInput => ({ ...base, authenticationResults: values });

  it("accepts dmarc=pass for the From domain", () => {
    expect(checkSenderAuth(ar(GMAIL))).toEqual({ ok: true, verdict: "dmarc=pass header.from=example.com" });
  });

  it("refuses dmarc=pass evaluated for some other From domain", () => {
    expect(checkSenderAuth(ar("mx; dmarc=pass header.from=other.example"))).toEqual({ ok: false, verdict: "dmarc=pass header.from=other.example is not the From domain example.com" });
  });

  it("refuses dmarc=fail, temperror and permerror even beside an aligned dkim=pass", () => {
    for (const result of ["fail", "temperror", "permerror"]) {
      expect(checkSenderAuth(ar(`mx; dkim=pass header.d=example.com; dmarc=${result} header.from=example.com`))).toEqual({ ok: false, verdict: `dmarc=${result}` });
    }
  });

  it("with no DMARC verdict, accepts an aligned dkim=pass by header.d or header.i and refuses an unaligned one", () => {
    expect(checkSenderAuth(ar("mx; dmarc=none; dkim=pass header.d=example.com"))).toEqual({ ok: true, verdict: "dkim=pass header.d=example.com" });
    expect(checkSenderAuth(ar("mx; dkim=pass header.i=@mail.example.com"))).toEqual({ ok: true, verdict: "dkim=pass header.d=mail.example.com" });
    expect(checkSenderAuth(ar("mx; dkim=pass header.d=evil.example"))).toEqual({ ok: false, verdict: "no aligned pass for example.com: dmarc=absent spf=absent dkim=pass header.d=evil.example" });
  });

  it("accepts an spf=pass only when the MAIL FROM domain is aligned, never on a HELO check", () => {
    expect(checkSenderAuth(ar("mx; spf=pass smtp.mailfrom=bounces@mail.example.com"))).toEqual({ ok: true, verdict: "spf=pass smtp.mailfrom=mail.example.com" });
    expect(checkSenderAuth(ar("mx; spf=pass smtp.mailfrom=mallory@evil.example")).ok).toBe(false);
    expect(checkSenderAuth(ar("mx; spf=pass smtp.helo=mail.example.com")).ok).toBe(false);
  });

  it("reads only the topmost Authentication-Results; one the sender wrote below it is ignored", () => {
    expect(checkSenderAuth(ar("mx; dmarc=fail header.from=example.com", "mx; dmarc=pass header.from=example.com"))).toEqual({ ok: false, verdict: "dmarc=fail" });
  });

  it("consults Received-SPF only when there is no Authentication-Results at all", () => {
    const spf = 'pass (mx: designates) envelope-from="alice@example.com"; identity=mailfrom';
    expect(checkSenderAuth({ ...base, receivedSpf: [spf] })).toEqual({ ok: true, verdict: "spf=pass smtp.mailfrom=example.com (Received-SPF)" });
    // An MTA verdict with no SPF result is complete: a Received-SPF beside it could be the sender's own.
    expect(checkSenderAuth({ ...ar("mx; dmarc=none; dkim=none"), receivedSpf: [spf] }).ok).toBe(false);
  });

  it("with authservId set, reads the first header naming that server, case-insensitively, and ignores every other", () => {
    const forgedPass = "forged.example; dmarc=pass header.from=example.com";
    expect(checkSenderAuth({ ...ar(forgedPass, "MX.Example.com; dmarc=fail header.from=example.com"), authservId: "mx.example.com" })).toEqual({ ok: false, verdict: "dmarc=fail" });
    expect(checkSenderAuth({ ...ar("forged.example; dmarc=fail", '"mx.example.com" 1; dmarc=pass header.from=example.com'), authservId: " MX.EXAMPLE.COM " })).toEqual({ ok: true, verdict: "dmarc=pass header.from=example.com" });
  });

  it("with authservId set, refuses when no header names that server, and never falls back to Received-SPF", () => {
    const spf = 'pass (mx: designates) envelope-from="alice@example.com"; identity=mailfrom';
    const refused = { ok: false, verdict: "no Authentication-Results from mx.example.com" };
    expect(checkSenderAuth({ ...ar("forged.example; dmarc=pass header.from=example.com"), authservId: "mx.example.com" })).toEqual(refused);
    expect(checkSenderAuth({ ...base, receivedSpf: [spf], authservId: "mx.example.com" })).toEqual(refused);
  });

  it("with authservId unset or blank, the topmost header decides as before", () => {
    const forgedFirst = ar("forged.example; dmarc=pass header.from=example.com", "mx.example.com; dmarc=fail header.from=example.com");
    expect(checkSenderAuth(forgedFirst)).toEqual({ ok: true, verdict: "dmarc=pass header.from=example.com" });
    expect(checkSenderAuth({ ...forgedFirst, authservId: "  " })).toEqual({ ok: true, verdict: "dmarc=pass header.from=example.com" });
  });

  it("refuses a message with no verdict, a `none` verdict, no From address or two From headers", () => {
    expect(checkSenderAuth(base)).toEqual({ ok: false, verdict: "no Authentication-Results or Received-SPF header" });
    expect(checkSenderAuth(ar("mx.example.com; none"))).toEqual({ ok: false, verdict: "no aligned pass for example.com: dmarc=absent spf=absent dkim=absent" });
    expect(checkSenderAuth({ ...ar(GMAIL), fromAddress: "" })).toEqual({ ok: false, verdict: "no From address" });
    expect(checkSenderAuth({ ...ar(GMAIL), fromHeaderCount: 2 })).toEqual({ ok: false, verdict: "2 From headers" });
  });
});
