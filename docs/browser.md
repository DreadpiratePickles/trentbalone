# Browser and vision toolsets

`browser` drives a headless Chromium with Playwright and `vision` asks the configured model about
an image. Both are Hermes tool names on Trent's transport: every browser request leaves the machine
through the egress proxy, and every image reaches the model through the model gateway.

```yaml
toolsets: [file_ops, terminal, web, browser, vision, code, delegation, cron, skills, plugins]
```

## What you need

| Toolset | Needs | Without it |
|---|---|---|
| `browser` | the egress proxy running, and a Chromium on this machine | skipped with a reason (no proxy); `not_available` with an install hint (no Chromium) |
| `browser` attached | `tools.browser.attach.enabled: true` and your own Chrome started with a debugging port | `attach: true` is refused as `blocked`, and nothing connects |
| `vision` | a configured model provider | `not_available` on every call |

Trent does not download a browser. It looks for `TRENT_BROWSER_PATH`, then `chromium`,
`google-chrome`, `chrome`, `brave-browser` or `microsoft-edge` on PATH, then the standard install
locations (`/Applications/Google Chrome.app/...`, `/usr/bin/chromium`, ...).

## Browser tools

| Tool | Arguments | Does |
|---|---|---|
| `browser_navigate` | `url`, `attach?` | Opens the page; returns a snapshot with `@eN` refs. `attach: true` uses your own Chrome (below) |
| `browser_snapshot` | `full?` | Interactive elements (and the page text with `full: true`) |
| `browser_click` | `ref` | Clicks `@eN` |
| `browser_type` | `ref`, `text` | Clears and fills `@eN`; password fields are refused |
| `browser_scroll` | `direction` | `up` or `down` |
| `browser_back` | | History back |
| `browser_press` | `key` | `Enter`, `Tab`, `Escape`, `ArrowDown`, ... |
| `browser_get_images` | | Image URLs and alt text |
| `browser_console` | `clear?`, `expression?` | Console output; evaluates `expression` in the page |
| `browser_screenshot` | `full_page?` | Saves a PNG and returns its path |
| `browser_get_text` | | Visible page text |
| `browser_vision` | `question`, `annotate?` | Screenshot plus a vision answer, with `screenshot_path` |

Output over 15,000 characters is truncated and saved whole to `<profile>/cache/spillover/`;
page it with `read_file`. Screenshots land in `<profile>/browser/<run id>/` and are referenced by
path, never inlined.

## What is refused

- Any `browser_navigate` to a non-http(s) scheme, a loopback, private, link-local or
  cloud-metadata address, an internal hostname suffix, or a URL carrying a secret-shaped query.
  This is the same check `web_extract` runs, before the browser is launched.
- Any host outside `egress.intercept_domains`: the proxy refuses the CONNECT and the tool reports
  the failed navigation. Chromium is launched with the proxy as its only route and
  `<-loopback>` in the bypass list, so localhost is not a way around it.
- `browser_type` into a `type=password` field, or one the page marks `autocomplete=current-password`,
  `new-password` or `one-time-code`; and `browser_press` while focus is in such a field. The text
  never reaches the page.

## Attach to your own Chrome

The launched browser above is isolated: a fresh profile, signed in to nothing. To let a seat work
in accounts you are already signed in to, turn on attach and start a Chrome Trent may drive:

```yaml
tools:
  browser:
    attach:
      enabled: true
      cdp_url: http://127.0.0.1:9222   # the default; loopback only
      profile_hint: Trent              # a label for the approval card and the audit, not a selector
```

Start that Chrome yourself, with a debugging port and its **own** profile directory. Chrome 136 and
later ignore `--remote-debugging-port` on the default profile directory, so a separate
`--user-data-dir` is required: sign in once, in that profile, to the accounts Trent should use. It
runs beside your everyday Chrome.

| OS | Command |
|---|---|
| macOS | `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.trent-chrome"` |
| Linux | `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.trent-chrome"` |
| Windows (PowerShell) | `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.trent-chrome"` |

`curl -s http://127.0.0.1:9222/json/version` answering with a JSON object means it is listening.
If a Chrome on that profile directory is already running, the command opens a window in it and the
flag is ignored: quit it first.

