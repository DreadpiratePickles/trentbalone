/**
 * A real CONNECT-based, TLS-intercepting egress proxy.
 *
 * The previous implementation was a plain HTTP forwarder with no CONNECT handler - HTTPS could not
 * tunnel through it at all - and when no token resolved it forwarded the request anyway, which made
 * it an unauthenticated open relay. It also never consulted `intercept_domains`.
 *
 * The policy here is deny by default, enforced twice: at the CONNECT handshake (host must be in
 * `intercept_domains`) and again on the decrypted request (a token must resolve). There is no code
 * path that originates an upstream connection before both checks pass.
 *
 * [D3] The allowlist is by hostname, so the upstream address is decided by DNS. The proxy resolves
 * the host exactly once (`egress/pinned-lookup.ts`), refuses the request if ANY address in that one
 * answer is outside the host's policy (a DNS name must be public; a `*.localhost` name loopback; an IP
 * literal someone allowlisted is taken as written, bar cloud metadata), and dials that exact address
 * as a literal. SNI, certificate verification and the Host header stay the hostname. There is no
 * second resolution for a rebinding server to answer differently.
 * [O-03] Offline, every CONNECT and forward is pinned with NO resolver instead and refused
 * (`offline_non_loopback`) unless it is loopback by definition, whatever the allowlist says.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import { TokenManager } from "./TokenManager.js";
import { CertificateAuthority } from "./CertificateAuthority.js";
import { applyCredentials, extractToken, isHostAllowed, normalizeHost } from "./CredentialBroker.js";
import type { SecretWithheld } from "./host-binding.js";
import { PinRefused, isIpLiteral, resolvePinned } from "./pinned-lookup.js";
import { REFUSAL_OFFLINE, pinOfflineUpstream, proxyIsOffline } from "./offline-proxy.js"; // [O-03]
import type { LookupFn } from "../tools/web/url-safety.js";
import type { ProxyTokenRecord } from "./TokenStorePort.js";
import type { ConfigManager } from "../config/ConfigManager.js";
import { StructuredLogger } from "../telemetry/logger.js";

export interface UpstreamOverride {
  host: string;
  port: number;
}

export interface EgressProxyOptions {
  port?: number;
  /**
   * Addresses to listen on, all on the same port. Default loopback only. On Linux the Docker
   * bridge gateway is added so `host.docker.internal:host-gateway` inside a container reaches the
   * proxy; a wildcard (`0.0.0.0`, `::`) is refused outright. Every listener enforces the same two
   * gates, so a non-loopback listener is not an open relay: no token, no forwarding.
   */
  bindHosts?: string[];
  tokenManager?: TokenManager;
  configManager?: ConfigManager;
  ca?: CertificateAuthority;
  /** Overrides `config.egress.intercept_domains`. */
  interceptDomains?: string[];
  /** Extra trust roots used when originating TLS upstream (private PKI, test servers). */
  upstreamCa?: string[];
  /** Redirect an allowlisted host to a different address. For tests and staging only. */
  upstreamOverrides?: Record<string, UpstreamOverride>;
  /** Where the proxy's structured log lines go (`egress.secret_withheld`). Defaults to stderr. */
  log?: (line: string) => void;
  /** [D3] The resolver for the single upstream resolution. Defaults to `dns.promises.lookup`. */
  lookup?: LookupFn;
  /**
   * [D16] Told of every request the proxy allowed or refused, for the run's security receipt. It
   * observes only: it is called after the decision is made, a throw from it is swallowed, and it is
   * given the host, the reason code and the credential outcome, never a header, token or secret.
   */
  onDecision?: (decision: EgressDecision) => void;
  offline?: boolean; // [O-03] loopback upstreams only; absent, TRENT_OFFLINE is read at each decision
}

/** [D16] One proxy decision. `rule` is the refusal's reason code; `credential` what the broker did. */
export interface EgressDecision {
  readonly host: string;
  readonly port?: number;
  readonly verdict: "allowed" | "refused";
  readonly rule?: string;
  readonly credential?: "injected" | "withheld" | "none";
}

/** Bound on the remembered (token, host) pairs a withheld line was written for; cleared when full. */
const WITHHELD_MEMORY = 1024;

interface Target {
  host: string;
  port: number;
  pinned?: Target; // [O-03] the loopback address an offline CONNECT resolved for this tunnel
}

