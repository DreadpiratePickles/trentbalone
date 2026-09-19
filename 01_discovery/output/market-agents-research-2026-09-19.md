# Market agents research: what three Trent agents must do, and which real tools and APIs do it

Date: 2026-09-19. Author: research agent (Opus). Scope: primary sources only (official docs, pricing pages, published surveys). Every claim carries a URL. Where a page could not be fetched directly, the row says so and the claim is downgraded to "unverified".

Conventions:
- APPROVAL = human approval gate required before the action runs (money moves, content publishes, or a customer is contacted). The rulebook requires these gates.
- "Week one" = works with self-serve credentials only; no platform app review, audit, or business verification.
- Prices are USD from the vendor page on 2026-09-19 unless noted.

## 0. Demand evidence (surveys, not opinion)

| Finding | Source |
|---|---|
| U.S. Census BTOS (Dec 2025 - May 2026): 17-20% of all firms currently use AI in producing goods or services; firms under 20 employees are under 20%; 250+ employees 37%. | https://www.census.gov/library/stories/2026/05/ai-use-businesses.html |
| U.S. Chamber "Empowering Small Business" 4th edition (published 2025-08-18): 58% of small businesses say they use generative AI, up from 40% in 2024. Methodology not on the page. | https://www.uschamber.com/technology/artificial-intelligence/u-s-chambers-latest-empowering-small-business-report-shows-majority-of-businesses-in-all-50-states-are-embracing-ai |
| Adobe Creators' Toolkit Report (May 2026, 16,000+ creators, 8 countries): 87% of creators using creative AI say it accelerated growth; 93% say it makes them faster; 57% say outputs need moderate or extensive editing; 85% say the final decision must stay with the creator. | https://news.adobe.com/news/2026/06/creators-toolkit-report-2026 |
| Kit "State of AI in the Creator Economy" (April 2026, n=550): 57.3% use AI daily; top tasks are writing/editing and brainstorming (82.7%), research (72.8%), image creation (46.9%); 89.2% always review and edit AI output. | https://kit.com/resources/blog/ai-creator-economy-report |

Read-across for Trent: the gap between "uses gen AI" (58%) and "uses AI in production" (under 20% for small firms) is the market. Both creator surveys say the human edits before publishing, which matches the rulebook's approval gates rather than fighting them.

## 1. Agent A: small-business assistant (mom-and-pop, construction/home services, beauty/spa)

### 1.1 Ten jobs in priority order

