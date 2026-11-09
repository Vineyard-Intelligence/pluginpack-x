//
// X (Twitter) — two plugins over one anonymous guest session: profile, and posts.
//
// SPLIT ON PURPOSE, mirroring the Telegram pack's endpoint-per-plugin shape. One plugin that
// always did both was wrong in four ways, and the two upstream calls really are two operations:
//
//   1. COST. A profile is two requests and one node. A timeline is one more request and up to a
//      hundred nodes plus their hashtag/media/thread edges. "Does @foo exist, and what does the
//      bio say" should not stage sixty items the analyst has to review to find out.
//   2. FAILURE ISOLATION. Both calls go through X's internal GraphQL, each under its own operation
//      id — a hash X rotates without warning, one operation at a time. The timeline was a flat REST
//      endpoint when this split was made and is GraphQL `UserTweets` now (see fetchTimeline); the
//      reason stands, since a rotated profile id leaves posts working and the reverse. Fused into
//      one run(), a rotated id took both down.
//   3. THE AGENT PICKS BY DESCRIPTION. A single "X (Twitter)" tool gives it no way to say "just
//      the profile", so it either over-collects or avoids the pack.
//   4. HONEST io.produces. The old single entry claimed account+post+hashtag+media, so the
//      marketplace demanded the whole Social typepack from someone who only wanted profiles.
//
// The cost of splitting is one extra guest-token activation when both are run, since module state
// dies with the worker. That is one request against a budget the human pacing below already
// dominates — the right trade.
//
// Uses the same anonymous path as the Fritter/Squawker client family: POST
// api.twitter.com/1.1/guest/activate.json to mint a `guest_token`, then call the
// web app's internal endpoints with `x-guest-token` attached. No API key, no login,
// no OAuth — which is exactly why this whole family breaks whenever X rotates its
// GraphQL operation IDs or starts gating the guest path. Expect breakage; the point
// of this pack is that the analyst pays zero and loses nothing when it happens.
//
// TWO DELIBERATE DEVIATIONS FROM FRITTER, both Vineyard-shaped:
//
//   1. The public web bearer IS sent, on every request. This file used to omit it —
//      the host bridge stripped `authorization` from every plugin request, so the
//      header would have been deleted in transit — and the note here said that if X
//      ever demanded it again, the fix would be a platform change rather than a
//      change to this file. Both halves happened: the strip is gone (it protected
//      nothing, and pushed credentials onto custom headers that survive a
//      cross-origin redirect where `Authorization` does not), and X now answers the
//      guest path `403 Forbidden` without the bearer. See WEB_BEARER below.
//
//   2. Human-paced collection. Fritter is an interactive app; a plugin run is a
//      burst. To keep a run from looking like a bot: every request is preceded by a
//      jittered 0.7–2s pause, every 8th request gets a longer 1.5–4s pause, and a
//      429 answers with Retry-After / exponential backoff capped at 30s. The run
//      stays cancellable at every pause and request.
//
// Desktop only. X sends no CORS headers and answers no preflight at all, so a
// browser cannot reach any of this: the desktop shell has to waive the policy for
// api.twitter.com and twitter.com first. The Run plugins dialog reads those two
// straight out of the manifest below and offers them as one click, confirmed by the
// shell's own dialog — the analyst never types an address. A CORS failure still
// surfaces here as a bare TypeError, which run() turns into that instruction rather
// than a stack trace.
//
// Graph model (typepack-social): the account → social.account (platform "x"); each
// tweet → social.post; hashtags → social.hashtag with `uses hashtag` edges; media →
// social.media with `contains media` edges; retweets/replies get `reposted`/`replies to`
// edges to the original post when the timeline carries it. Mentions are deliberately NOT
// materialized yet — deciding whether a mention creates an account node is a policy
// question, not a parsing one.
//
import { definePlugin, definePluginPack } from './sdk';
import type { HostContext, RunResult, GraphNode, SafeResponse } from './sdk';

// ---- endpoints & constants -------------------------------------------------

const ACTIVATE_URL = 'https://api.twitter.com/1.1/guest/activate.json';
const GRAPHQL_BASE = 'https://twitter.com/i/api/graphql';
const OP_USER_BY_SCREEN_NAME = 'oUZZZ8Oddwxs8Cd3iW3UEA/UserByScreenName';
const OP_USER_TWEETS = 'V7H0Ap3_Hh2FyS75OCDO3Q/UserTweets';

/**
 * The X web client's public bearer — the same constant Fritter, Squawker and nitter ship.
 *
 * It is a client identifier, not a credential: it is served to every anonymous visitor inside
 * the web app's own JavaScript, it belongs to no account, and it grants nothing on its own — the
 * per-run `guest_token` minted below is what actually authorises a read.
 *
 * This pack used to omit it deliberately, because the host bridge stripped `authorization` from
 * every plugin request and a header that is deleted in transit is worse than no header. That
 * strip is gone (it protected nothing and pushed credentials onto custom headers, which survive
 * a cross-origin redirect where `Authorization` does not), and X now refuses the guest path
 * without the bearer:
 *
 *     POST /1.1/guest/activate.json                     -> 403 {"code":200,"message":"Forbidden."}
 *     POST /1.1/guest/activate.json  + Authorization    -> 200 {"guest_token":"..."}
 *
 * which is the "failed to fetch" an analyst saw, once the CORS layer was out of the way.
 */
