/**
 * read-log — design skeleton (T022)
 *
 * Purpose
 * ───────
 * Domain layer that sits on top of storage.ts and turns the popup's
 * "user clicked the Read button" event into a persisted DailyLog entry that
 * downstream modules can consume:
 *   - goal-tracker (T025–T027)   — needs today's count, streak, by-difficulty
 *                                  progress, and "did the user already log
 *                                  this URL today?" for the dedupe banner.
 *   - monthly-report (T028–T030) — needs range queries (last 30 days, by
 *                                  month boundary) and group-by-host /
 *                                  group-by-difficulty rollups.
 *   - popup.ts                   — needs a single recordRead() entry point
 *                                  that orchestrates detect → score → write
 *                                  so the UI layer stays thin.
 *
 * Why a dedicated module instead of inlining into popup.ts?
 *   popup.ts at HEAD reimplements the storage shape, the daily-key formatter,
 *   and the detect→score→append pipeline inline. That works for a single
 *   caller but blocks T025+ (goal-tracker) from reusing the same dedupe and
 *   query rules. Splitting the concern out also lets the same recordRead()
 *   be reachable from a future content-script context-menu entry without
 *   duplicating the orchestration.
 *
 * Boundary with storage.ts
 *   storage.ts owns the *physical* schema (key namespacing, JSON shape,
 *   chrome.storage I/O, normalisation of partial records). read-log.ts owns
 *   the *domain* rules layered on top:
 *     - dedupe window (one URL per day per host, configurable)
 *     - difficulty enrichment (calls scoreActiveTab via injected port)
 *     - range queries (loadRange(from, to))
 *     - aggregates (countByDifficulty, countByHost, streakDays)
 *   Storage primitives stay in storage.ts so direct callers (resetAll,
 *   exportAll, importAll) keep working unchanged.
 *
 * Orchestration contract
 * ──────────────────────
 * recordRead() takes a ReadLogPorts object so popup.ts can inject the live
 * chrome.tabs / chrome.scripting paths and tests can inject deterministic
 * fakes. The port surface is intentionally narrow: detect → optional score
 * → append. No DOM, no i18n, no UI state — the popup keeps responsibility
 * for spinners and "logged!" toasts.
 *
 *   const result = await recordRead({
 *     detect: detectActiveArticle,
 *     score:  scoreActiveTab,
 *     now:    () => Date.now(),
 *   });
 *
 * Result is a discriminated union so the UI can render each path:
 *   - "logged"            → entry stored, return updated DailyLog
 *   - "duplicate"         → URL already logged today, return existing entry
 *   - "rejected"          → article-detect refused (host on reject list)
 *   - "unsupported"       → no chrome.tabs (test / about:blank popup)
 * No throws. Anything unexpected collapses to { kind: "unsupported" } so the
 * popup button can safely re-enable itself in a finally{}.
 *
 * Dedupe rule
 * ───────────
 * Same URL within the same calendar day = duplicate. We compare the canonical
 * URL string (already trimmed by article-detect.classifyUrl) plus the local
 * date key. Choosing "same day" over "last N minutes" matches the user mental
 * model ("I read 3 articles today"), avoids surprising double-counts when the
 * user re-opens a long article, and aligns with how goal-tracker phrases its
 * daily goal. The rule is intentionally not configurable in v1 — the surface
 * area of "what counts as the same article" is large enough that we want real
 * usage data before exposing it as a Setting.
 *
 * Range queries (for monthly-report)
 * ──────────────────────────────────
 * loadRange(from, to) enumerates daily_log_* keys via storage.listDailyLogKeys
 * and filters in-memory. chrome.storage.local fits ~5 MB and a daily log
 * entry is well under 1 KB, so even a heavy user (50 entries/day × 365 days)
 * stays under 20 MB worth of *uncompressed* JSON — comfortably bounded for
 * an in-memory filter. Pagination is therefore deferred until SPEC-mandated
 * usage data says otherwise.
 *
 * Privacy / SPEC.md compliance
 * ────────────────────────────
 *   - Reads / writes go through storage.ts which already targets
 *     chrome.storage.local only. No fetch, no message-passing off-device.
 *   - URLs and titles are stored verbatim (already user-visible in their
 *     own history). No additional fingerprinting derived from them.
 *   - Difficulty enrichment is *optional* and lazy: when score() returns
 *     undefined the entry is stored without the difficulty field rather
 *     than guessing. Aligns with difficulty-score's "unknown" contract.
 *
 * Failure mode
 * ────────────
 *   - recordRead() never throws. score() / detect() errors are caught and
 *     either degrade (difficulty omitted) or collapse to "unsupported".
 *   - undoLastRead() returns false when the day's log is empty; callers
 *     use that to hide the Undo button rather than relying on an exception.
 *   - loadRange() with an inverted (from > to) range returns [] rather
 *     than throwing; matches how monthly-report builds its window.
 *
 * Test surface (T024)
 * ───────────────────
 * Pure helpers — isSameDayDuplicate, summarizeLog, groupByHost,
 * groupByDifficulty, streakDays — are exported individually so T024 can
 * table-test them against synthetic DailyLog fixtures without a chrome
 * runtime. The async seams (recordRead, undoLastRead, loadRange) take a
 * ReadLogPorts / clock so the same tests can drive them with in-memory
 * fakes layered over the storage.ts wrappers.
 */