| # | Job | Why this rank (source) | Tool / API | Access requirement | Unit price | APPROVAL |
|---|---|---|---|---|---|---|
| 1 | Answer inbound SMS and missed calls; capture lead, reply within minutes | Twilio prices SMS and voice per unit and requires A2P 10DLC registration before US SMS; this is the front door for every trade and spa. https://www.twilio.com/en-us/sms/pricing/us | Twilio Programmable Messaging + Voice | Twilio account; US A2P 10DLC brand + campaign registration (help article not reachable, see Section 5) | SMS $0.0083/segment out and in; MMS $0.022 out; local number $1.15/mo; voice inbound $0.0085/min, outbound $0.014/min; recording $0.0025/min; transcription $0.05/min. https://www.twilio.com/en-us/voice/pricing/us | Yes for any outbound customer message |
| 2 | Book, reschedule, cancel appointments on the owner's calendar | Google Calendar API is free with 600 req/min/user and 1M req/day/project; overage billing "later in 2026". https://developers.google.com/workspace/calendar/api/guides/quota | Google Calendar API | Google Cloud project + OAuth consent; no review for internal/test use | $0 | Yes when it changes a customer's booking |
| 3 | Salon/spa bookings inside the POS the shop already uses | Square Bookings API exposes create/update/cancel and availability search. https://developer.squareup.com/reference/square/bookings-api | Square Bookings API | OAuth scopes APPOINTMENTS_READ/WRITE, APPOINTMENTS_ALL_READ/WRITE, APPOINTMENTS_BUSINESS_SETTINGS_READ. https://developer.squareup.com/docs/oauth-api/square-permissions | Square Appointments: Free $0, Plus $49/mo/location, Premium $149/mo/location; in-person processing 2.5% + 15c on Plus, 2.4% + 15c on Premium. https://squareup.com/us/en/appointments/pricing | Yes |
| 4 | Send invoices and collect payment | Stripe Invoicing Starter 0.4% per paid invoice, Plus 0.5% (adds quotes). https://stripe.com/invoicing/pricing | Stripe Invoices + Payment Links; or Square Invoices API | Stripe account (no review); Square scopes INVOICES_WRITE + ORDERS_WRITE, PublishInvoice needs CUSTOMERS_READ + PAYMENTS_WRITE. https://developer.squareup.com/docs/invoices-api/overview | Stripe: card rate 2.9% + $0.30 (US page redirected to Canada; CA figure is 2.9% + CA$0.30 https://stripe.com/pricing); Payment Links "included with Payments" | Yes (money) |
| 5 | Draft quotes and estimates for jobs | Stripe Invoicing Plus includes quotes (above). Jobber GraphQL exposes Quotes, Jobs, Invoices, Clients, Requests, Visits. https://developer.getjobber.com/docs/ (403 on fetch; objects confirmed via Jobber help center https://help.getjobber.com/hc/en-us/articles/25924078048151-Developer-Center) | Stripe Quotes; Jobber API for Jobber shops | Jobber: Developer Center account; custom (unpublished) integration for one client needs no App Store approval; published apps need approval + 2FA | Jobber API $0 (pricing not stated) | Yes (customer-facing) |
| 6 | Request reviews after the job and reply to Google reviews | GBP API lists reviews and updateReply. https://developers.google.com/my-business/content/review-data | Google Business Profile API | Basic API Access application; profile must be verified 60+ days with a website; approved when quota shows 300 QPM. https://developers.google.com/my-business/content/prereqs | $0 | Yes for reply text and for the review-request SMS |
| 7 | Customer follow-ups (no-show, reactivation, post-job) | Same Twilio unit prices as job 1 | Twilio SMS; email via any SMTP | 10DLC campaign approved for the use case | $0.0083/segment | Yes |
| 8 | Sync money to the books | QuickBooks Online: all apps connected to production companies must pass the App Assessment Questionnaire to get production keys, even if unlisted. https://help.developer.intuit.com/s/article/New-app-assessment-process-FAQ | QuickBooks Online API | Questionnaire + production keys | $0 API | No (read-mostly) |
| 9 | Simple social posts (offers, before/after photos) | Facebook Page posts need pages_manage_posts, pages_read_engagement, pages_manage_engagement, pages_read_user_engagement (publish_video for video); scheduled posts 10 min to 30 days out. https://developers.facebook.com/docs/pages-api/posts | Meta Graph API (Page) or an aggregator (Section 2) | Meta App Review unless every poster has a role on the app | $0 | Yes (publishing) |
| 10 | Home-services CRM sync for Housecall Pro shops | API only on Max plan ($299/mo, 8 users). https://www.housecallpro.com/pricing/ and https://help.housecallpro.com/en/articles/8505035-api-overview | Housecall Pro Public API (API key; OAuth only for official partners) | Customer must be on Max | $0 API | Yes for customer-facing writes |

### 1.2 Vertical booking platforms: open or closed

| Platform | Status | Source |
|---|---|---|
| Square Appointments | Open API, self-serve OAuth | https://developer.squareup.com/reference/square/bookings-api |
| Jobber | Open GraphQL API; custom integration flow for single clients | https://help.getjobber.com/hc/en-us/articles/25924078048151-Developer-Center |
| Housecall Pro | Open REST API, but only Max-plan customers can issue keys | https://help.housecallpro.com/en/articles/8505035-api-overview |
| Vagaro | Enterprise Business API v2 + webhooks; request from Settings > Developers; requires paid plan with card processing; $10/mo incl. 5,000 webhook calls (help article returned 403; figures from search snippet of support.vagaro.com, unverified) | https://docs.vagaro.com/public/reference/api-introduction |
| Boulevard | Client API and Admin API via developer portal; portal page returned no content; third-party summaries say Enterprise tier (unverified) | https://developers.joinblvd.com/ |
| Fresha | developers.fresha.com did not resolve; no public merchant API found. Treat as closed. | (not reached) |

### 1.3 Week one versus needs review

Week one (no review): Twilio SMS/voice (after 10DLC registration, which is a registration not an app review), Google Calendar, Stripe Invoices/Payment Links/Quotes, Square Bookings + Invoices via OAuth, Jobber custom integration, Housecall Pro API key (Max plan).