const WEB_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const MAX_ATTEMPTS = 5;

// Human pacing. Jittered so the cadence is never a fixed rhythm; the long pause
// every N requests is the "scrolled to a new page / opened a profile" beat.
const PAUSE_MIN_MS = 700;
const PAUSE_JITTER_MS = 1300;
const LONG_PAUSE_EVERY = 8;
const LONG_PAUSE_MIN_MS = 1500;
const LONG_PAUSE_JITTER_MS = 2500;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30000;

// ---- per-run guest session -------------------------------------------------
// One dedicated worker per run, so module state is run state: the guest token is
// minted once and reused within the run, then dies with the worker.

let guestToken: string | null = null;
let rateRemaining = -1;
let rateLimit = -1;
let rateResetAt = 0;

type Json = Record<string, any>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (min: number, spread: number) => min + Math.random() * spread;

function trackRateLimit(headers: Record<string, string>): void {
    // Fritter's token rotation trick: the internal endpoints answer with
    // x-rate-limit-* headers, so the client knows when its guest token is spent and
    // re-activates instead of waiting to fail. Desktop exposes all response headers
    // to the plugin; the web build never gets here (CORS).
    const remaining = headers['x-rate-limit-remaining'];
    const limit = headers['x-rate-limit-limit'];
    const reset = headers['x-rate-limit-reset'];
    if (remaining !== undefined) rateRemaining = Number(remaining);
    if (limit !== undefined) rateLimit = Number(limit);
    if (reset !== undefined) rateResetAt = Number(reset) * 1000;
}

function tokenExhausted(): boolean {
    if (rateLimit < 0 || rateRemaining < 0) return false;
    if (Date.now() < rateResetAt) return rateRemaining <= 0;
    return rateRemaining >= rateLimit; // window already reset
}

