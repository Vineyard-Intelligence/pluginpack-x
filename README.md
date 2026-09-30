# X (Twitter)

A Vineyard **plugin pack** for anonymous X (Twitter) collection. Two plugins, both taking a
**Social Account** (or **Account**) node:

| Plugin | Cost | Produces |
| --- | --- | --- |
| **X Profile** | 2 requests | the **Social Account** node, filled in: display name, bio, location, website, follower/following/post counts, verification, join date, avatar |
| **X Posts** ⚠️ | 1–3 requests per page | one **Post** per tweet, plus **Hashtag** and **Media** nodes and the edges between them (`posted by`, `uses hashtag`, `contains media`, `reposted`, `replies to`). **Returns nothing for some accounts** — see below |

They are separate on purpose: a profile is two requests and one node, a timeline is up to a
hundred nodes and their edges. They also fail independently — the profile is reliable, the
timeline comes back empty for some accounts (see below).

**Run Profile first.** It records `user_id` on the node, and X Posts skips the GraphQL call
entirely when that is already there — so repeat collections never touch the fragile half.
X Posts takes a `count` param (1–100, default 20).

It uses the same anonymous path as the Fritter/Squawker client family: `guest_token` activation
against `api.twitter.com/1.1/guest/activate.json`, then the web app's own GraphQL operations
(`UserByScreenName` for the profile, `UserTweets` for the timeline) with the `x-guest-token`
header and the web client's public bearer. **No API key, no login, no OAuth** — the bearer is the
constant X serves to every anonymous visitor inside its own JavaScript, not an account credential.

## Desktop only

This pack runs **only in the Vineyard desktop app**. X sends no CORS headers, so a browser cannot
reach these endpoints. The Run plugins dialog offers to allow `https://api.twitter.com` and
`https://twitter.com` in one click, and the desktop app confirms each origin. In a browser the
plugin tells you to open the project in the desktop app rather than returning a misleading empty
result.

## How it works

1. **Guest session** — POST `guest/activate.json` to mint a `guest_token`, reused for the whole
   run. Each plugin mints its own, so running both costs one extra activation. If X rejects the
   token mid-run (401/403), the session is re-activated once and the request is retried.
2. **Human-paced collection** — every request is preceded by a jittered 0.7–2s pause, every 8th
   request gets a longer 1.5–4s pause, and a 429 answers with `Retry-After` / capped exponential
   backoff. The run stays cancellable at every pause.
3. **Staging** — every node and edge is staged, so nothing reaches the server until the analyst
   reviews and commits the run.

## Data model

Uses the **Social Media** type pack (`run.vineyard.typepacks.social`): `social.account`,
`social.post`, `social.hashtag`, `social.media`, and their edge types. X's own media vocabulary
(`photo`, `animated_gif`) is mapped onto the pack's closed `media_type` enum
(`image`/`gif`/…); anything unrecognised lands on `unknown` rather than inventing a member. Attribution of an account
to a person or organization stays in the Identity type pack (`identity.controls`).

## X Posts is unreliable per account

**Some accounts return nothing, and there is no way to tell in advance.** For those, `UserTweets`
answers with a timeline containing no entries while the profile call for the same handle succeeds.

It is **not** the account being private, and not logged-out gating — a logged-out browser shows
those same posts. It fails more often for smaller accounts, **roughly under a thousand followers**,
but that is a tendency, not a threshold.

Nothing on the account or in this pack changes it. Treat X Posts as best-effort: **X Profile is
reliable, X Posts is not.** The run says so plainly instead of blaming the account.

## Caveats

- X rotates its internal GraphQL operation IDs and gates the guest path whenever it wants —
  expect breakage, and expect this pack's version to bump when it happens.
- Anonymous collection is a terms-of-service gray area; X can rate-limit or block the IP.
- A protected (private) account answers with no usable timeline — the run fails gracefully
  rather than fabricating empty posts.