Needs review: Google Business Profile API (Basic Access application; approval visible as 300 QPM), QuickBooks production keys (App Assessment Questionnaire), Meta Page posting for accounts without an app role (App Review; submission guide says review completes "within a week" and requires screencasts, privacy policy, and at least one successful API call per permission within 30 days. https://developers.facebook.com/docs/app-review/submission-guide).

## 2. Agent B: social-media manager

### 2.1 Platform API constraints as of 2026

| Platform | Posting | Comments / DMs | Insights | Limits | Review / access | Source |
|---|---|---|---|---|---|---|
| Instagram (Graph) | Images (JPEG), video/Reels, Stories, carousels up to 10; AI-generated content disclosure field | Reply, hide, delete comments (instagram_business_manage_comments); DMs via Messaging API (instagram_business_manage_messages), 24-hour window only, no message tags on Instagram | reach, views, likes, comments, shares, saves, follower demographics (instagram_business_manage_insights) | 100 API-published posts per 24 h per account | Professional account; App Review for users without app roles | https://developers.facebook.com/docs/instagram-platform/content-publishing ; https://developers.facebook.com/docs/instagram-platform/comment-moderation ; https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights ; https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy |
| Facebook Page | Text/link, photo, video, scheduled 10 min to 30 days | Messenger: 24 h window, HUMAN_AGENT tag 7 days, bots must self-disclose | Page insights (not fetched) | Not stated on the posts page | App Review + Business Verification for advanced access | https://developers.facebook.com/docs/pages-api/posts ; https://developers.facebook.com/docs/development/release/business-verification |
| Threads | Text (500 chars), image, video, carousel 2-20 | (not fetched) | (not fetched) | 250 posts per 24 h | Meta app | https://developers.facebook.com/docs/threads/posts |
| TikTok | Direct post (FILE_UPLOAD or PULL_FROM_URL from verified domain) and photo posts; scope video.publish | Not in Content Posting API | Not in Content Posting API | 6 requests/min per user token; daily per-creator cap; unaudited: max 5 posting users per 24 h and all posts SELF_ONLY | Audit required for public posts; strict UX rules (creator nickname, privacy selector with no default, commercial-content disclosure) | https://developers.tiktok.com/doc/content-posting-api-get-started/ ; https://developers.tiktok.com/doc/content-sharing-guidelines/ ; https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/ |
| YouTube | videos.insert costs 1 unit in a separate 100-calls/day upload bucket; 10,000 units/day for everything else; 256 GB max; no Shorts-specific endpoint (a Short is a vertical upload) | comments.list 1 unit | 1-unit list calls | Unverified projects created after 2020-07-28 upload private-only until audited | Audit and Quota Extension form; "as soon as possible", no SLA | https://developers.google.com/youtube/v3/determine_quota_cost ; https://developers.google.com/youtube/v3/docs/videos/insert ; https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits |
| X | Pay-per-usage credits now default; legacy Free 500 posts/mo; Basic $200/mo (10,000 posts/mo); Pro $5,000/mo; legacy Basic plans migrating to PPU | Reads billed per request | Per request | Per tier | Self-serve; enterprise by application | https://docs.x.com/x-api/getting-started/about-x-api ; https://docs.x.com/x-api/getting-started/pricing ; https://devcommunity.x.com/t/important-update-legacy-x-api-basic-plans-are-moving-to-pay-per-use-ppu/266305 |
| LinkedIn | Posts API (text, image, video, document, article, multi-image, poll); w_organization_social for Pages, w_member_social for members | Comment/like under same scopes; r_member_social restricted to approved users | Not in Posts API | 429 on rate limit; no numbers on page | Community Management API product access; versioned header required | https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api |
| Pinterest | Pins create via v5 | n/a | n/a | Trial: pins visible only to creator (sandbox); Standard: per-minute per-user limits | Standard access needs approved Trial, OAuth screencast, privacy policy; "a few days" review | https://developers.pinterest.com/docs/key-concepts/access-tiers/ |
| Bluesky | AT Protocol, no review, no fee | Same | Public API "generous" limits, no auth | 5,000 points/h and 35,000/day per account; create = 3 points (about 1,666 creates/h); 50 MB blobs; 3,000 requests per 5 min per IP | None | https://bsky.network/docs/rate-limits/ |

### 2.2 Aggregators with public APIs (buy the reviews instead of doing them)

| Vendor | API | Price | Source |
|---|---|---|---|
| Ayrshare | Full posting/analytics/comments API, 14+ networks; one customer's set of accounts = one profile | Premium $149/mo (1 profile); Launch $299/mo (10 profiles); Business $599/mo (30 profiles, scales to $1.99/profile/yr at 500+) | https://www.ayrshare.com/pricing/ |
| Buffer | Public API included on all plans | Free 3 channels, 3,000 req/mo; Essentials $5/channel/mo, 7,500 req/mo; Team $10/channel/mo, 15,000 req/mo | https://buffer.com/pricing |
| Publer | REST API only for Business and Enterprise | Business from $10/mo per social account (plans page not fetched; API eligibility page fetched) | https://publer.com/help/en/article/does-publer-have-a-public-api-194nknf/ |
| Hootsuite | API not mentioned on plans page | Standard $99/user/mo (10 accounts), Professional $199, Advanced $399, annual billing | https://www.hootsuite.com/plans |
| Later | No public API found (secondary sources only; not verified on later.com) | n/a | (not reached) |

### 2.3 Ten jobs in priority order

| # | Job | Tool / API | Access | Unit price | APPROVAL |
|---|---|---|---|---|---|
| 1 | Content calendar (plan, slot, track status) | Trent-internal store; no platform API | none | $0 | No |
| 2 | Draft posts in brand voice | LLM (Gemini Flash $0.75 in / $3.75 out per 1M tokens through 2026-12-31; GPT-4.1-mini $0.40 / $1.60) | API key | under $0.01 per post | No (draft only) |
| 3 | Publish to Instagram + Facebook | Graph API (Section 2.1) or Ayrshare/Buffer | Meta App Review, or aggregator plan | $0 direct; $5/channel/mo Buffer | Yes |
| 4 | Publish to Bluesky, Threads, LinkedIn Page | AT Protocol; Threads API; LinkedIn Posts API | Bluesky none; Threads Meta app; LinkedIn CM API | $0 | Yes |
| 5 | Publish to TikTok and YouTube Shorts | TikTok Content Posting (audited) ; YouTube videos.insert | TikTok audit; YouTube audit for public uploads | $0; YouTube 1 upload unit of 100/day | Yes |
| 6 | Reply to comments | Instagram comment moderation; LinkedIn social actions | instagram_business_manage_comments | $0 | Yes |
| 7 | Reply to DMs within 24 h | Instagram Messaging API / Messenger | instagram_business_manage_messages; bots must self-disclose | $0 | Yes |
| 8 | Weekly analytics report | IG insights; YouTube 1-unit list calls; Bluesky public API | insights scopes | $0 | No |
| 9 | Image generation for posts | Gemini 3.1 Flash Image about $0.045-$0.067 per image; Gemini Flash Lite Image about $0.034; gpt-image-2 $30 per 1M output tokens; FLUX Kontext Pro $0.04, FLUX.2 Pro $0.03/MP (search snippet, bfl.ai page not fully fetched); Stability Core 3 credits = $0.03 (search snippet) | API keys | as listed | No (but see AI-label risk) |
| 10 | Ads basics (boost a post, read spend) | Meta Marketing API Standard access is automatic for business apps; Advanced needs App Review plus 500 calls in 15 days with under 15% errors, Business Verification for sensitive data | https://developers.facebook.com/docs/marketing-api/overview/authorization | $0 API; ad spend | Yes (money) |

Sources for prices: https://ai.google.dev/gemini-api/docs/pricing ; https://developers.openai.com/api/docs/pricing ; https://bfl.ai/pricing ; https://platform.stability.ai/pricing

### 2.4 Week one versus needs review

Week one: Bluesky (nothing to apply for), Buffer API (Free plan, 3 channels) or Ayrshare (28-day trial on Launch) for every other network, IG/FB posting for accounts that hold a role on Trent's own Meta app, analytics reads, drafting, calendar.

Needs review: Meta App Review + Business Verification ("within a week" per submission guide) for third-party IG/FB/Threads accounts; TikTok audit (no timeline published; unaudited = private-only, 5 users/day); YouTube audit (no SLA; unaudited = private uploads); Pinterest Standard ("a few days"); LinkedIn Community Management API product access (timeline not published); X paid credits.

## 3. Agent C: creator agent (long-form to shorts)

### 3.1 What the incumbents automate and charge

| Product | Automates | Price | Source |
|---|---|---|---|
| OpusClip | AI clipping (spoken words free; visual/sound/emotion on Starter+), captions, B-roll, dubbing, 9:16/1:1/16:9, social posting to Shorts/TikTok/IG, Video Editing + Scheduler APIs on Pro | Free $0 (watermarked), Starter $15/mo, Pro $29/mo, Business custom | https://www.opus.pro/pricing |
| Descript | Transcription, text-based editing, Underlord AI, captions, dubbing (Business) | Free 60 min/mo; Hobbyist $16/mo (10 h); Creator $24/mo (30 h); Business $50/mo (40 h) | https://www.descript.com/pricing |
| Vizard | Credit-based clipping, 1 credit = 1 minute; 4K, no watermark on paid | Free 60 credits/mo; paid tiers 600-7,200+ credits (dollar amounts did not render on fetch) | https://vizard.ai/pricing |
| CapCut | Auto captions, templates; Pro price varies by region and device, not published as one number | regional | https://www.capcut.com/help/how-much-does-capcut-pro-cost |

### 3.2 Open-source pipeline (what Trent can run itself)

| Step | Tool | License / cost | Source |
|---|---|---|---|
| Decode, cut, crop 9:16, burn subtitles, encode | FFmpeg | LGPL 2.1+ (GPL if GPL parts enabled); patent caveats for MPEG codecs | https://ffmpeg.org/legal.html |
| Transcribe with word timestamps | whisper.cpp (MIT; Core ML on Apple Silicon, CUDA; -ml 1 word timestamps) or faster-whisper (MIT; up to 4x faster than openai/whisper; word_timestamps=True; Silero VAD; CUDA 12 + cuDNN 9) | $0 | https://github.com/ggml-org/whisper.cpp ; https://github.com/SYSTRAN/faster-whisper |
| Hosted transcription fallback | OpenAI whisper $0.006/min, gpt-4o-mini-transcribe $0.003/min; Gemini 3.5 Transcribe $0.003/min audio in | per minute | https://developers.openai.com/api/docs/pricing ; https://ai.google.dev/gemini-api/docs/pricing |
| Scene / cut detection | PySceneDetect (BSD-3; AdaptiveDetector; split_video_ffmpeg) | $0 | https://www.scenedetect.com/ |
| Face tracking for auto-reframe | MediaPipe Face Detector (Apache 2.0 code; bounding boxes + 6 landmarks; VIDEO mode; about 3 ms/frame CPU) | $0 | https://developers.google.com/edge/mediapipe/solutions/vision/face_detector |
| Thumbnails | Gemini Flash Image about $0.045-$0.067; gpt-image-2; FLUX Kontext Pro $0.04 | per image | Section 2.3 row 9 |
| Hooks, titles, descriptions | Gemini Flash / GPT-4.1-mini | under $0.01 per video | Section 2.3 row 2 |

### 3.3 Ten jobs in priority order

| # | Job | Tool | Access | Unit price | APPROVAL |
|---|---|---|---|---|---|
| 1 | Transcribe the long-form with word timestamps | faster-whisper or whisper.cpp locally; hosted fallback $0.003-0.006/min | none | $0 local; $0.18-0.36 per hour hosted | No |
| 2 | Pick 5-10 clip candidates (hook density, topic shifts) | LLM over transcript + PySceneDetect cut points | API key | under $0.05 per hour of source | No |
| 3 | Cut and reframe to 9:16 with face tracking | FFmpeg + MediaPipe | none | $0 | No |
| 4 | Burn word-timed captions | FFmpeg subtitles/ass filter from transcript | none | $0 | No |
| 5 | Write hook, title, description, hashtags per clip | LLM | API key | under $0.01 | No (draft) |
| 6 | Generate thumbnail options | Gemini Flash Image / FLUX Kontext | API key | $0.04-0.07 | No |
| 7 | Publish Shorts | YouTube videos.insert (100/day bucket) | audit for public uploads; ToS 9.1.1 upload-certification notice must be shown | $0 | Yes |
| 8 | Publish to TikTok / Reels / Threads / Bluesky | Section 2.1 | TikTok audit; Meta App Review; Bluesky none | $0 | Yes |
| 9 | Schedule across platforms | Buffer API or Ayrshare | plan | $5/channel/mo or $149/mo | Yes at publish time |
| 10 | Report clip performance | YouTube list calls (1 unit), IG insights | scopes | $0 | No |

### 3.4 Week one versus needs review

Week one: jobs 1-6 run entirely on open-source plus LLM keys, Bluesky publishing, YouTube private uploads (unaudited), Buffer Free (3 channels).

Needs review: YouTube audit for public uploads and quota beyond 100 uploads/day; TikTok audit; Meta App Review for other people's IG accounts.

## 4. Risks

| Risk | Detail | Source |
|---|---|---|
| Unaudited posting is invisible | TikTok unaudited = SELF_ONLY and max 5 users/day; YouTube unverified projects (post-2020-07-28) upload private-only; Pinterest Trial pins are sandbox-only. Trent must show users "private until audit" honestly. | Section 2.1 |
| AI-content labels | YouTube requires an "AI use" disclosure for realistic altered or synthetic content; repeated non-disclosure can mean removal or YPP suspension; script/thumbnail generation does not require disclosure. Instagram publishing API exposes an AI-generated disclosure field. Meta applies "AI info" labels from self-disclosure and industry indicators. TikTok reads C2PA Content Credentials to auto-label (newsroom post). | https://support.google.com/youtube/answer/14328491 ; https://developers.facebook.com/docs/instagram-platform/content-publishing ; https://transparency.meta.com/governance/tracking-impact/labeling-ai-content/ ; https://newsroom.tiktok.com/en-us/partnering-with-our-industry-to-advance-ai-transparency-and-literacy |
| Bot disclosure in DMs | Messenger policy: automated experiences must disclose they are not human; Instagram Messaging has only the 24-hour window and no tags; HUMAN_AGENT is for humans only. An agent replying to DMs must identify itself and hand off. | https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy |
| Rate limits | IG 100 posts/24 h; Threads 250/24 h; TikTok 6 req/min per token; YouTube 100 uploads/day and 10,000 units/day; Bluesky 5,000 points/h; Calendar 600 req/min/user; GBP 300 QPM. | Sections 1-2 |
| Cost traps | X Basic $200/mo and legacy plans forced onto pay-per-use; Hootsuite $99/user/mo; Ayrshare $149/mo minimum; Twilio 10DLC fees (brand $46 one-time, campaign vetting $15, monthly campaign fee by type per search snippet; help page returned 403 so unverified); Housecall Pro API locked to $299/mo Max; Google Calendar overage billing planned "later in 2026"; Gemini Flash prices double on 2027-01-01. | https://docs.x.com/x-api/getting-started/pricing ; https://help.twilio.com/articles/1260803965530-What-pricing-and-fees-are-associated-with-the-A2P-10DLC-service- ; https://ai.google.dev/gemini-api/docs/pricing |
| Review dependencies | Meta: App Review "within a week" plus Business Verification for advanced access; QuickBooks: questionnaire before production keys even for unlisted apps; GBP: 60-day-old verified profile before applying. | Sections 1.3, 2.4 |
| FFmpeg licensing | Ship LGPL build, dynamic link, no GPL components, attribution; codec patents are a separate exposure. | https://ffmpeg.org/legal.html |

## 5. Recommendation: build order, per unit

Agent A (assistant): build Twilio SMS/voice first ($0.0083 per SMS, $0.0085-0.014 per voice minute, $1.15 per number per month) because every vertical needs the front door and it needs registration, not review. Second: Google Calendar ($0). Third: Stripe Invoices + Payment Links (0.4% per paid invoice on top of card rate) because it needs no review and covers trades and spas alike. Fourth: Square Bookings + Invoices via OAuth for shops already on Square ($0 API). Apply for Google Business Profile Basic Access on day one so review-reply is ready when the 60-day clock and approval land. Defer QuickBooks and Housecall Pro until a paying customer is on those plans.

Agent B (social manager): build the calendar and drafting core ($0.01 per post in LLM tokens), then Bluesky direct ($0, no review), then Buffer API ($5 per channel per month) as the week-one publisher for IG/FB/LinkedIn/Threads/TikTok/YouTube/Pinterest. Submit Meta App Review in week one in parallel; switch IG/FB to direct Graph API when approved to get comments, DMs, and insights, which Buffer does not replace. Treat TikTok audit and YouTube audit as month-two items. Skip X until a customer asks and pays the credit cost.

Agent C (creator): build the local pipeline first at $0 per clip (faster-whisper, PySceneDetect, MediaPipe, FFmpeg), with hosted transcription as a fallback at $0.003-0.006 per minute and thumbnails at about $0.04-0.07 each. Publish to Bluesky and to YouTube as private drafts in week one; apply for the YouTube audit immediately since public Shorts are the point. Route TikTok/Reels through Buffer until the direct audits clear.

Sources not reached directly (claims marked unverified above): Twilio 10DLC fee help article (403), Vagaro webhook article (403), Boulevard developer portal (empty page), Fresha developers site (DNS), Jobber docs root (403; help center used instead), Later API status (secondary only), Stripe US pricing page (redirected to Canada), Square Appointments and Invoices pages (prices via squareup.com search snippet), bfl.ai and Stability per-image prices (search snippets of vendor pages), CapCut Pro fixed price (regional), Publer plans page (redirect loop).