const REFUSAL_NO_TOKEN = {
  error: "egress_refused",
  reason: "no_resolvable_token",
  message:
    "Trent egress proxy refused this request: no valid broker token was presented. " +
    "The request was NOT forwarded.",
};

const REFUSAL_HOST = {
  error: "egress_refused",
  reason: "host_not_allowlisted",
  message:
    "Trent egress proxy refused this request: the host is not in config.egress.intercept_domains. " +
    "The request was NOT forwarded.",
};

const REFUSAL_ADDRESS = {
  error: "egress_refused",
  reason: "resolved_address_not_permitted",
  message:
    "Trent egress proxy refused this request: the allowlisted host resolved to an address it may not " +
    "reach (private, loopback, link-local or cloud metadata). The request was NOT forwarded.",
};

const WILDCARD_BIND = new Set(["0.0.0.0", "::", "", "*", "0:0:0:0:0:0:0:0", "[::]"]);

/** Refuses to bind every interface. There is no configuration that turns this off. */
export function assertBindHosts(hosts: readonly string[]): string[] {
  if (hosts.length === 0) throw new Error("egress proxy: bindHosts must name at least one address");
  for (const host of hosts) {
    if (WILDCARD_BIND.has(host.trim())) {
      throw new Error(`egress proxy: refusing to bind ${JSON.stringify(host)}; name a specific address, never every interface`);
    }
  }
  return [...new Set(hosts.map((h) => h.trim()))];
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  res.end(payload);
}

function refuseConnect(socket: net.Socket, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Proxy Authentication Required"}\r\n` +
      `x-trent-egress: refused\r\nx-trent-egress-reason: ${reason}\r\n` +
      "content-length: 0\r\nconnection: close\r\n\r\n"
  );
  socket.destroy();
}

export class EgressProxy {
  private readonly tokenManager: TokenManager;
  private readonly configManager?: ConfigManager;
  private readonly ca: CertificateAuthority;
  private readonly interceptDomains: readonly string[];
  private readonly upstreamCa?: string[];
  private readonly upstreamOverrides: Record<string, UpstreamOverride>;
  private readonly lookup?: LookupFn;
  private readonly onDecision?: (decision: EgressDecision) => void; // [D16]
  private readonly offline?: boolean; // [O-03]
  private readonly targets = new WeakMap<net.Socket, Target>();
  private readonly sockets = new Set<net.Socket>();
  private readonly logger: StructuredLogger;
  /** (token, host:port) pairs already reported as withheld: one line per host per token, not per request. */
  private readonly withheldSeen = new Set<string>();

  private port: number;
  private readonly bindHosts: readonly string[];
  private servers: http.Server[] = [];
  private interceptor: http.Server | null = null;
  private running = false;

  constructor(options?: EgressProxyOptions) {
    this.configManager = options?.configManager;
    const config = this.configManager?.loadConfig();
    this.port = options?.port ?? config?.egress?.proxy_port ?? 8089;
    this.bindHosts = assertBindHosts(options?.bindHosts ?? ["127.0.0.1"]);
    this.tokenManager = options?.tokenManager ?? new TokenManager();
    this.ca = options?.ca ?? new CertificateAuthority();
    this.interceptDomains =
      options?.interceptDomains ?? config?.egress?.intercept_domains ?? [];
    this.upstreamCa = options?.upstreamCa;
    this.upstreamOverrides = options?.upstreamOverrides ?? {};
    this.lookup = options?.lookup;
    this.onDecision = options?.onDecision;
    this.offline = options?.offline;
    this.logger = new StructuredLogger({ runId: "egress", stage: "egress.proxy", ...(options?.log ? { sink: options.log } : {}) });
  }

  /** [D16] Reports a decision already made. The observer can neither change it nor break the proxy. */
  private decide(decision: EgressDecision): void {
    try {
      this.onDecision?.(decision);
    } catch {
      // An observer never fails what it observes.
    }
  }

  public getTokenManager(): TokenManager {
    return this.tokenManager;
  }

  public getCertificateAuthority(): CertificateAuthority {
    return this.ca;
  }

