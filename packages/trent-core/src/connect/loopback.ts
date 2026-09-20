/**
 * The loopback redirect listener (RFC 8252 section 7.3): one HTTP server on 127.0.0.1, bound to
 * a random port unless the provider needs a registered one, that waits for exactly one
 * `GET /callback` and settles a promise with the authorization code.
 *
 * Three refusals happen here, before any code reaches the token endpoint: a `state` that is
 * not the one this flow sent (a request from somewhere other than the browser tab we opened),
 * an `error` from the provider, and a callback with no code. The page the browser is shown is
 * a fixed string with nothing from the query interpolated into it, so the code, the state and
 * whatever an attacker put in `error_description` never render anywhere.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { EXIT, TrentError } from "../errors/index.js";
import { LOOPBACK_CALLBACK_PATH } from "./providers.js";

export interface LoopbackListener {
  readonly port: number;
  readonly redirectUri: string;
  /** Resolves with the code of the first callback that carries `expectedState`. */
  waitForCode(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

export interface LoopbackOptions {
  readonly providerName: string;
  readonly redirectHost: "127.0.0.1" | "localhost";
  /** 0 picks a free port. */
  readonly port: number;
  readonly expectedState: string;
}

const ERROR_CODE = /^[a-z_]{1,40}$/;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${body}</p></body></html>`;
}

/** `connection: close` so the socket ends once the page is flushed and `close()` returns promptly. */
function headers(contentType: string): Record<string, string> {
  return { "content-type": contentType, connection: "close" };
}

export async function startLoopback(options: LoopbackOptions): Promise<LoopbackListener> {
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  const outcome = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  let settled = false;
  const finish = (result: { code: string } | { error: TrentError }): void => {
    if (settled || settle === undefined) return;
    settled = true;
    if ("code" in result) settle.resolve(result.code);
    else settle.reject(result.error);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== LOOPBACK_CALLBACK_PATH || settled) {
      res.writeHead(404, headers("text/plain; charset=utf-8")).end("not found");
      return;
    }
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");
    const code = url.searchParams.get("code");

    if (state !== options.expectedState) {
      res.writeHead(400, headers("text/html; charset=utf-8")).end(page("Trent: refused", "This callback did not carry the state Trent sent, so it was refused. Run trent connect again."));
      finish({ error: new TrentError({ code: EXIT.AUTH, operation: "connect.callback", message: "the callback did not carry the state this flow sent; refused", target: options.providerName }) });
      return;
    }
    if (providerError !== null) {
      const known = ERROR_CODE.test(providerError) ? providerError : "unknown_error";
      res.writeHead(400, headers("text/html; charset=utf-8")).end(page("Trent: not connected", "The provider refused the authorization. You can close this tab."));
      finish({ error: new TrentError({ code: EXIT.AUTH, operation: "connect.callback", message: `the provider refused the authorization (${known})`, target: options.providerName }) });
      return;
    }
    if (code === null || code === "") {
      res.writeHead(400, headers("text/html; charset=utf-8")).end(page("Trent: not connected", "The callback carried no authorization code. Run trent connect again."));
      finish({ error: new TrentError({ code: EXIT.AUTH, operation: "connect.callback", message: "the callback carried no authorization code", target: options.providerName }) });
      return;
    }
    res.writeHead(200, headers("text/html; charset=utf-8")).end(page("Trent: connected", `Trent received the authorization for ${options.providerName}. You can close this tab.`));
    finish({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    redirectUri: `http://${options.redirectHost}:${port}${LOOPBACK_CALLBACK_PATH}`,
    waitForCode(timeoutMs: number): Promise<string> {
      const timer = setTimeout(() => {
        finish({
          error: new TrentError({
            code: EXIT.AUTH,
            operation: "connect.callback",
            message: `no callback reached the loopback listener within ${Math.round(timeoutMs / 1000)}s`,
            target: options.providerName,
          }),
        });
      }, timeoutMs);
      timer.unref();
      return outcome.finally(() => clearTimeout(timer));
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        // A tab that ignored `connection: close` must not hold the process; a second is plenty.
        const force = setTimeout(() => server.closeAllConnections(), 1000);
        force.unref();
        server.closeIdleConnections();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
      });
    },
  };
}
