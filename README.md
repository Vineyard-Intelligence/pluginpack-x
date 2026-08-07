# X (Twitter)

A Vineyard **plugin pack** for anonymous X (Twitter) collection. Given a **Social Account** (or
**User Account**) node, it fetches the account's profile and its recent posts, and adds a
**Social Account**, one **Post** per tweet, plus **Hashtag** and **Media** nodes and the edges
between them (`posted by`, `uses hashtag`, `contains media`, `reposted`, `replies to`).

It uses the same anonymous path as the Fritter/Squawker client family: `guest_token` activation
against `api.twitter.com/1.1/guest/activate.json`, then the web app's internal endpoints
(`twitter.com/i/api/graphql/...` for the profile, `/2/timeline/profile/{id}.json` for posts) with
the `x-guest-token` header. **No API key, no login, no OAuth.**

## Desktop only

This pack runs **only in the Vineyard desktop app**. X sends no CORS headers and answers no
preflight, so a browser cannot reach any of these endpoints — the requests only go through when
the desktop shell's allowlist contains `https://api.twitter.com` and `https://twitter.com`
(Settings → advanced origins). In a browser the plugin detects the CORS failure and tells you to
open the project in the desktop app rather than returning a misleading empty result.

## How it works

1. **Guest session** — POST `guest/activate.json` to mint a `guest_token`, reused for the whole
   run. If X rejects the token mid-run (401/403), the session is re-activated once and the request
   is retried. Unlike Fritter, no `Authorization: Bearer <web-bearer>` is sent — Vineyard's host
   bridge strips `authorization`/`cookie` from every plugin request by design.
2. **Human-paced collection** — every request is preceded by a jittered 0.7–2s pause, every 8th
   request gets a longer 1.5–4s pause, and a 429 answers with `Retry-After` / capped exponential
   backoff. The run stays cancellable at every pause.
3. **Staging** — every node and edge goes into the capture store, so nothing reaches the server
   until the analyst reviews and commits the run, under the analyst's own token.

## Data model

Uses the **Social Media** type pack (`run.vineyard.typepacks.social`): `social.account`,
`social.post`, `social.hashtag`, `social.media`, and their edge types. Attribution of an account
to a person or organization stays in the Identity type pack (`identity.controls`).

## Caveats

- X rotates its internal GraphQL operation IDs and gates the guest path whenever it wants —
  expect breakage, and expect this pack's version to bump when it happens.
- Anonymous collection is a terms-of-service gray area; X can rate-limit or block the IP.
- A protected (private) account answers with no usable timeline — the run fails gracefully
  rather than fabricating empty posts.