async function activateGuestToken(ctx: HostContext): Promise<void> {
    if (ctx.signal?.aborted) throw new DOMException('run cancelled', 'AbortError');
    const res = await ctx.net!.fetch!(ACTIVATE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${WEB_BEARER}`, 'x-twitter-active-user': 'yes' },
    });
    if (res.status === 401 || res.status === 403) {
        throw new Error(
            'X refused to issue a guest token (HTTP ' +
                res.status +
                ') — the anonymous guest path has changed; this pack needs a header-set update.',
        );
    }
    if (!res.ok) throw new Error(`guest token activation returned HTTP ${res.status}`);
    const body = (await res.json()) as Json;
    if (typeof body.guest_token !== 'string' || !body.guest_token) {
        throw new Error('guest token activation returned no guest_token');
    }
    guestToken = body.guest_token;
    rateRemaining = rateLimit = rateResetAt = -1;
}

let requestCount = 0;

async function humanPause(ctx: HostContext): Promise<void> {
    if (ctx.signal?.aborted) throw new DOMException('run cancelled', 'AbortError');
    requestCount++;
    const extra = requestCount % LONG_PAUSE_EVERY === 0 ? jitter(LONG_PAUSE_MIN_MS, LONG_PAUSE_JITTER_MS) : 0;
    await sleep(jitter(PAUSE_MIN_MS, PAUSE_JITTER_MS) + extra);
}

async function xFetch(
    ctx: HostContext,
    url: string,
    init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<SafeResponse> {
    const method = init?.method ?? 'GET';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Fritter's token trick, made live: if the rate-limit headers say this guest
        // token is spent (or its window has reset), re-activate BEFORE asking for
        // anything — the same move Fritter's _expiresAt/_tokenLimit/_tokenRemaining
        // state performs. 401/403-reactive rotation below is the backstop.
        if (guestToken && tokenExhausted()) await activateGuestToken(ctx);

        await humanPause(ctx);

        // The guest identity goes on every request. `x-twitter-active-user` is the
        // "this is the web app" flag the internal endpoints expect alongside it.
        const headers: Record<string, string> = {
            ...(init?.headers ?? {}),
            authorization: `Bearer ${WEB_BEARER}`,
            'x-twitter-active-user': 'yes',
            'user-agent': userAgent(),
        };
        if (guestToken) headers['x-guest-token'] = guestToken;

        const res = await ctx.net!.fetch!(url, { method, headers, body: init?.body });

        if (res.status === 401 || res.status === 403) {
            // Stale or rejected token — refresh once and retry the same request.
            await activateGuestToken(ctx);
            continue;
        }
        if (res.status === 429) {
            const retryAfter = Number(res.headers?.['retry-after'] ?? NaN);
            const wait = Number.isFinite(retryAfter)
                ? retryAfter * 1000
                : Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
            await sleep(wait + jitter(0, 800));
            continue;
        }
        if (!res.ok) throw new Error(`X returned HTTP ${res.status} for ${method} ${url}`);

        trackRateLimit(res.headers ?? {});
        return res;
    }

    throw new Error(`X kept rejecting requests for ${url} — giving up after ${MAX_ATTEMPTS} attempts`);
}

// ---- request identity ------------------------------------------------------
// A small pool of desktop-browser-like User-Agents. Honest caveat: the host bridge
// uses the browser's own fetch, which treats `user-agent` as a forbidden header and
// silently drops it — so today this is a no-op, kept because a wrong value would be
// worse than none and because a future bridge that sets a real UA wants the pool here.
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];
let uaIndex = 0;
const userAgent = () => USER_AGENTS[(uaIndex = (uaIndex + 1) % USER_AGENTS.length)];

// ---- X API calls -----------------------------------------------------------

async function fetchProfile(ctx: HostContext, screenName: string): Promise<Json> {
    const variables = {
        screen_name: screenName,
        withHighlightedLabel: true,
        withSafetyModeUserFields: true,
        withSuperFollowsUserFields: true,
    };
    const features = {
        hidden_profile_likes_enabled: false,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        highlights_tweets_tab_ui_enabled: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
    };
    const q = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(features),
    });
    const res = await xFetch(ctx, `${GRAPHQL_BASE}/${OP_USER_BY_SCREEN_NAME}?${q}`);
    return (await res.json()) as Json;
}

/**
 * The profile timeline, via GraphQL `UserTweets`.
 *
 * This was `/2/timeline/profile/{id}.json`, the flat endpoint the Fritter generation used. X
 * deleted it — it answers 404 for every id now, with a live guest token and a valid bearer — so
 * the pack could mint a token, read a profile, and then fail on the one call that mattered.
 *
 * `UserTweets` is what the web app itself calls, and it answers a guest token happily (measured:
 * 100 tweets for a public account). The cost is that the response is the nested `timeline_v2`
 * instruction/entry structure rather than a flat `globalObjects` map, which extractTweets below
 * has to walk.
 *
 * `features` is not decoration: GraphQL rejects the whole query with "The following features
 * cannot be null" if a flag the operation declares is missing, so this list has to stay in step
 * with the operation id above. Both rotate; expect this pair to be what breaks first.
 */
async function fetchTimeline(ctx: HostContext, userId: string, count: number, cursor?: string): Promise<Json> {
    const variables = {
        userId,
        count,
        ...(cursor ? { cursor } : {}),
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: false,
        withV2Timeline: true,
    };
    const features = {
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        tweetypie_unmention_optimization_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: false,
        tweet_awards_web_tipping_enabled: false,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_media_download_video_enabled: false,
        responsive_web_enhance_cards_enabled: false,
    };
    const q = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(features),
    });
    const res = await xFetch(ctx, `${GRAPHQL_BASE}/${OP_USER_TWEETS}?${q}`);
    return (await res.json()) as Json;
}

// ---- response parsing ------------------------------------------------------

function profileAccount(result: Json): { account: Json; userId: string } | { error: string } {
    const errors = result['errors'];
    if (Array.isArray(errors) && errors.length) {
        const code = Number(errors[0]?.['code'] ?? -1);
        const message = String(errors[0]?.['message'] ?? 'unknown error');
        if (code === 50)
            return {
                error: `@${result['data']?.['user']?.['result']?.['legacy']?.['screen_name'] ?? ''} was not found`,
            };
        return { error: `X error ${code}: ${message}` };
    }

    const userResult = result?.['data']?.['user']?.['result'];
    if (!userResult) return { error: 'Profile response contained no user' };

    const kind = userResult['__typename'];
    if (kind === 'UserUnavailable') {
        const reason = String(userResult['reason'] ?? 'unavailable');
        return { error: reason === 'Suspended' ? 'Account is suspended' : `Account unavailable (${reason})` };
    }
    if (kind && kind !== 'User') return { error: `Unexpected profile result type: ${kind}` };

    const legacy = (userResult['legacy'] ?? {}) as Json;
    const account: Json = {
        platform: 'x',
        username: String(legacy['screen_name'] ?? '').toLowerCase(),
        user_id: String(userResult['rest_id'] ?? ''),
        display_name: legacy['name'],
        bio: legacy['description'],
        location: legacy['location'],
        website: legacy['url'],
        followers: legacy['followers_count'],
        following: legacy['friends_count'],
        post_count: legacy['statuses_count'],
        verified: userResult['is_blue_verified'] ?? legacy['verified'] ?? false,
        created_date: isoDate(legacy['created_at']),
        profile_url: `https://x.com/${legacy['screen_name']}`,
        avatar_url: legacy['profile_image_url_https'],
    };
    return { account, userId: String(userResult['rest_id'] ?? '') };
}

/**
 * Pull the legacy tweet objects out of a `timeline_v2` response.
 *
 * The shape is instructions -> entries -> content, and only some of those carry a tweet:
 *   TimelineAddEntries  the page itself
 *   TimelinePinEntry    a pinned tweet, delivered as its own instruction
 * An entry is either a single item (`itemContent`) or a module of them (`items`), the latter
 * being how X delivers self-threads. Both are walked, because a thread is exactly the case an
 * analyst cares about and dropping it would silently lose most of a prolific account's page.
 *
 * `tweet_results.result` is a union: a plain `Tweet`, or a `TweetWithVisibilityResults` wrapper
 * whose real tweet hangs off `.tweet`. Unwrapping it is what keeps age-restricted and
 * limited-visibility posts from vanishing from the count.
 *
 * The legacy object inside is the same one the old flat endpoint returned — `full_text`,
 * `entities`, the engagement counters — so everything downstream of here is unchanged.
 */
/**
 * The Bottom cursor, or null when the timeline says it has no more.
 *
 * `count` is a SUGGESTION X ignores — measured: asking @nasa for 5, 20, 100 and 200 returned 19
 * every time, and @jack returned 100 for a request of 40. The page size is X's choice, so the only
 * way to honour what the analyst asked for is to follow this cursor. Every response carries a Top
 * and a Bottom one; Bottom walks backwards in time, which is the direction a sweep wants.
 */
