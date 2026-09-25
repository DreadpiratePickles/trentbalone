# P2-12 media on social posts (2026-09-25)

Wave P2 agent (Opus, no subagents, no commits). Scope from the lead: `packages/trent-core/src/tools/social/**`
(adapters, queue, tests, fake server), `docs/social.md`, the pack skills' "owner posts" lines for media
(`packages/trent-core/skills/**`), and this log. Not touched: `tools/media/**` (imported only),
`tools/tool-names.ts`, `fleet/**`, `gateway/**`, `apps/**`, `tools/cron/**`. Gap: parity push log
("posts with media still stop at the owner: Bluesky attaches no image and Buffer refuses a media URL").

## Discovery (18:50, before any code)
- `social_post`/`social_schedule` take `platform`, `text`, `media_url`, `account_id` (+ `at`). Bluesky
  posts text only and appends a note when a `media_url` was given (`publish.ts`); Buffer refuses any
  `media_url` as `buffer_media_unsupported` (`publish.ts` checkPostRequest) because its media input
  "is not on the documented guide pages (the reference page answered 404 on 2026-09-20)" (`buffer.ts`).
- Approvals are keyed on the call's args (`governance/bound-approvals.ts` boundCallKey), not the preview,
  so a file swapped between approval and send would still be granted. The row keeps the first preview.
- `tools/media/paths.ts` `resolveInputPath(workspace, raw)` is the workspace floor (realpath, regular
  file, inside the workspace); imported, not edited.
- Baseline: `npx vitest run packages/trent-core/src/tools/social packages/trent-core/src/tools/cron/queue-edit.test.ts packages/trent-core/src/fleet/pack-skills.test.ts`
  -> exit 0, 5 files, 39 tests (18:55).

### What the public docs say (read 2026-09-25)
Bluesky:
- `app.bsky.embed.images` lexicon (https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json):
  at most 4 images; each `{image: blob, alt: string (required), aspectRatio?}`; blob `accept: image/*`,
  `maxSize: 2000000` ("May be up to 2 MB, formerly limited to 1 MB").
- `app.bsky.embed.video` lexicon (.../lexicons/app/bsky/embed/video.json): one `video` blob,
  `accept: video/mp4`, `maxSize: 300000000` ("May be up to 300mb, formerly limited to 100mb"); `alt`,
  `aspectRatio`, `captions`, `presentation` optional.
- `com.atproto.repo.uploadBlob` (.../lexicons/com/atproto/repo/uploadBlob.json): raw bytes, any encoding,
  auth required, answers `{blob}`; an unreferenced blob is deleted after a time window; restrictions are
  enforced when a record references it.
- Posts guide (https://docs.bsky.app/docs/advanced-guides/posts, source
  https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/posts.md): upload with
  `Content-Type: <mime>` and the bearer JWT, embed as `app.bsky.embed.images`; leave `aspectRatio`
  undefined rather than guess; strip EXIF before upload is "strongly recommended". Its prose still says
  "limited to 1,000,000 bytes" while its own code and the lexicon say 2,000,000: the lexicon wins here.
