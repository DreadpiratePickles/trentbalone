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
| `vision` | a configured model provider | `not_available` on every call |

Trent does not download a browser. It looks for `TRENT_BROWSER_PATH`, then `chromium`,
`google-chrome`, `chrome`, `brave-browser` or `microsoft-edge` on PATH, then the standard install
locations (`/Applications/Google Chrome.app/...`, `/usr/bin/chromium`, ...).

## Browser tools

| Tool | Arguments | Does |
|---|---|---|
| `browser_navigate` | `url` | Opens the page; returns a snapshot with `@eN` refs |
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
- `browser_type` into a `type=password` field. The text never reaches the page.

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
egress proxy. The second makes one live model call and needs `GEMINI_API_KEY` or `<repo>/gem.env`.