function bottomCursor(timeline: Json): string | null {
    const instructions = (timeline?.['data']?.['user']?.['result']?.['timeline_v2']?.['timeline']?.['instructions'] ??
        []) as Json[];
    for (const ins of instructions) {
        for (const entry of (ins['entries'] ?? []) as Json[]) {
            const c = (entry['content'] ?? {}) as Json;
            if (c['cursorType'] === 'Bottom' && typeof c['value'] === 'string' && c['value']) {
                return c['value'] as string;
            }
        }
    }
    return null;
}

function extractTweets(timeline: Json, count: number): Json[] {
    const instructions = (timeline?.['data']?.['user']?.['result']?.['timeline_v2']?.['timeline']?.['instructions'] ??
        []) as Json[];
    const out: Json[] = [];
    const seen = new Set<string>();

    const take = (result: Json | undefined): void => {
        if (!result) return;
        const tweet = (result['__typename'] === 'TweetWithVisibilityResults' ? result['tweet'] : result) as Json;
        const legacy = tweet?.['legacy'] as Json | undefined;
        const id = String(legacy?.['id_str'] ?? tweet?.['rest_id'] ?? '');
        if (!legacy || !id || seen.has(id)) return;
        seen.add(id);
        // `rest_id` is authoritative; a legacy block occasionally arrives without id_str.
        out.push({ ...legacy, id_str: id });
    };

    for (const ins of instructions) {
        const entries = (ins['entries'] ?? (ins['entry'] ? [ins['entry']] : [])) as Json[];
        for (const entry of entries) {
            const content = (entry['content'] ?? {}) as Json;
            take(content['itemContent']?.['tweet_results']?.['result']);
            for (const item of (content['items'] ?? []) as Json[]) {
                take(item['item']?.['itemContent']?.['tweet_results']?.['result']);
            }
        }
    }
    // `count` is a hint to X, not a promise: a pinned entry and a thread module both add posts
    // beyond the page size. Trim to what the analyst actually approved.
    return out.slice(0, count);
}

function isoDate(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
}

function hashtagsOf(tweet: Json): string[] {
    const tags = (tweet?.['entities']?.['hashtags'] ?? []) as Array<{ text?: string }>;
    return tags.map((h) => String(h.text ?? '')).filter((t) => t.length > 0);
}

// X's own vocabulary → the platform-agnostic `social.media.media_type` enum
// (image/video/gif/audio/unknown). Writing X's raw `photo`/`animated_gif` straight
// through would put values outside the declared enum into Node.data: the backend
// does not validate `data`, so nothing would reject them — the Properties select
// would just render blank, and a cross-platform "all images" filter would silently
// miss every X node. Anything unrecognised lands on `unknown` rather than inventing
// a new enum member.
const MEDIA_KINDS: Record<string, string> = {
    photo: 'image',
    video: 'video',
    animated_gif: 'gif',
};

function mediaOf(tweet: Json): Array<{ url: string; kind: string }> {
    const media = (tweet?.['entities']?.['media'] ?? []) as Array<{
        media_url_https?: string;
        type?: string;
    }>;
    return media
        .map((m) => ({
            url: String(m.media_url_https ?? ''),
            kind: MEDIA_KINDS[String(m.type ?? '')] ?? 'unknown',
        }))
        .filter((m) => m.url.length > 0);
}

// ---- shared plugin scaffolding ---------------------------------------------

const MANIFEST_BASE = {
    content_type: 'vineyard:plugin',
    version: '0.6.3',
    icon: 'bird',
    author: { name: 'VINEYARD', url: 'https://vineyard.run' },
    license: 'Apache-2.0',
    platforms: {
        primary: 'desktop',
        web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
        desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
    },
    scopes: {
        graph: ['node:read', 'node:create', 'edge:create'],
        network: [
            {
                endpoint: 'https://api.twitter.com',
                methods: ['GET', 'POST'],
                purpose: 'Start a logged-out guest session on X.',
            },
            {
                endpoint: 'https://twitter.com',
                methods: ['GET'],
                purpose: 'Read public data of the selected accounts from X.',
            },
        ],
    },
    lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
} as const;

const SOCIAL = 'run.vineyard.typepacks.social';
const IDENTITY = 'run.vineyard.typepacks.identity';
const ACCOUNT_IN = [
    { typepack: SOCIAL, category: 'social', name: 'account' },
    { typepack: IDENTITY, category: 'identity', name: 'account' },
];

const DESKTOP_HINT =
    'X answers no cross-origin request and no CORS preflight, so a browser cannot read it at all. Open this project in the Vineyard desktop app, allow api.twitter.com and twitter.com when the Run plugins dialog offers to, and run again.';
const BOTCHECK_HINT =
    'X returned a non-JSON response (usually its bot-check page). Wait a bit and run again; if it persists, X is gating the anonymous path for this network.';

/**
 * Both plugins fail the same two ways, and both are invisible from inside the sandbox: a browser
 * CORS refusal arrives as a bare TypeError, and X's bot-check page is a 200 whose HTML fails
 * JSON.parse. Translated once, here, so the two runs cannot drift into explaining it differently.
 */
