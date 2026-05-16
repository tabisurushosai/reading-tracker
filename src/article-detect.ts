/**
 * article-detect — design skeleton (T016)
 *
 * Purpose
 * ───────
 * Decide whether the active browser tab is showing something worth tracking as
 * a "read article", and produce the metadata downstream modules consume:
 *   - read-log (T022–T024)      — stores {url, title, ts, difficulty}
 *   - difficulty-score (T019–)  — reads .text sample to compute difficulty
 *   - monthly-report (T028–)    — aggregates by host / difficulty
 *
 * Why a dedicated module instead of inlining into popup.ts?
 *   popup.ts at HEAD already has a minimal isHttpArticle() helper. Splitting
 *   the concern out lets background.ts and a future content.ts reuse the same
 *   rules, keeps the popup focused on UI, and gives T017's implementation a
 *   contract to satisfy.
 *
 * Detection strategy
 * ──────────────────
 * Two-tier, ordered cheapest → most expensive. Each tier may short-circuit:
 *
 *   1. URL heuristic (sync, zero permissions beyond chrome.tabs metadata)
 *      - Reject non-web schemes: chrome://, chrome-extension://, about:,
 *        view-source:, file:, data:, javascript:.
 *      - Reject sites that are almost never "an article" in the reading sense:
 *        feed / video / DM surfaces on the big platforms. We keep this list
 *        conservative — false negatives (a YouTube blog post is missed) are
 *        cheaper than false positives (timeline scrolling logged as reading).
 *      - Everything else returns `kind: "candidate"`.
 *
 *   2. Tab-metadata extraction (sync, uses already-permitted tab fields)
 *      - Pull `tab.url` and `tab.title`. Trim and fall back to URL when title
 *        is empty (some SPAs ship a blank <title> on first paint).
 *
 *   3. (Optional, later) chrome.scripting.executeScript at user-action time
 *      - SPEC.md mandates minimum permissions, so we never inject statically.
 *      - When the user clicks the read button, popup.ts may opt-in to a one-
 *        shot extraction that returns ~1–4 KB of body text for difficulty
 *        scoring. activeTab covers the permission cost without a host pattern.
 *      - This is gated behind `extractArticleBody()` and lives here so the
 *        sampling logic stays alongside the detection rules it depends on.
 *
 * Privacy / SPEC.md compliance
 * ────────────────────────────
 * - Everything runs locally. No URL, title, or sampled text leaves the device.
 * - Manifest already declares `activeTab` only (no host_permissions). The
 *   optional body extraction stays compatible with that scope because the
 *   user's click on the popup button grants the activeTab capability for that
 *   one invocation.
 * - The reject-list below intentionally references only hostnames, not paths,
 *   so we don't end up encoding any tracking-shaped fingerprint of the user.
 *
 * Failure mode
 * ────────────
 * detectActiveArticle() never throws. When chrome.tabs is unavailable (popup
 * opened in a context without tab access — e.g. unit tests) it returns
 * `{ kind: "unsupported" }`. Callers MUST handle that branch by disabling the
 * read action; popup.ts already does this for the existing isHttpArticle()
 * check and will swap in this richer result during T017.
 *
 * Test surface (T018)
 * ───────────────────
 * The pure functions exported here (classifyUrl, isRejectedHost) are designed
 * to be testable without a chrome runtime. The async detectActiveArticle()
 * wrapper is the integration seam — T018 will mock chrome.tabs.query.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type UrlClassification =
  /** Scheme we never track (chrome://, file:, data:, etc.). */
  | { kind: "unsupported-scheme"; scheme: string }
  /** Hostname we explicitly skip (timelines, video feeds, DMs). */
  | { kind: "rejected-host"; host: string }
  /** Web URL that could plausibly be an article. */
  | { kind: "candidate"; host: string };

export interface ArticleCandidate {
  /** Canonical URL we'll record (tab.url, untouched). */
  url: string;
  /** Display title — tab.title trimmed, with URL fallback. */
  title: string;
  /** Lowercased hostname for grouping in monthly-report. */
  host: string;
  /**
   * Optional sampled body text. Present only when extractArticleBody() was
   * invoked and succeeded. difficulty-score will treat absence as "unknown".
   */
  text?: string;
}

export type ArticleDetection =
  | { kind: "article"; article: ArticleCandidate }
  | { kind: "rejected"; reason: UrlClassification }
  | { kind: "unsupported" /* no chrome.tabs in this context */ };

// ---------------------------------------------------------------------------
// Constants (kept here so T017/T018 share a single source of truth)
// ---------------------------------------------------------------------------

/** Schemes we refuse to treat as articles. Compared case-insensitively. */
export const UNSUPPORTED_SCHEMES: readonly string[] = [
  "chrome:",
  "chrome-extension:",
  "about:",
  "view-source:",
  "file:",
  "data:",
  "javascript:",
  "edge:",
  "brave:",
  "opera:",
];

/**
 * Hostnames whose canonical surface is a feed / video / DM rather than an
 * article. Subdomains are matched via endsWith on `"." + host`, so
 * `m.youtube.com` is rejected by `"youtube.com"`. Conservative on purpose —
 * we'd rather log a borderline blog page than silently skip the user's read.
 */
export const REJECTED_HOSTS: readonly string[] = [
  "youtube.com",
  "youtu.be",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "pinterest.com",
  "linkedin.com",
];

/** Hard cap on the sampled body text. Keeps storage + scoring bounded. */
export const MAX_BODY_SAMPLE_CHARS = 4096;

// ---------------------------------------------------------------------------
// Pure helpers — T017 implements, T018 tests
// ---------------------------------------------------------------------------

/**
 * Classify a URL without touching chrome.* APIs. Pure, sync, exception-free
 * (invalid URLs collapse to `unsupported-scheme` with scheme="invalid").
 */
export declare function classifyUrl(rawUrl: string | undefined): UrlClassification;

/** True when `host` matches any entry in REJECTED_HOSTS (with subdomain rule). */
export declare function isRejectedHost(host: string): boolean;

/** Trim + fall back to URL. Exposed for popup.ts symmetry and easy testing. */
export declare function pickDisplayTitle(rawTitle: string | undefined, url: string): string;

// ---------------------------------------------------------------------------
// Async surfaces — T017 wires these to chrome.tabs / chrome.scripting
// ---------------------------------------------------------------------------

/**
 * Inspect the active tab and return a structured detection result.
 * Never throws; callers branch on `.kind`.
 */
export declare function detectActiveArticle(): Promise<ArticleDetection>;

/**
 * One-shot body sample for the given tab, gated behind a user click.
 * Returns null when injection is blocked (restricted page, no activeTab,
 * etc.) so callers can fall back to metadata-only logging.
 *
 * Implementation note for T017: use chrome.scripting.executeScript with a
 * pure function that reads document.body.innerText, trims, and slices to
 * MAX_BODY_SAMPLE_CHARS. Do NOT request host_permissions to make this work
 * everywhere — activeTab is sufficient at click time.
 */
export declare function extractArticleBody(tabId: number): Promise<string | null>;
