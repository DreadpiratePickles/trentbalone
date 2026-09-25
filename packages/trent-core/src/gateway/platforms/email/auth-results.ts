/**
 * The receiving server's sender-authentication verdict for one inbound mail, read from the RFC 8601
 * `Authentication-Results` header (dmarc, spf, dkim) or, only when a message carries none, from the
 * RFC 7208 `Received-SPF` trace header. Pure: no I/O, no clock, no logging.
 *
 * Trust: with `authservId` set (`gateway.email.authserv_id`), only an Authentication-Results
 * header whose authserv-id (RFC 8601 section 2.2, the first token before the `;`) equals it,
 * case-insensitively, is read: the first such header. Every other one is sender-supplied, and
 * Received-SPF, which names no server, is never read. Without it, only the TOPMOST header of each
 * kind is read: a receiving MTA prepends its own verdict, so the first one is the server's on a
 * server that writes one. When a message has an Authentication-Results header, that verdict is the
 * whole verdict: a Received-SPF beside it is ignored, since it too could be the sender's own.
 *
 * Acceptance, in order:
 *   1. exactly one From header, carrying an address;
 *   2. `dmarc=pass` accepts when its `header.from` is the From domain (or is absent); any other
 *      DMARC result except `none` / `bestguesspass` (no policy published) refuses outright;
 *   3. otherwise a `dkim=pass` whose `header.d` (else the domain of `header.i`) is aligned accepts;
 *   4. otherwise an `spf=pass` whose `smtp.mailfrom` domain is aligned accepts (a HELO-only check
 *      never counts);
 *   5. everything else refuses.
 *
 * Alignment is relaxed alignment in subtree form: two domains align when they are equal, or when
 * one is a dot-boundary suffix of the other and the shorter still contains a dot
 * (`mail.example.com` with `example.com`). Siblings (`a.example.com`, `b.example.com`) never
 * align, so no Public Suffix List is needed and two tenants of a shared suffix (`x.github.io`,
 * `y.github.io`) can never vouch for each other.
 */

export interface MethodResult {
  /** `dmarc`, `spf`, `dkim`, ... lower-cased, version dropped. */
  method: string;
  /** `pass`, `fail`, `none`, ... lower-cased. */
  result: string;
  /** `ptype.property` -> value, e.g. `header.from`, `smtp.mailfrom`, `header.d`; keys lower-cased. */
  props: Record<string, string>;
}

export interface AuthenticationResults {
  authservId: string;
  results: MethodResult[];
}

export interface SenderAuthInput {
  /** The bare From address as the adapter uses it for `senderId`. */
  fromAddress: string;
  /** How many From headers the message carried. */
  fromHeaderCount: number;
  /** Every Authentication-Results value, top to bottom; only the first is read. */
  authenticationResults: readonly string[];
  /** Every Received-SPF value, top to bottom; only the first is read, and only without the above. */
  receivedSpf: readonly string[];
  /** The receiving server's authserv-id; when set, only its own Authentication-Results counts. */
  authservId?: string;
}

export interface SenderAuthVerdict {
  ok: boolean;
  /** One short line for the log: the method and result that decided, and the domains involved. */
  verdict: string;
}

/** DMARC results that mean "no policy to apply", after which SPF and DKIM decide. */
const DMARC_NO_POLICY = new Set(["none", "bestguesspass"]);
const DOMAIN_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/** Splits on `;` outside quoted strings and drops comments, which RFC 5322 lets nest. */
function clauses(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (quoted) {
      current += ch;
      if (ch === "\\") current += value[++i] ?? "";
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === "(") { depth = 1; current += " "; continue; }
    if (ch === ";") { out.push(current); current = ""; continue; }
    if (ch === '"') quoted = true;
    current += ch;
  }
  out.push(current);
  return out.map((c) => c.replace(/\s*=\s*/g, "=").trim()).filter((c) => c !== "");
}

/** Whitespace-separated tokens, a quoted string staying inside its token. */
function tokens(clause: string): string[] {
  return clause.match(/(?:"(?:[^"\\]|\\.)*"|[^\s"])+/g) ?? [];
}

function unquote(value: string): string {
  return /^"(?:[^"\\]|\\.)*"$/.test(value) ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value;
}

const METHOD_RE = /^([A-Za-z0-9_-]+)(?:\/\d+)?=([A-Za-z]+)$/;

export function parseAuthenticationResults(value: string): AuthenticationResults {
  const all = clauses(value);
  // Some servers omit the authserv-id and start with a result; such a header names no server.
  const named = !METHOD_RE.test(tokens(all[0] ?? "")[0] ?? "");
  const head = named ? all[0] ?? "" : "";
  const results: MethodResult[] = [];
  for (const clause of named ? all.slice(1) : all) {
    const [first = "", ...more] = tokens(clause);
    const m = METHOD_RE.exec(first);
    if (!m) continue; // `none`, or something this reader does not understand: never a pass
    const props: Record<string, string> = {};
    for (const token of more) {
      const p = /^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)=(.+)$/.exec(token);
      if (p) props[p[1].toLowerCase()] = unquote(p[2]);
    }
    results.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props });
  }
  return { authservId: unquote(tokens(head)[0] ?? "").toLowerCase(), results };
}