async function guarded(counts: Record<string, number>, body: () => Promise<RunResult>): Promise<RunResult> {
    try {
        return await body();
    } catch (err) {
        // A graph-op TypeError would land here too and read as a CORS hint — acceptable: local
        // store ops throwing TypeErrors are programming errors that show up in the task log anyway.
        if (err instanceof TypeError) return { summary: DESKTOP_HINT, counts };
        if (err instanceof SyntaxError) return { summary: BOTCHECK_HINT, counts };
        throw err;
    }
}

/** The @handle on one node, from either accepted input type. */
async function usernameOf(
    ctx: HostContext,
    id: string,
): Promise<{ node: GraphNode; username: string } | { error: string }> {
    const node = await ctx.graph!.get!(id);
    if (!node) return { error: 'Node not found' };
    const data = (node.data ?? {}) as Json;
    const username = String(data.username ?? data.handle ?? '')
        .trim()
        .toLowerCase();
    if (!username) return { error: 'No username on the node' };
    return { node, username };
}

/** Build a social.post draft. Shared so the loop and the thread-linking path cannot diverge. */
function postData(id: string, t: Json, username: string): Record<string, unknown> {
    return {
        platform: 'x',
        post_id: id,
        url: `https://x.com/${username}/status/${id}`,
        content: t['full_text'] ?? t['text'],
        created_at: isoDate(t['created_at']),
        language: t['lang'],
        like_count: t['favorite_count'],
        repost_count: t['retweet_count'],
        reply_count: t['reply_count'],
        conversation_id: t['conversation_id_str'],
        media_urls: mediaOf(t)
            .map((m) => m.url)
            .join('\n'),
    };
}

// ---- 1. profile ------------------------------------------------------------

export const xProfile = definePlugin({
    manifest: {
        ...MANIFEST_BASE,
        identifier: 'run.vineyard.plugins.x_profile',
        name: 'X Profile',
        version: '0.6.3',
        description:
            "Fetches the public X (Twitter) profile for each selected Social Account or Account node's username and writes it to the X Social Account node (created if absent): user_id, display name, bio, location, website, follower/following/post counts, verification, join date, avatar URL. Desktop only.",
        io: { consumes: ACCOUNT_IN, produces: [{ typepack: SOCIAL, category: 'social', name: 'account' }] },
    } as any,
    async run(ctx): Promise<RunResult> {
        const ids = ctx.input.selection;
        if (!ids.length) return { summary: 'Select an account node first', counts: { found: 0 } };
        if (!ctx.net?.fetch) return { summary: 'Network capability not granted to this plugin', counts: { found: 0 } };

        return guarded({ found: 0 }, async (): Promise<RunResult> => {
            // Minted ONCE for the whole selection, not per node: `xFetch` already re-activates on
            // its own when the token is spent or a request comes back 401/403, so an upfront
            // per-node activation would only spend an extra request on every account after the
            // first for no benefit — see the pack's own header comment on this cost.
            ctx.progress?.set?.({ percent: 3, message: 'Activating guest session' });
            await activateGuestToken(ctx);

            let accounts = 0;
            let followers = 0;
            let postsReported = 0;
            let notFound = 0;
            let noUsername = 0;
            let errored = 0;
            let lastSummary = '';
            for (let i = 0; i < ids.length; i++) {
                if (ctx.signal?.aborted) {
                    return {
                        summary: `Cancelled after ${i}/${ids.length} node(s)`,
                        counts: { found: accounts, accounts, followers, posts_reported: postsReported },
                    };
                }
                const seed = await usernameOf(ctx, ids[i]);
                if ('error' in seed) {
                    if (seed.error === 'Node not found') notFound++;
                    else noUsername++;
                    continue;
                }
                const { username } = seed;

                ctx.progress?.set?.({
                    percent: Math.round((100 * i) / ids.length),
                    message:
                        ids.length > 1
                            ? `Fetching profile @${username} (${i + 1}/${ids.length})`
                            : `Fetching profile @${username}`,
                });
                let parsed: ReturnType<typeof profileAccount>;
                try {
                    parsed = profileAccount(await fetchProfile(ctx, username));
                } catch {
                    // A per-account failure (rate limit exhausted mid-run, one bad response) must
                    // not sink the rest of the selection the way a structural CORS/bot-check
                    // failure does — that class is still caught by the outer `guarded()`.
                    errored++;
                    continue;
                }
                if ('error' in parsed) {
                    errored++;
                    continue;
                }

                await ctx.graph!.createNode!({ type: 'social.account', data: parsed.account });
                const a = parsed.account;
                accounts++;
                followers += Number(a['followers']) || 0;
                postsReported += Number(a['post_count']) || 0;
                lastSummary = `@${username}: ${a['followers'] ?? '?'} followers, ${a['post_count'] ?? '?'} posts${
                    a['verified'] ? ', verified' : ''
                }`;
            }

            const skipped = notFound + noUsername + errored;
            const skipNote = skipped
                ? ` (${skipped} skipped: ${noUsername} without a username, ${errored} X error(s), ${notFound} not found)`
                : '';
            return {
                summary: accounts === 1 ? `${lastSummary}${skipNote}` : `${accounts} profile(s) fetched${skipNote}`,
                counts: {
                    // `found` mirrors `accounts` for continuity with every other plugin in this
                    // repo, which reports its primary yield under that key.
                    found: accounts,
                    accounts,
                    followers,
                    posts_reported: postsReported,
                },
            };
        });
    },
});

