# The `social` toolset

Six tools for the social-media manager, built over what the application's own adapter really
does (`apps/web/lib/social/live-platform-adapter.ts`, read-only) plus Bluesky directly and
Buffer as the publisher for every platform that needs a review this install has not passed.
Implemented in `packages/trent-core/src/tools/social/` and proved by `tools/social/social.test.ts`,
`tools/social/queue.test.ts` and `doctor/checks/social.test.ts`, every one of them against a fake
platform server on the loopback (`tools/social/testing/fake-platforms.ts`): the standard tests
call no platform, and every host the adapter hard-codes is rewritten to that server.

| Tool | Arguments | What it does |
|---|---|---|
| `social_platforms_list` | none | Every platform with what is connected, the route a post would take, what the direct path can do, the review it needs and its caveats. Read-only |
| `social_post` | `platform`, `text`, `media_url`, `account_id` | Publishes now: Meta Graph for Facebook and Instagram, the AT Protocol for Bluesky, Buffer for the rest. Asks a human at every autonomy level, bound to exactly that platform, text and media URL; sends once |
| `social_reply` | `platform`, `thread_id`, `text`, `account_id` | Replies to a Facebook or Instagram comment, a YouTube comment or a Bluesky post. Never a DM. Asks at every level; asks again, naming the read, in a step that read the inbox |
| `social_inbox_list` | `platform`, `account_id`, `limit` | Instagram comments, Facebook messages (read-only), YouTube comment threads, Bluesky mentions and replies. Returned `untrusted` |
| `social_insights_read` | `platform`, `post_id`, `account_id` | A post's impressions, engagements and video views (Meta, YouTube), or its like, repost, reply and quote counts (Bluesky). Read-only |
| `social_schedule` | `platform`, `text`, `media_url`, `account_id`, `at` | The post queue: approved now, bound to the exact content and time, published once when `trent cron` ticks past `at` |