  public getCaCertPath(): string {
    return this.ca.getCaCertPath();
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getPort(): number {
    return this.port;
  }

  public getBindHosts(): readonly string[] {
    return this.bindHosts;
  }

  public getInterceptDomains(): readonly string[] {
    return this.interceptDomains;
  }

  public async start(): Promise<void> {
    if (this.running) return;

    this.interceptor = http.createServer((req, res) => {
      void this.handleIntercepted(req, res);
    });

    // One server per address, all on one port: the first listener fixes the port when it is 0.
    for (const host of this.bindHosts) {
      const server = http.createServer((req, res) => {
        void this.handlePlain(req, res);
      });
      server.on("connect", (req, socket: net.Socket, head: Buffer) => {
        void this.handleConnect(req, socket, head);
      });
      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.port, host, () => {
            const address = server.address();
            if (typeof address === "object" && address) this.port = address.port;
            server.removeListener("error", reject);
            resolve();
          });
        });
      } catch (error) {
        await this.closeServers();
        throw error;
      }
      this.servers.push(server);
    }
    this.running = true;
  }

  private async closeServers(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.servers = [];
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    await this.closeServers();
    this.interceptor?.closeAllConnections?.();
    this.interceptor = null;
    this.running = false;
  }

  /** CONNECT: the only place a tunnel is opened, and the first allowlist gate. */
  private async handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());

    const authority = req.url ?? "";
    const host = normalizeHost(authority);
    const port = Number(authority.split(":").pop()) || 443;

    if (!isHostAllowed(host, this.interceptDomains)) {
      refuseConnect(socket, 403, "host_not_allowlisted");
      this.decide({ host, port, verdict: "refused", rule: "host_not_allowlisted" });
      return;
    }

    let target: Target = { host, port };
    if (proxyIsOffline(this.offline)) { // [O-03] the tunnel opens only to an upstream wholly on loopback
      const pinned = await this.offlinePin(target);
      if (!pinned) {
        refuseConnect(socket, 403, REFUSAL_OFFLINE.reason);
        this.decide({ host, port, verdict: "refused", rule: REFUSAL_OFFLINE.reason });
        return;
      }
      if (socket.destroyed) return;
      target = { host, port, pinned };
    }

    let leaf: { certPem: string; keyPem: string };
    try {
      leaf = this.ca.issueLeaf(host);
    } catch {
      refuseConnect(socket, 403, "certificate_issue_failed");
      this.decide({ host, port, verdict: "refused", rule: "certificate_issue_failed" });
      return;
    }

    socket.write("HTTP/1.1 200 Connection Established\r\nproxy-agent: trent-egress\r\n\r\n");
    if (head?.length) socket.unshift(head);

    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      cert: leaf.certPem,
      key: leaf.keyPem,
    });
    secure.on("error", () => secure.destroy());
    this.targets.set(secure, target);
    this.interceptor?.emit("connection", secure);
  }

  /** A decrypted request arriving over an established tunnel. */
  private async handleIntercepted(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const target = this.targets.get(req.socket) ?? {
      host: normalizeHost(req.headers.host),
      port: 443,
    };
    await this.mediate(req, res, target, true);
  }

  /** A plain (non-CONNECT) proxy request. Same policy; no exceptions. */
  private async handlePlain(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url === "/health" || req.url === "/_health") {
      writeJson(res, 200, {
        status: "healthy",
        proxy: "trent-egress",
        interception: "tls",
        activeTokens: this.tokenManager.listActiveTokens().length,
        interceptDomains: this.interceptDomains,
      });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(
        req.url?.startsWith("http") ? req.url : `http://${req.headers.host ?? ""}${req.url ?? ""}`
      );
    } catch {
      writeJson(res, 400, { error: "egress_refused", reason: "unparseable_target" });
      this.decide({ host: "", verdict: "refused", rule: "unparseable_target" });
      return;
    }

    const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    req.url = `${parsed.pathname}${parsed.search}`;
    await this.mediate(req, res, { host: parsed.hostname.toLowerCase(), port }, parsed.protocol === "https:");
  }

  /**
   * One `egress.secret_withheld` line the first time a token's secret is withheld from a host: the
   * request still goes, without the secret. Names the host, the reason and the bound hosts; never
   * the secret, never the token.
   */
  private noteWithheld(record: ProxyTokenRecord, event: SecretWithheld): void {
    const key = `${record.token}\n${event.host}:${event.port ?? ""}`;
    if (this.withheldSeen.has(key)) return;
    if (this.withheldSeen.size >= WITHHELD_MEMORY) this.withheldSeen.clear();
    this.withheldSeen.add(key);
    this.logger.warn("egress.secret_withheld", {
      host: event.host,
      ...(event.port === undefined ? {} : { port: event.port }),
      reason: event.reason,
      boundHosts: [...event.boundHosts],
      agentId: record.agentId,
      ...(record.toolsetName === undefined ? {} : { toolset: record.toolsetName }),
    });
  }

  /**
   * [D3] The one resolution: the literal address this request will be dialled at. An upstream override
   * (tests, staging) is dialled as configured. Otherwise the host is resolved once and every address in
   * the answer is held to the host's policy; `refused: true` means an address was outside it (403),
   * `refused: false` that there was no usable answer (502).
   */
  private async pinUpstream(target: Target): Promise<Target | { refused: boolean; offline?: true }> {
    if (proxyIsOffline(this.offline)) {
      return target.pinned ?? (await this.offlinePin(target)) ?? { refused: true, offline: true }; // [O-03]
    }
    const override = this.upstreamOverrides[target.host];
    if (override) return override;
    try {
      const pin = await resolvePinned(target.host, this.lookup ? { lookup: this.lookup } : {});
      return { host: pin.address, port: target.port };
    } catch (err) {
      if (!(err instanceof PinRefused)) throw err;
      this.logger.warn("egress.address_refused", {
        host: err.host,
        port: target.port,
        ...(err.address === null ? {} : { address: err.address }),
        detail: err.detail,
      });
      return { refused: err.address !== null };
    }
  }

  /** [O-03] The offline pin: a loopback literal to dial, or null (logged) when the upstream is off the machine. */
  private offlinePin(target: Target): Promise<Target | null> {
    return pinOfflineUpstream(target, this.upstreamOverrides[target.host], (f) => this.logger.warn("egress.offline_refused", f));
  }

  /**
   * The single forwarding path. Both gates are checked here before anything is dialled, so there is
   * no branch that can reach an upstream with an unauthenticated request.
   */
  private async mediate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: Target,
    useTls: boolean
  ): Promise<void> {
    const where = { host: target.host, port: target.port }; // [D16]
    if (!isHostAllowed(target.host, this.interceptDomains)) {
      writeJson(res, 403, REFUSAL_HOST);
      req.resume();
      this.decide({ ...where, verdict: "refused", rule: REFUSAL_HOST.reason });
      return;
    }

    const token = extractToken(req.headers);
    const record = token === null ? null : this.tokenManager.resolveToken(token);
    if (!record) {
      writeJson(res, 407, REFUSAL_NO_TOKEN);
      req.resume();
      this.decide({ ...where, verdict: "refused", rule: REFUSAL_NO_TOKEN.reason });
      return;
    }

    const dial = await this.pinUpstream(target);
    if ("refused" in dial) {
      const body = dial.offline ? REFUSAL_OFFLINE : dial.refused ? REFUSAL_ADDRESS : { error: "egress_upstream_error", reason: "unresolvable_host" };
      writeJson(res, dial.refused ? 403 : 502, body);
      req.resume();
      this.decide({ ...where, verdict: "refused", rule: body.reason });
      return;
    }

    let credential: EgressDecision["credential"] = "none"; // [D16] what the broker did, never what it wrote
    const headers = applyCredentials(req.headers, target.host, record, {
      port: target.port,
      onWithheld: (event) => {
        credential = "withheld";
        this.noteWithheld(record, event);
      },
      onInjected: () => {
        credential = "injected";
      },
    });
    headers.host ??= target.host;
    this.decide({ ...where, verdict: "allowed", credential });

    const options: https.RequestOptions = {
      host: dial.host,
      port: dial.port,
      method: req.method,
      path: req.url,
      headers,
      ...(useTls
        ? {
            // SNI and certificate verification use the hostname, never the pinned literal.
            ...(isIpLiteral(target.host) ? {} : { servername: target.host }),
            ...(this.upstreamCa ? { ca: this.upstreamCa } : {}),
          }
        : {}),
    };

    const transport = useTls ? https : http;
    const upstream = transport.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      writeJson(res, 502, {
        error: "egress_upstream_error",
        reason: err.code ?? "unknown",
      });
    });
    req.pipe(upstream);
  }
}