// ---- 2. posts --------------------------------------------------------------

const DEFAULT_COUNT = 20;
/**
 * Ceiling on how many posts one run stages — a REVIEW budget, not an API limit.
 *
 * Nothing upstream stops at 100: with cursor paging the timeline keeps going for as long as the
 * account has posts. The number that matters is what a human can actually read in the staging
 * diff, and 100 posts already drags their hashtag, media and thread nodes along with them — a few
 * hundred items. Wanting more than this is wanting an export, which is a different feature.
 */
const MAX_COUNT = 100;
/**
 * Stop after this many requests however few posts came back.
 *
 * X decides the page size, and a starved page (14–19 is normal) would otherwise turn a request for
 * 100 into a long series of paced requests. This bounds the run; falling short of `count` is
 * reported honestly in the summary rather than hidden.
 */
const MAX_PAGES = 10;

/** A TypeError (CORS refusal) or SyntaxError (X's bot-check HTML) is structural — it will repeat
 * identically for every remaining node, so the loop below lets these propagate to the outer
 * `guarded()` instead of burning the rest of the selection's pacing budget rediscovering it. */
function isStructuralFailure(err: unknown): boolean {
    return err instanceof TypeError || err instanceof SyntaxError;
}

interface PostsOutcome {
    posts: number;
    hashtags: number;
    media: number;
    edges: number;
    pages: number;
    summary: string;
}