import type {
  DailyLog,
  DailyLogEntry,
  DifficultyPref,
} from "./storage.js";
import type {
  ArticleCandidate,
  ArticleDetection,
} from "./article-detect.js";
import type { Difficulty } from "./difficulty-score.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome of recordRead(). Discriminated so popup.ts can render each path
 * without re-parsing storage state.
 */
export type RecordReadResult =
  | { kind: "logged"; entry: DailyLogEntry; log: DailyLog }
  | { kind: "duplicate"; entry: DailyLogEntry; log: DailyLog }
  | { kind: "rejected"; reason: ArticleDetection }
  | { kind: "unsupported" };

/**
 * Injected ports so recordRead() can be driven in tests without chrome.*.
 *   - detect: returns an ArticleDetection (article-detect.detectActiveArticle)
 *   - score:  returns a Difficulty bucket or undefined (popup's scoreActiveTab)
 *   - now:    pluggable clock for deterministic ts and date-key formatting
 */
export interface ReadLogPorts {
  detect: () => Promise<ArticleDetection>;
  score?: (article: ArticleCandidate) => Promise<Difficulty | undefined>;
  now?: () => number;
}

/** Per-difficulty rollup used by goal-tracker progress bars. */
export interface DifficultyBreakdown {
  easy: number;
  medium: number;
  hard: number;
  unknown: number;
}

/** Per-host rollup used by monthly-report's "top sites" view. */
export interface HostBreakdown {
  host: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cap on entries kept inside a single DailyLog. Past this we drop the oldest
 * to keep one day's record from blowing out chrome.storage.local. 200 is the
 * smallest round number above "a heavy reader's plausible day"; can be lifted
 * once SPEC-grade usage data exists.
 */
export const MAX_ENTRIES_PER_DAY = 200;

/**
 * Window used by streakDays(): the streak breaks if there is a calendar day
 * with zero logged reads between today and the start of the streak. Kept as
 * a constant so goal-tracker (T025) can reference the same definition.
 */
export const STREAK_TOLERANCE_DAYS = 0;

// ---------------------------------------------------------------------------
// Pure helpers — T023 implements, T024 tests
// ---------------------------------------------------------------------------

/**
 * Return true when `candidate` matches any entry in `log` by canonical URL.
 * Comparison is case-sensitive on the URL string (URLs already normalised by
 * article-detect.classifyUrl) so trivially different casings are not merged.
 */
export declare function isSameDayDuplicate(
  log: DailyLog,
  candidate: ArticleCandidate,
): boolean;

/**
 * Roll a DailyLog up into a DifficultyBreakdown. Entries with no difficulty
 * field fall into the `unknown` bucket — never silently re-classified.
 */
export declare function groupByDifficulty(log: DailyLog): DifficultyBreakdown;

/**
 * Roll up by lowercased hostname. Result is sorted desc by count, asc by host
 * for ties so monthly-report renders are stable across renders.
 */
export declare function groupByHost(log: DailyLog): HostBreakdown[];

/**
 * Return the current daily streak ending today (inclusive). `logsByDate` is a
 * Map<dateKey, DailyLog> covering at least the streak window. A streak counts
 * any day with count >= 1. STREAK_TOLERANCE_DAYS lets a future setting allow
 * "miss one day" without breaking the streak; v1 keeps it at 0.
 */
export declare function streakDays(
  logsByDate: ReadonlyMap<string, DailyLog>,
  today: Date,
): number;

/**
 * Compact one DailyLog into the shape goal-tracker shows on the popup:
 * total count, difficulty breakdown, and whether the daily goal is met.
 */
export declare function summarizeLog(
  log: DailyLog,
  dailyGoal: number,
  pref: DifficultyPref,
): {
  count: number;
  goalMet: boolean;
  byDifficulty: DifficultyBreakdown;
};

// ---------------------------------------------------------------------------
// Async seams — T023 implements, T024 tests with in-memory storage fakes
// ---------------------------------------------------------------------------

/**
 * Orchestrate detect → optional score → append. Never throws. Dedupes by
 * same-day URL match. When `ports.score` is omitted (e.g. tests) the entry
 * is stored without a difficulty field, mirroring difficulty-score's
 * "unknown" contract.
 */
export declare function recordRead(ports: ReadLogPorts): Promise<RecordReadResult>;

/**
 * Remove the most recent entry from today's log. Returns the updated log,
 * or null when there was nothing to remove. Used by the popup's "おっと、
 * 取り消し" affordance immediately after recordRead() so the user can fix a
 * mistaken click without opening Options.
 */
export declare function undoLastRead(now?: () => number): Promise<DailyLog | null>;

/**
 * Load DailyLogs in `[from, to]` inclusive, keyed by date string
 * (storage.formatDateKey). Days with no log are omitted from the result map
 * rather than returned as empty so callers can distinguish "no data" from
 * "data with zero entries" if that distinction ever matters.
 *
 * Inverted ranges (from > to) return an empty Map without throwing.
 */
export declare function loadRange(
  from: Date,
  to: Date,
): Promise<Map<string, DailyLog>>;