/** `Received-SPF: <result> (<comment>) key=value; ...`, as an `spf` method result. */
export function parseReceivedSpf(value: string): MethodResult | undefined {
  const all = clauses(value).flatMap(tokens);
  const result = all[0]?.toLowerCase();
  if (!result || !/^[a-z]+$/.test(result)) return undefined;
  const kv: Record<string, string> = {};
  for (const token of all.slice(1)) {
    const p = /^([A-Za-z0-9_-]+)=(.*)$/.exec(token);
    if (p) kv[p[1].toLowerCase()] = unquote(p[2]);
  }
  const props: Record<string, string> = {};
  const envelopeFrom = (kv["envelope-from"] ?? "").replace(/^<|>$/g, "");
  if ((kv.identity ?? "mailfrom").toLowerCase() === "mailfrom" && envelopeFrom !== "") props["smtp.mailfrom"] = envelopeFrom;
  return { method: "spf", result, props };
}

/** The domain of an address (`Name <a@b>`, `a@b`), a DKIM identity (`@b`) or a bare domain; "" when not a hostname. */
export function domainOf(value: string): string {
  let v = value.trim();
  const angle = /<([^>]*)>/.exec(v);
  if (angle) v = angle[1];
  const at = v.lastIndexOf("@");
  if (at !== -1) v = v.slice(at + 1);
  v = v.replace(/^"+|"+$/g, "").trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN_RE.test(v) ? v : "";
}

export function isAligned(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === "" || y === "") return false;
  if (x === y) return true;
  const [shorter, longer] = x.length < y.length ? [x, y] : [y, x];
  return shorter.includes(".") && longer.endsWith(`.${shorter}`);
}

function dkimDomain(r: MethodResult): string {
  return domainOf(r.props["header.d"] ?? r.props["header.i"] ?? "");
}

function describe(r: MethodResult | undefined, key: "smtp.mailfrom" | "header.d"): string {
  if (!r) return "absent";
  const domain = key === "header.d" ? dkimDomain(r) : domainOf(r.props[key] ?? "");
  return domain ? `${r.result} ${key}=${domain}` : r.result;
}

export function checkSenderAuth(input: SenderAuthInput): SenderAuthVerdict {
  const refuse = (verdict: string): SenderAuthVerdict => ({ ok: false, verdict });
  const accept = (verdict: string): SenderAuthVerdict => ({ ok: true, verdict });
  if (input.fromHeaderCount > 1) return refuse(`${input.fromHeaderCount} From headers`);
  const fromDomain = domainOf(input.fromAddress);
  if (fromDomain === "") return refuse("no From address");

  const pinned = input.authservId?.trim() ?? "";
  let topResults: AuthenticationResults | undefined;
  let topSpf: string | undefined;
  if (pinned !== "") {
    topResults = input.authenticationResults.map(parseAuthenticationResults).find((r) => r.authservId === pinned.toLowerCase());
    if (topResults === undefined) return refuse(`no Authentication-Results from ${pinned}`);
  } else {
    const first = input.authenticationResults[0];
    topResults = first !== undefined ? parseAuthenticationResults(first) : undefined;
    topSpf = input.receivedSpf[0];
    if (topResults === undefined && topSpf === undefined) return refuse("no Authentication-Results or Received-SPF header");
  }
  const results = topResults?.results ?? [];
  const spf = topResults !== undefined ? results.find((r) => r.method === "spf") : parseReceivedSpf(topSpf ?? "");
  const dmarc = results.find((r) => r.method === "dmarc");
  const dkims = results.filter((r) => r.method === "dkim");

  if (dmarc?.result === "pass") {
    const evaluated = dmarc.props["header.from"];
    if (evaluated === undefined || domainOf(evaluated) === fromDomain) return accept(`dmarc=pass header.from=${fromDomain}`);
    return refuse(`dmarc=pass header.from=${domainOf(evaluated) || "(invalid)"} is not the From domain ${fromDomain}`);
  }
  if (dmarc && !DMARC_NO_POLICY.has(dmarc.result)) return refuse(`dmarc=${dmarc.result}`);

  const dkim = dkims.find((r) => r.result === "pass" && isAligned(dkimDomain(r), fromDomain));
  if (dkim) return accept(`dkim=pass header.d=${dkimDomain(dkim)}`);

  const mailFrom = domainOf(spf?.props["smtp.mailfrom"] ?? "");
  if (spf?.result === "pass" && isAligned(mailFrom, fromDomain)) {
    return accept(`spf=pass smtp.mailfrom=${mailFrom}${topResults === undefined ? " (Received-SPF)" : ""}`);
  }
  const shownDkim = dkims.find((r) => r.result === "pass") ?? dkims[0];
  return refuse(`no aligned pass for ${fromDomain}: dmarc=${dmarc?.result ?? "absent"} spf=${describe(spf, "smtp.mailfrom")} dkim=${describe(shownDkim, "header.d")}`);
}