/** Everything X Posts does for ONE account, unchanged from before this pack looped selections. */
async function collectPosts(
    ctx: HostContext,
    node: GraphNode,
    username: string,
    want: number,
    progressBase: number,
    progressSpan: number,
): Promise<PostsOutcome> {
    // The timeline is addressed by numeric id, not handle. A node that has already been
    // through X Profile carries `user_id`, so the whole GraphQL round trip — the fragile
    // half of this pack — is skipped. That is the concrete payoff of splitting: run the
    // profile once, then collect posts as many times as you like without touching the
    // operation id X keeps rotating.
    let userId = String((node.data as Json)?.['user_id'] ?? '').trim();
    let accountId = String(node.id);
    if (!userId) {
        ctx.progress?.set?.({ percent: progressBase, message: `Resolving @${username}` });
        const parsed = profileAccount(await fetchProfile(ctx, username));
        if ('error' in parsed) return { posts: 0, hashtags: 0, media: 0, edges: 0, pages: 0, summary: parsed.error };
        userId = parsed.userId;
        // De-dup on (platform, username) folds this into the existing node rather than
        // adding a second one, and gives the posts a stable endpoint to attach to.
        accountId = String((await ctx.graph!.createNode!({ type: 'social.account', data: parsed.account })).id);
    }
    if (!userId) {
        return {
            posts: 0,
            hashtags: 0,
            media: 0,
            edges: 0,
            pages: 0,
            summary: `Could not resolve a user id for @${username}`,
        };
    }

    // Page until we have what the analyst asked for. `count` is a hint X ignores — the
    // same request answered 19 for one account and 100 for another — so a single page
    // cannot honour it, and following the Bottom cursor is the only way that number means
    // anything. Stops on: enough posts, no cursor, a page that added nothing new (X
    // repeating itself), or MAX_PAGES.
    const byId = new Map<string, Json>();
    let cursor: string | undefined;
    let pages = 0;
    while (byId.size < want && pages < MAX_PAGES) {
        if (ctx.signal?.aborted) break;
        ctx.progress?.set?.({
            percent: Math.min(progressBase + progressSpan * 0.7, progressBase + pages * (progressSpan / MAX_PAGES)),
            message: pages
                ? `Fetching posts from @${username} (${byId.size}/${want})`
                : `Fetching posts from @${username}`,
        });
        const page = await fetchTimeline(ctx, userId, want, cursor);
        pages++;
        const before = byId.size;
        for (const t of extractTweets(page, want)) {
            const id = String(t['id_str'] ?? '');
            if (id && !byId.has(id)) byId.set(id, t);
        }
        const next = bottomCursor(page);
        if (!next || next === cursor || byId.size === before) break;
        cursor = next;
    }
    const tweets = [...byId.values()].slice(0, want);

    if (!tweets.length) {
        return {
            posts: 0,
            hashtags: 0,
            media: 0,
            edges: 0,
            pages,
            // SAY WHAT HAPPENED, NOT WHY. Two wrong explanations have already shipped in
            // this string — first "protected, empty, or gated", then "X gates logged-out
            // access to smaller accounts" — and both were guesses dressed as causes.
            //
            // What is actually measured: the profile call succeeds, this call returns a
            // timeline with no entries at all, and a LOGGED-OUT BROWSER shows the same
            // account's posts perfectly well. So it is not the account being private and
            // it is not logged-out gating. Nor is it account size: @r3dbU7z (1.4k
            // followers) returns 99 posts here while accounts with 53 and 114 followers
            // return none, and all five known UserTweets operation ids agree on each.
            // There is no documented rule, and seven accounts is not enough to derive one.
            //
            // The closest thing to a pattern, from the analyst's own sweep across many
            // accounts plus the measurements here: it fails more often below roughly a
            // thousand followers. It is NOT a threshold and must not be coded as one —
            // around 1,400 followers one account returned 99 posts and another returned
            // none. Same band, both directions.
            //
            // So the message reports the observation and calls the path unreliable.
            // Guessing again would be the third wrong guess in the same sentence.
            summary: `X returned an empty timeline for @${username} over the anonymous path, although the profile itself loaded. This is not the account being private — a logged-out browser can still show its posts. X answers this unofficial path unreliably, most often for smaller accounts (roughly under a thousand followers, though that is a tendency and not a cutoff). Nothing on the account or in this plugin changes it.`,
        };
    }

    let posts = 0;
    let hashtags = 0;
    let media = 0;
    let edges = 0;
    const timelineById = new Map(tweets.map((t) => [String(t['id_str'] ?? ''), t]));

    for (let i = 0; i < tweets.length; i++) {
        if (ctx.signal?.aborted) break;
        const t = tweets[i];
        const id = String(t['id_str'] ?? '');
        if (!id) continue;

        const postNode: GraphNode = await ctx.graph!.createNode!({
            type: 'social.post',
            data: postData(id, t, username),
        });
        await ctx.graph!.createEdge!({ from: accountId, to: String(postNode.id), label: 'posted by' });
        edges++;
        posts++;

        for (const tag of hashtagsOf(t)) {
            const tagNode = await ctx.graph!.createNode!({
                type: 'social.hashtag',
                data: { platform: 'x', hashtag: tag, first_seen_at: isoDate(t['created_at']) },
            });
            await ctx.graph!.createEdge!({
                from: String(postNode.id),
                to: String(tagNode.id),
                label: 'uses hashtag',
            });
            edges++;
            hashtags++;
        }

        for (const m of mediaOf(t)) {
            const mediaNode = await ctx.graph!.createNode!({
                type: 'social.media',
                data: { platform: 'x', media_url: m.url, media_type: m.kind },
            });
            await ctx.graph!.createEdge!({
                from: String(postNode.id),
                to: String(mediaNode.id),
                label: 'contains media',
            });
            edges++;
            media++;
        }

        // Thread structure. createNode de-dups on (platform, post_id), so the original is
        // the same node however many posts point at it.
        //
        // A REPOST carries its original EMBEDDED — `retweeted_status_result` is the whole
        // tweet, not an id — so the link no longer depends on the original happening to
        // appear in the same page. Under the old flat endpoint it did, which is why a
        // retweet of an account you were not collecting produced no edge at all.
        //
        // A REPLY still gives only `in_reply_to_status_id_str`, so it can only be linked
        // when the page carries the other post. Materialising a post from an id alone
        // would mean staging a node whose text nobody fetched.
        const repost = t['retweeted_status_result']?.['result'] as Json | undefined;
        const repostLegacy = (repost?.['__typename'] === 'TweetWithVisibilityResults' ? repost?.['tweet'] : repost)?.[
            'legacy'
        ] as Json | undefined;
        const repostId = String(repostLegacy?.['id_str'] ?? '');
        if (repostLegacy && repostId) {
            const original = await ctx.graph!.createNode!({
                type: 'social.post',
                data: postData(repostId, repostLegacy, username),
            });
            await ctx.graph!.createEdge!({
                from: String(postNode.id),
                to: String(original.id),
                label: 'reposted',
            });
            edges++;
        }

        const replyTo = t['in_reply_to_status_id_str'];
        if (replyTo && timelineById.has(String(replyTo))) {
            const original = await ctx.graph!.createNode!({
                type: 'social.post',
                data: postData(String(replyTo), timelineById.get(String(replyTo))!, username),
            });
            await ctx.graph!.createEdge!({
                from: String(postNode.id),
                to: String(original.id),
                label: 'replies to',
            });
            edges++;
        }

        ctx.progress?.set?.({
            percent: Math.min(
                progressBase + progressSpan,
                progressBase + progressSpan * 0.3 + Math.round(((i + 1) / tweets.length) * progressSpan * 0.7),
            ),
            message: `${posts} posts · ${hashtags} hashtags · ${media} media`,
        });
    }

    // Say so when X ran out before `count` did. Silently returning 40 for a request of 100
    // reads as a bug in the pack rather than the end of a short timeline.
    const short = posts < want ? ` (X had no more after ${posts})` : '';
    return {
        posts,
        hashtags,
        media,
        edges,
        pages,
        summary: `@${username}: ${posts} post(s), ${hashtags} hashtag(s), ${media} media, ${edges} edge(s)${short}`,
    };
}