A seat then calls `browser_navigate {"url": "https://...", "attach": true}`. It is an argument, not
a new tool, so the toolset keeps its twelve tools; every later `browser_*` call acts on the attached
tab until the run ends or a navigation says `"attach": false`.

- **Which tab.** An empty tab (`about:blank`, the new-tab page) is taken over; otherwise a new tab is
  opened. A tab showing something of yours is never navigated away from. The tab is brought to the
  front before every approved action, so you watch it happen.
- **Every action is approved, one at a time.** `browser_navigate`, `browser_back`, `browser_click`,
  `browser_type`, `browser_press` and `browser_scroll` each wait as a `customer_facing` call bound to
  exactly that call (see [security.md](security.md), "Side-effecting tools: the gate"). The card
  names the site and the action, the element clicked and the text typed, for example
  `click @e7 (button "Send") on https://mail.example.com/compose in your own Chrome (profile: Trent),
  signed in as you`. Decide it with `trent approvals list`, `trent approvals approve <id>` or
  `trent approvals reject <id>`, or on the seat's step card. One yes runs that call once, on that
  page: the same click again asks again, and a click on a different page or element is a different
  approval. Nothing touches your Chrome until the first navigation is approved.
- **Reads are not asked about**: `browser_snapshot`, `browser_get_text`, `browser_screenshot`,
  `browser_get_images`, `browser_vision` and reading `browser_console`. What they return is what you
  are signed in to see, and it goes to the model like any page.
- **Refused, whatever an approval says:** a `cdp_url` that is not 127.0.0.1, `localhost` or `[::1]`;
  a navigation that fails the address floor above; a navigation, or any call while the tab is on a
  host, outside `egress.intercept_domains` (list the sites you mean, e.g. `mail.example.com` or
  `*.example.com`); the password fields above; and `browser_console` with an `expression`, because
  JavaScript in a signed-in page can read its cookies and session tokens.
- **Your settings stay yours.** Trent attaches with Playwright's `noDefaults`, so your Chrome's
  download location and display settings are not overridden while it is attached.
- **Detaching** happens when the run ends. It disconnects and closes nothing: every tab, including
  the one Trent used, stays open.
- **The audit.** `<profile>/browser/attach-audit.ndjson` (mode 0600) holds one hash-chained row per
  attach, per approved action and per detach, in the app's audit-row shape, naming the site (origin
  and path, never the query) and the approval id, never the text typed.

**The egress proxy is not in this path.** The attached Chrome uses your network, your IP address and
your cookies. Its traffic never passes Trent's proxy, so the proxy's CONNECT allowlist, credential
broker and token never see it, and no Trent token is ever sent to it. Trent applies
`egress.intercept_domains` itself instead, as described above.

**What the debugging port exposes.** The DevTools endpoint has no password. While that Chrome runs,
any program on this machine, under any user account, can connect to 127.0.0.1:9222 and do
everything you can do in every account signed in to that profile: read mail and cookies, send,
post and buy. That includes malware and other people on a shared machine. So: keep the profile to
the accounts you want Trent to reach, quit that Chrome when you are done, and never add
`--remote-debugging-address=0.0.0.0`, which would hand the same control to your whole network.
Trent refuses a non-loopback `cdp_url`; it cannot stop another client from connecting.

## Vision

`vision_analyze {"image_path": "<file>", "question": "..."}` or `{"image_url": "https://...",
"question": "..."}`. Local files must be under the workspace or the Trent profile (which is where
browser screenshots are). URLs go through the egress proxy and the same address floor as above.
PNG, JPEG, GIF and WebP up to 20 MB, typed by content, not by extension.

The image is sent as an OpenAI-compatible `image_url` data URI on the provider's chat-completions
path (Gemini, OpenAI, OpenRouter, Mistral) or as an Anthropic `image` block. Nothing is logged.

## Verifying

```
npx vitest run packages/trent-core/src/tools/browser packages/trent-core/src/tools/vision
TRENT_TEST_LIVE=1 npx vitest run packages/trent-core/src/tools/vision/vision.live.test.ts
```

The first runs the unit suites and, when a Chromium is present, a real launch through a real
egress proxy and a real attach: a throwaway headless Chromium on a temporary profile directory,
started with `--remote-debugging-port=0`, standing in for your Chrome (never your real profile). The second makes one live model call and needs `GEMINI_API_KEY` or `<repo>/gem.env`.
