import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { TokenManager } from "./TokenManager.js";
import { ConfigManager } from "../config/ConfigManager.js";

export interface EgressProxyOptions {
  port?: number;
  tokenManager?: TokenManager;
  configManager?: ConfigManager;
}

export class EgressProxy {
  private port: number;
  private tokenManager: TokenManager;
  private configManager: ConfigManager;
  private server: http.Server | null = null;
  private running = false;

  constructor(options?: EgressProxyOptions) {
    this.configManager = options?.configManager || new ConfigManager();
    const config = this.configManager.loadConfig();
    this.port = options?.port || config.egress?.proxy_port || 8089;
    this.tokenManager = options?.tokenManager || new TokenManager();
  }

  public getTokenManager(): TokenManager {
    return this.tokenManager;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getPort(): number {
    return this.port;
  }

  public async start(): Promise<void> {
    if (this.running) return;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err: any) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Egress proxy error", details: err.message }));
        }
      });

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        this.running = true;
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.running || !this.server) return;

    return new Promise((resolve) => {
      this.server?.close(() => {
        this.running = false;
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Health check endpoint
    if (req.url === "/health" || req.url === "/_health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", proxy: "trent-egress", activeTokens: this.tokenManager.listActiveTokens().length }));
      return;
    }

    // Extract proxy token from headers
    const authHeader = req.headers["authorization"] || "";
    const customTokenHeader = req.headers["x-trent-proxy-token"] as string | undefined;

    let candidateToken: string | null = null;
    if (customTokenHeader) {
      candidateToken = customTokenHeader;
    } else if (typeof authHeader === "string" && authHeader.startsWith("Bearer trnt_egress_")) {
      candidateToken = authHeader.replace("Bearer ", "").trim();
    }

    let resolvedCredentials: Record<string, string> = {};
    if (candidateToken) {
      const record = this.tokenManager.resolveToken(candidateToken);
      if (record) {
        resolvedCredentials = record.realCredentials;
      }
    }

    // Parse target URL from request
    const targetUrlStr = req.url?.startsWith("http")
      ? req.url
      : `https://${req.headers.host || "api.openai.com"}${req.url}`;
    const targetUrl = new URL(targetUrlStr);

    const headers = { ...req.headers };
    delete headers["x-trent-proxy-token"];
    headers.host = targetUrl.host;

    // Inject real authorization if token resolved
    if (resolvedCredentials.apiKey) {
      headers["authorization"] = `Bearer ${resolvedCredentials.apiKey}`;
    }

    const transport = targetUrl.protocol === "http:" ? http : https;

    const proxyReq = transport.request(
      targetUrl,
      {
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upstream error", message: err.message }));
    });

    req.pipe(proxyReq);
  }
}