export const xPosts = definePlugin({
    manifest: {
        ...MANIFEST_BASE,
        identifier: 'run.vineyard.plugins.x_posts',
        name: 'X Posts',
        version: '0.6.3',
        description:
            'Collects recent X (Twitter) posts for each selected Social Account or Account node\'s username. Creates one Post node per post (text, time, language, engagement counts, permalink, media URLs) plus Hashtag and Media nodes, with "posted by", "uses hashtag", "contains media", "reposted" and "replies to" edges; if the selected node has no user_id, also creates or fills the X Social Account node the posts attach to. Up to count posts per account (default 20, max 100); some accounts return an empty timeline even though their posts are public. Desktop only.',
        params: {
            type: 'object',
            properties: {
                count: {
                    type: 'integer',
                    title: 'Posts',
                    description: `Maximum posts to collect per account, 1–${MAX_COUNT}. Default ${DEFAULT_COUNT}.`,
                    minimum: 1,
                    maximum: MAX_COUNT,
                    default: DEFAULT_COUNT,
                },
            },
        },
        io: {
            consumes: ACCOUNT_IN,
            produces: [
                // The account itself when the selected node carries no user_id yet (an identity.account seed).
                { typepack: SOCIAL, category: 'social', name: 'account' },
                { typepack: SOCIAL, category: 'social', name: 'post' },
                { typepack: SOCIAL, category: 'social', name: 'hashtag' },
                { typepack: SOCIAL, category: 'social', name: 'media' },
            ],
        },
    } as any,
    async run(ctx): Promise<RunResult> {
        const ids = ctx.input.selection;
        if (!ids.length) return { summary: 'Select an account node first', counts: { found: 0 } };
        if (!ctx.net?.fetch) return { summary: 'Network capability not granted to this plugin', counts: { found: 0 } };
        const want = Math.min(MAX_COUNT, Math.max(1, Number(ctx.params?.['count']) || DEFAULT_COUNT));

        return guarded({ found: 0 }, async (): Promise<RunResult> => {
            // Minted ONCE for the whole selection — see the identical note in X Profile.
            ctx.progress?.set?.({ percent: 3, message: 'Activating guest session' });
            await activateGuestToken(ctx);

            let posts = 0;
            let hashtags = 0;
            let media = 0;
            let edges = 0;
            let pages = 0;
            let processed = 0;
            let notFound = 0;
            let noUsername = 0;
            let errored = 0;
            let lastSummary = '';
            for (let i = 0; i < ids.length; i++) {
                if (ctx.signal?.aborted) {
                    return {
                        summary: `Cancelled after ${i}/${ids.length} node(s) (${posts} post(s) collected)`,
                        counts: { found: posts, posts, hashtags, media, edges, pages },
                    };
                }
                const seed = await usernameOf(ctx, ids[i]);
                if ('error' in seed) {
                    if (seed.error === 'Node not found') notFound++;
                    else noUsername++;
                    continue;
                }
                const { node, username } = seed;

                const base = Math.round((100 * i) / ids.length);
                const span = 100 / ids.length;
                let r: PostsOutcome;
                try {
                    r = await collectPosts(ctx, node, username, want, base, span);
                } catch (err) {
                    if (isStructuralFailure(err)) throw err;
                    errored++;
                    continue;
                }
                processed++;
                posts += r.posts;
                hashtags += r.hashtags;
                media += r.media;
                edges += r.edges;
                pages += r.pages;
                lastSummary = r.summary;
            }

            const skipped = notFound + noUsername + errored;
            const skipNote = skipped
                ? ` (${skipped} skipped: ${noUsername} without a username, ${errored} X error(s), ${notFound} not found)`
                : '';
            return {
                summary:
                    processed === 1
                        ? `${lastSummary}${skipNote}`
                        : `${posts} post(s) across ${processed} account(s), ${hashtags} hashtag(s), ${media} media, ${edges} edge(s)${skipNote}`,
                counts: { found: posts, posts, hashtags, media, edges, pages },
            };
        });
    },
});

// The pack's page, shown under the summary line when the pack is opened in the marketplace. It is
// Markdown rendered without images or raw HTML, and links show as text, so URLs are written out.
// The plugins, their node types and the permissions are listed right below it, so the page says
// only what that list does not: what the pack is for, who sees what, and how to read the results.
const PACK_PAGE = [
    'Anonymous collection from X (Twitter) for accounts already in the graph, through the logged-out guest path the X web app itself uses, as the Fritter and Squawker clients do. X rotates the internal operation ids this path depends on and gates it when it chooses, so expect breakage, and a new pack version when it happens.',
    '',
    '**Needs:** no API key, login or OAuth. Requests carry the public bearer token the X web app serves to every anonymous visitor (a client identifier that belongs to no account, not a credential) and a guest token minted for the run.',
    '',
    '**Cost:** requests are paced like a person reading, 0.7 to 2 seconds apart with a longer pause every 8th. X Posts makes up to 10 timeline requests per account.',
    '',
    "**Who sees it:** only X, which sees every username queried from the analyst's network address and can rate-limit or block that address. Nothing is posted, followed or liked.",
    '',
    '**Read results with care:**',
    '- An empty timeline is not evidence of no posts. Over this path X returns one for some accounts whose posts a logged-out browser shows, more often below roughly a thousand followers, as a tendency and not a threshold. X Profile is reliable; X Posts is best effort.',
    '- A reply is linked only when the post it answers is in the same collection. Mentions are not turned into nodes.',
    '- A protected account gives no usable timeline. When X answers with its bot-check page, the run says so: wait and run again.',
    '',
    "**Data and licences:** X's public data, as X returns it to a logged-out visitor. Anonymous collection is a terms-of-service grey area.",
    '',
    '**Source:** https://github.com/Vineyard-Intelligence/pluginpack-x (Apache-2.0)',
].join('\n');

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.x',
    content_type: 'vineyard:pluginpack',
    name: 'X (Twitter)',
    version: '0.7.1',
    summary: 'Collects public X (Twitter) profiles and recent posts for account nodes. Desktop only.',
    description: PACK_PAGE,
    plugins: [xProfile, xPosts],
});