The read tools carry `_list` and `_read` in their names on purpose: the policy classifier falls back
to the adapter's scope list when a tool name yields no class, and that list holds `social_post`, so an
un-tokened read would inherit `external_send` and ask at every level (docs/security.md, "Reads should
be named").

## The honest matrix

What the CLI can do per platform today. "Direct" is the application's adapter or the AT Protocol
client with a token from `trent connect`; "Buffer" is Buffer's API with a channel the founder has
connected inside Buffer. Nothing here is promised away: a limit is told to the user in
`social_platforms_list`, in the approval preview and in the tool result.

| Platform | Token source | Post | Reply | Inbox | Insights | Review or access needed | Limits the user is told |
|---|---|---|---|---|---|---|---|
| Facebook Page | `trent connect meta` | direct (Graph `/feed`), or Buffer | direct (comments) | direct (messages, read-only) | direct | Meta App Review and Business Verification for accounts outside your app | Messenger DMs are not sent; `account_id` is the Page id |
| Instagram | `trent connect meta` | direct (container then publish), or Buffer | direct (comments) | direct (comments) | direct | Meta App Review and Business Verification | needs a publicly hosted image or video URL, refused as `instagram_media_url_required` without one; the AI-generated field is not set by the adapter; 100 API posts per day |
| X | none in `trent connect` | Buffer | no path | no path | no path | X pay-per-use credits or 200 dollars per month on Basic for the direct API | the adapter supports X, but no provider here holds its token |
| LinkedIn | none in `trent connect` | Buffer | no path | no path | no path | Community Management API product access for the direct API | as X |
| TikTok | none in `trent connect` | Buffer | none in TikTok's API | none in TikTok's API | no path | TikTok audit for public posts on the direct API | the direct adapter posts `SELF_ONLY` (private) until the audit; without Buffer the post is refused and says so |
| YouTube | `trent connect google` | no publish path in the adapter (YouTube Studio or Buffer) | direct (comments) | direct (comment threads) | direct (statistics) | YouTube API audit for public uploads | the altered or synthetic content (AI use) disclosure is not set by anything here; unaudited projects upload private-only |
| Threads | none wired | Buffer | no path | no path | no path | a Meta app for the direct API | no direct path in the adapter |
| Bluesky | `trent connect bluesky` (app password) | direct (`createRecord`) | direct (`getRecord` then `createRecord` with the reply refs) | direct (`listNotifications`) | direct (`getPosts` counts) | none | 300 graphemes per post; images are not attached on this path |

DMs are excluded by name on every platform: the adapter's `sendDm` throws, and a Messenger bot
would have to disclose itself. Reading Facebook messages in the inbox is fine; replying to one is not.

`account_id` on the direct Meta and YouTube paths is the id the platform knows: the Facebook Page
id and the Instagram business account id (Meta Business Suite, Settings, Accounts; or
`GET /me/accounts` on the Graph API), the YouTube channel id (YouTube Studio, Settings, Channel,
Advanced). `trent connect` stores the token, not the account, so the tool asks for it.

**Direct Meta and YouTube paths need the app store.** The app's social adapter reads its integration rows through the app store, which works only with a Postgres `DATABASE_URL`; on a standalone profile the tool reports Buffer or Bluesky as the routes and says why (`social_platforms_list`).

## The gate, per call

Every write calls `requireBoundApproval` inside `execute` with the exact platform, text, media URL
and time as the preview (`governance/bound-approvals.ts`, docs/security.md "Side-effecting tools:
the gate") under the classes `external_send` and `customer_facing`, and the wrapper chain performs
the same check outside it, so a post runs only against an approval bound to that call: at
`autonomy: never` it still asks; a yes to one post does not cover the next; a changed argument is a
different approval; the same post twice in a step is answered from the idempotency store and the
platform is hit once. `social_inbox_list` results are tagged `untrusted`, so a reply in the same
step is asked again by the shipped `send-after-untrusted` rule and the reason names the read. A
call that cannot succeed is refused with a typed code before anything leaves: `social_no_route`,
`instagram_media_url_required`, `buffer_media_unsupported`, `social_account_id_required`,
`social_schedule_time_past`.

## The post queue

`social_schedule` writes a one-shot job on the CLI's own job file, `<profile>/cron/jobs.json`
(docs/cron.md), not the application's calendar (its publish check needs a web-only
`autoPublishEnabled` flag). The job carries `handler: social_publish` and the approved call as its
payload, a schedule of that minute, hour, day and month in UTC, and `next_run_at` anchored to the
slot. At tick time `trent cron start` (or `--once`, or `trent cron run <id>`) hands it to the social
publish handler, which re-reads the same approval row, publishes through the idempotent path keyed
on that same call, records the run in the job's history and disables the job. A rerun answers from
the store and sends nothing. No model is in the loop after the approval: the prompt field is a
label. If the row was decided outside a seat turn and is still pending at the slot, the run is
recorded as failed with the approval id; approve it, then `trent cron run <id>`. `trent cron remove
<id>` withdraws a queued post.

## Buffer

Buffer's public API is GraphQL at `https://api.buffer.com` with a bearer access token from
`trent connect buffer` (https://developers.buffer.com/guides/your-first-post): the organization,
the channels with their `service`, and `createPost(text, channelId, schedulingType: automatic,
mode: addToQueue)`. The channel is matched by service (`twitter` or `x` for X). Buffer publishes at
the channel's next slot, and the tool result says so. The media input of `createPost` is not on
Buffer's documented guide pages (the reference page answered 404 on 2026-09-20), so a `media_url` on
this path is refused as `buffer_media_unsupported` rather than dropped. Each channel must be
connected inside Buffer first.

## Spend

Buffer bills per channel per month (free for 3 channels; Essentials 5 dollars per channel per month;
Team 10 dollars), not per post, so the ledger row a Buffer publish records carries
`buffer_cents_per_post`, which defaults to 0 and is set on the adapter options to amortise the plan;
the row lands on `spend.ndjson` as `surface: "tool"`, `provider: "buffer"`, and `trent budget status`
counts it. The direct Meta, Google and Bluesky paths cost nothing per call. X's direct API is
pay-per-use or 200 dollars per month on Basic and is not wired, which is why X goes through Buffer.

## What to apply for, week one

- Meta App Review plus Business Verification, for Facebook and Instagram accounts that do not hold a
  role on your Meta app (publishing, comments, insights permissions).
- TikTok Content Posting API audit, for public posts on the direct path; until then Buffer.
- YouTube API audit and quota extension, for public uploads; replies and insights work now.
- LinkedIn Community Management API access, if a direct path is wanted later; until then Buffer.
- X: a paid tier only if the direct path is wanted; Buffer covers posting.
- Bluesky: nothing; an app password from bsky.app, Settings, App Passwords.

## Configuration and setup

`social` is a `toolsets` value like any other. Blank Slate writes it to `disabled_toolsets`; Quick
setup enables it only when `trent connect meta`, `bluesky` or `buffer` has been run (it reads the
provider names in the profile secrets file, never a value). `trent doctor` prints the Social
Platforms line: which providers are connected, which platforms a post reaches and by which route,
and the review each still needs.