- Video tutorial (https://docs.bsky.app/docs/tutorials/video, source .../docs/tutorials/video.mdx):
  "Simple method": `uploadBlob` the mp4 to the PDS and embed `app.bsky.embed.video`. Bluesky-hosted
  accounts must have a verified email to upload video, and video posts per day are limited.
Buffer:
- Hosting Media (https://developers.buffer.com/guides/hosting-media.md): "the Buffer API doesn't accept a
  file upload - there's no upload endpoint"; host the file yourself and pass a public, direct, https,
  stable URL in `assets`; Buffer fetches it when the post goes out (hours or days later for a queued post).
- Create Image Post / Create Video Post (https://developers.buffer.com/examples/create-image-post.md,
  .../create-video-post.md): `createPost(input: {..., assets: [{ image: { url } }]})` or `[{ video: { url } }]`.
- Reference (https://developers.buffer.com/reference.md, now 200): `AssetInput` = exactly one of
  `image: ImageAssetInput {url!, thumbnailUrl, metadata: ImageMetadataInput {altText!, ...}}`,
  `video: VideoAssetInput {url!, metadata {thumbnailOffset, title}}` (thumbnailUrl rejected on video),
  `document`.

## Plan
1. Red first, fake servers only: Bluesky blob upload + `app.bsky.embed.images` for 1, 2 and 4 images
   (bytes, MIME from magic bytes, alt, order); alt refusal in the preview; size refusal naming the limit;
   five images refused; video path (`app.bsky.embed.video`); a non-mp4 video refused; Buffer `media_url`
   as an image or video asset; a local file on Buffer refused with "public URL needed"; queue with media
   (paths carried, a missing file at send time refused, a changed file refused); the preview text.
2. `media: [{path, alt}]` on `social_post` and `social_schedule`; files resolved under the workspace
   with `resolveInputPath`, sniffed, hashed (sha256) at preview time; the preview names path, bytes, type,
   digest prefix and alt; the digest is re-checked at send.
3. Buffer takes `media_url` as `assets`; a local file is refused (no upload endpoint).
4. Skills and docs to the new truth.

## Red first (19:05)
Test infra first (test-only): `testing/media-fixtures.ts` (PNG IHDR, JPEG SOF + EXIF orientation, GIF,
WebP VP8X, ISO BMFF with `moov` after `mdat`); `testing/fake-platforms.ts` records the raw body bytes and
answers `uploadBlob` with `{blob: {$type, ref.$link, mimeType, size}}` as the posts guide shows.
New `social-media.test.ts` (16 tests) and `queue-media.test.ts` (4 tests).
`npx vitest run packages/trent-core/src/tools/social/social-media.test.ts packages/trent-core/src/tools/social/queue-media.test.ts`
-> exit 1, 20 failed. Lines that name the defect:
- `one image ...: AssertionError: expected [] to have a length of 1 but got +0` (no uploadBlob: the image is dropped).
- `refuses a local file on the Buffer path ...: expected 'completed' to be 'failed'` (the file is silently dropped on Buffer too).
- `refuses a hosted URL whose extension ...: expected 'buffer_media_unsupported: the Buffer …' to match /buffer_media_kind_unknown/`.
- `a file changed after the human approved it is not sent: expected 'completed' to be 'failed'`.
- `names each file ...: expected 'post to bluesky: "Before and after." …' to contain 'media-out/a.png (1,234 bytes, image/p…'`.

## Requirement change, recorded before the test edit (19:40)
`social.test.ts` "a media URL on the Buffer path is refused with a typed error rather than dropped"
pinned `buffer_media_unsupported`, a refusal made because Buffer's media input was undocumented on
2026-09-20. It is documented now (`assets`, see above), so the requirement becomes: a media URL on the
Buffer path is SENT as an asset, never dropped; a URL whose kind cannot be told is refused
(`buffer_media_kind_unknown`); a local file is refused (`buffer_media_needs_url`). The test is rewritten
to that requirement (same intent: never dropped). `tools/cron/queue-edit.test.ts:105` pins the same old
code and is outside my scope: reported to the lead.

## Green (19:45 to 20:30)
- New `tools/social/media-sniff.ts` (MIME from magic bytes; image size with EXIF orientation; MP4 display
  size from the first video `tkhd`, turned by its matrix, `moov` found wherever it sits) and
  `tools/social/media-files.ts` (`media` parsing with alt required, `resolveInputPath` from `tools/media/paths.ts`,
  the lexicon limits cheapest-first, sha256, the preview line, `readMediaForSend` at send time).
- `bluesky.ts`: `uploadBlob(bytes, mime)` (raw body, the file's MIME as Content-Type) and `createPost(text, {reply, embed})`.
- `buffer.ts`: `bufferAssetOf(url)` by extension and `createPost(..., {asset})` sending `assets: [{ image|video: { url } }]`.
- `publish.ts`: `checkMediaRoute` (files on Bluesky only; `buffer_media_needs_url` citing hosting-media.md;
  `social_media_file_unsupported` on direct; `bluesky_media_url_unsupported`; `buffer_media_kind_unknown`;
  `social_media_conflict`); the Bluesky branch checks the 300-grapheme limit, reads and re-checks every file
  before the login, uploads in order, embeds images or the video.
- `index.ts`: `media` resolved in the preview after the route check; the card names each file; at send each
  file's line must be on the approved card (`social_media_changed`), since approvals are keyed on args.
- `schemas.ts`: `media` (array of `{path, alt}`, both required) on `social_post` and `social_schedule`; `matrix.ts`
  Bluesky caveat. No new tool name (nothing for `tool-names.ts`).
- One more red-first: "a post over 300 graphemes uploads no file" failed with the pre-check removed and passes
  with it (the check moved ahead of the uploads).
- Skills: crosspost-adapt 2.1.0 and local-business-post 2.1.0 (Bluesky `media` examples, Buffer by hosted URL,
  "owner posts" only where no path exists), content-calendar 2.0.1 ("text only" gone), repurpose-plan 1.2.0 and
  clip-plan 1.2.0 (a clip can go to Bluesky as its own approved post; prose only, since the creator pack
  declares only `media`). Mutation check: an undeclared `caption` key in the crosspost `media` example fails
  pack-skills by name; restored.
- docs/social.md: "Media on posts" section, the Bluesky row, the refusal codes, the Buffer media paragraph.

## Verification (final, 20:30)
- `npx vitest run packages/trent-core/src/tools/social` -> exit 0, 5 files, 42 tests.
- `npx vitest run packages/trent-core/src/tools/social packages/trent-core/src/fleet/pack-skills.test.ts packages/trent-core/src/tools/tools-index.test.ts packages/trent-core/src/wrapped-modules.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts`
  -> exit 1: 74 passed, 1 failed, docs-truth `README.md: "accepts sixteen names": expected 16 to be 17`. That is the
  a2a toolset another agent is adding to `ToolsetSchema`; not a file of mine. Earlier in the session the same set
  also failed on a2a in tools-index and docs/getting-started.md; those cleared as that agent landed its edits.
- `cd packages/trent-core && npm run build` -> exit 0 (an earlier run failed only on another agent's untracked
  `orchestrator/verdict.test.ts`; my two TS7034/TS7005 errors in publish.ts were fixed).
- `node scripts/ci/repo-scan.mjs` -> exit 0.
- `npx vitest run packages/trent-core/src/tools/cron packages/trent-core/src/doctor/checks/social.test.ts packages/trent-core/src/fleet`
  -> exit 1: 442 passed, 1 failed, `tools/cron/queue-edit.test.ts` "refuses an edit the social toolset would
  refuse": it edits a queued Buffer post to `mediaUrl: "https://example.test/a.png"` and expects
  `buffer_media_unsupported`, which is the old requirement. Outside my scope; reported with the fix below.

## Open, not mine (for the lead)
- `tools/cron/queue-edit.test.ts:105-107`: change the edit to one the toolset still refuses, e.g.
  `{ mediaUrl: "https://example.test/share?id=1" }` expecting `/buffer_media_kind_unknown/` (or an `http://` URL,
  `/social_media_url_invalid/`).
- `tools/cron/queue-edit.ts` rebuilds the request from text, mediaUrl, accountId and platform only, so editing a
  queued post that carries files drops `media` (the new card then says "no media", so it is visible, but lossy),
  and `trent cron queue list` does not show the files. It also previews with `workspace: profileDir`, so it could
  not re-resolve files anyway; the entry's `request.media` should be carried through unchanged unless edited.
- Stale text in fleet/**: `FleetPacks.ts:177` says Buffer is "text only"; `FleetPacks.ts:188` and
  `pack-personas.ts:54` say the owner posts every creator clip (Bluesky can now take one); `pack-skills.test.ts:204`
  message says media_url is what "Bluesky drops and Buffer refuses".
- Not sent yet on Buffer: `ImageMetadataInput.altText`, a video's `thumbnailOffset`, more than one asset.
- EXIF is not stripped (the posts guide recommends it); documented in docs/social.md.
