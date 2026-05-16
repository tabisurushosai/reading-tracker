/**
 * premium — Premium / trial gating (T031)
 *
 * Purpose
 * ───────
 * The extension has three commercial states:
 *   1. Free          — user is past day 7 and has not paid. Sees the basic
 *                      surface only (today's count, current streak, monthly
 *                      grid). This is the SPEC.md "完全無料" baseline.
 *   2. Trial         — user is within 7 days of first install. Sees every
 *                      Premium surface unconditionally so they can evaluate
 *                      the paid feature set before the gate drops.
 *   3. Premium-paid  — `premium_unlocked === true` was written by upgrade.ts
 *                      after the Stripe Checkout return URL. Sees everything,
 *                      forever, with no re-evaluation.
 *
 * storage.ts already owns the persisted primitives (trial_start_ts,
 * premium_unlocked, TrialState) and a low-level hasPremiumAccess() helper.
 * premium.ts sits on top of that and exposes the *domain* questions popup,
 * options, and the monthly report actually ask:
 *
 *   - isPremium(state)              — paid forever, ignores the clock.
 *   - isTrial(state, now)           — not paid, but inside the 7-day window.
 *   - hasPremiumAccess(state, now)  — either of the above; what gates a UI
 *                                     surface from being hidden.
 *   - trialDaysRemaining(...)       — 0..7 for banner copy; ∞ when paid.
 *   - evaluatePremiumStatus(...)    — the composed view callers consume so
 *                                     they don't re-derive the four flags
 *                                     and accidentally disagree (e.g. UI
 *                                     showing "Trial" while a feature gate
 *                                     thinks the trial expired).
 *
 * Why a dedicated module?
 *   storage.ts has hasPremiumAccess()/trialDaysRemaining() because it owns the
 *   raw TrialState shape. But the caller surface ("am I in trial?", "do I have
 *   access right now?", "how do I render the banner?") is a separate concern
 *   that crosses popup / options / monthly-report / future Premium-gated
 *   surfaces. Centralizing it here means T032 (UI gate) and T033 (upgrade
 *   flow) both bind to one rule for "the user has Premium access right now"
 *   and there is exactly one place to change if SPEC.md ever shifts (e.g.
 *   trial length, grace period after lapse, refund handling).
 *
 * Boundary with storage.ts
 *   storage.ts: persists & normalizes the bytes (TrialState shape, default
 *     trial_start_ts seed, premium_unlocked writes, raw access predicate).
 *   premium.ts: domain composition over those bytes, install-time seed
 *     guarantee (ensureTrialStarted), pure formatters callers can render
 *     without re-implementing the predicate.
 *
 * Boundary with background.ts
 *   background.ts already seeds trial_start_ts inside onInstalled. premium.ts
 *   exposes ensureTrialStarted() so future code paths (popup defensive seed,
 *   options "reset trial" debug action) can re-use the *exact* same rule
 *   instead of re-implementing the typeof-number check inline.
 *
 * Boundary with upgrade.ts (T033)
 *   upgrade.ts owns the network/Stripe side. premium.ts owns the local state
 *   flip (markPremiumUnlocked). Splitting them means upgrade.ts can be tested
 *   without storage and premium.ts can be tested without a network shim.
 *
 * Failure mode
 * ────────────
 *   - loadPremiumStatus() never throws. Storage errors → "free, expired
 *     trial" because the safe default is to lock Premium surfaces, not unlock
 *     them. That matches SPEC.md's monetization intent (don't give Premium
 *     access for free due to a flaky read).
 *   - ensureTrialStarted() swallows write errors. If we can't persist the
 *     seed we still return a finite `now` to callers so the in-memory copy
 *     of the state is usable for this session.
 *   - markPremiumUnlocked() swallows write errors. Caller (upgrade.ts) will
 *     poll-and-confirm via loadTrialState anyway.
 *
 * Test surface (covered by the upcoming Premium UI tests; T031 is the unit
 * surface itself — pure helpers + a single async seam wrapped behind ports).
 *
 * Pure helpers — evaluatePremiumStatus, formatTrialBannerCopy — are exported
 * individually so they can be table-tested with synthetic TrialState fixtures
 * and a fixed `now`. loadPremiumStatus / ensureTrialStarted /
 * markPremiumUnlocked take a PremiumPorts so a fake chrome.storage.local can
 * be layered in without touching the global (mirrors the goal-tracker.ts
 * installStorageFake pattern).
 *
 * Privacy / SPEC.md compliance
 * ────────────────────────────
 *   - All state is read from chrome.storage.local; no network call, no
 *     telemetry, no remote license check (SPEC.md "個人情報の収集・外部送信
 *     なし"). The Stripe purchase confirmation lives in upgrade.ts and that
 *     module is the only network boundary.
 *   - No PII is generated here — trial_start_ts is a timestamp, nothing else.
 */

import {
  TRIAL_DAYS,
  DAY_MS,
  loadTrialState,
  setPremiumUnlocked,
  type TrialState,
} from "./storage.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Composed Premium view consumed by popup / options / monthly-report.
 * Callers should depend on this shape rather than re-deriving the predicate
 * from TrialState; that keeps "is gated?" semantics in exactly one place.
 */
export interface PremiumStatus {
  /** True iff the user has paid (premium_unlocked === true). */
  isPremium: boolean;
  /** True iff the user is inside the 7-day trial AND has not paid. */
  isTrial: boolean;
  /** True iff isPremium || isTrial — the single gate predicate. */
  hasAccess: boolean;
  /**
   * 0..TRIAL_DAYS while trial is active and unpaid; 0 once trial elapsed and
   * unpaid; Number.POSITIVE_INFINITY when paid. Banner copy logic in popup.ts
   * branches on these three regions.
   */
  trialDaysRemaining: number;
  /**
   * Snapshot of the underlying state at evaluation time. Exposed so callers
   * can show debug info ("trial started: YYYY-MM-DD") in options without
   * re-loading storage. Treat as read-only.
   */
  state: TrialState;
  /** ms-since-epoch when this status was computed (now port output). */
  evaluatedAt: number;
}

/** Banner copy intent for popup / options. View layer maps to i18n strings. */
export type TrialBannerKind =
  /** Paid forever; no banner needed (caller may skip rendering). */
  | "premium"
  /** Inside trial window; show "X days left in trial" upgrade CTA. */
  | "trial-active"
  /** Trial elapsed, unpaid; show "Upgrade for full access" CTA. */
  | "trial-expired";

export interface TrialBannerCopy {
  kind: TrialBannerKind;
  /** Days to mention in copy. 0 for premium / expired; 1..TRIAL_DAYS otherwise. */
  daysRemaining: number;
}

/**
 * Dependency seam so the async surfaces can be driven with an in-memory
 * chrome.storage.local fake during tests. Production callers pass nothing
 * and the defaults route through storage.ts.
 */
export interface PremiumPorts {
  /** Pluggable `now()` so tests can pin a deterministic timestamp. */
  now?: () => number;
  /** Pluggable trial loader so tests can short-circuit storage. */
  loadTrialState?: () => Promise<TrialState>;
  /** Pluggable premium writer so tests can observe the flip. */
  setPremiumUnlocked?: (unlocked: boolean) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure predicates
// ---------------------------------------------------------------------------

function safeNow(now: number): number {
  return Number.isFinite(now) ? now : Date.now();
}

function safeTrialStart(state: TrialState, fallbackNow: number): number {
  return Number.isFinite(state.trial_start_ts) ? state.trial_start_ts : fallbackNow;
}

/** True iff the user has paid Premium. Ignores the clock. */
export function isPremium(state: TrialState): boolean {
  return state.premium_unlocked === true;
}

/** True iff inside the 7-day trial and not yet paid. */
export function isTrial(state: TrialState, now: number = Date.now()): boolean {
  if (isPremium(state)) return false;
  const t = safeNow(now);
  const elapsed = t - safeTrialStart(state, t);
  return elapsed >= 0 && elapsed < TRIAL_DAYS * DAY_MS;
}

/** Single gate predicate: paid OR trial. UI uses this to decide visibility. */
export function hasPremiumAccess(state: TrialState, now: number = Date.now()): boolean {
  return isPremium(state) || isTrial(state, now);
}

/**
 * Days remaining in the 7-day trial. Returns ∞ when paid (so callers can use
 * a single numeric comparison) and 0 once the trial has elapsed.
 */
export function trialDaysRemaining(state: TrialState, now: number = Date.now()): number {
  if (isPremium(state)) return Number.POSITIVE_INFINITY;
  const t = safeNow(now);
  const start = safeTrialStart(state, t);
  const elapsed = t - start;
  if (elapsed < 0) return TRIAL_DAYS;
  const remainingMs = TRIAL_DAYS * DAY_MS - elapsed;
  if (remainingMs <= 0) return 0;
  return Math.min(TRIAL_DAYS, Math.ceil(remainingMs / DAY_MS));
}

/**
 * Compose every Premium-relevant flag in one pass so callers never disagree
 * (e.g., banner says "1 day left" while a feature gate already locked).
 */
export function evaluatePremiumStatus(state: TrialState, now: number = Date.now()): PremiumStatus {
  const evaluatedAt = safeNow(now);
  const paid = isPremium(state);
  const inTrial = !paid && isTrial(state, evaluatedAt);
  return {
    isPremium: paid,
    isTrial: inTrial,
    hasAccess: paid || inTrial,
    trialDaysRemaining: trialDaysRemaining(state, evaluatedAt),
    state,
    evaluatedAt,
  };
}

/**
 * Decide which banner the popup should show. Pure mapping so the view layer
 * only needs to translate `kind` → an i18n string.
 */
export function formatTrialBannerCopy(status: PremiumStatus): TrialBannerCopy {
  if (status.isPremium) return { kind: "premium", daysRemaining: 0 };
  if (status.isTrial) {
    const days = Number.isFinite(status.trialDaysRemaining)
      ? Math.max(1, Math.min(TRIAL_DAYS, status.trialDaysRemaining))
      : TRIAL_DAYS;
    return { kind: "trial-active", daysRemaining: days };
  }
  return { kind: "trial-expired", daysRemaining: 0 };
}

// ---------------------------------------------------------------------------
// Async seams
// ---------------------------------------------------------------------------

/**
 * Load the persisted trial state and compose the PremiumStatus view. Never
 * throws — storage failures collapse to a "free, expired trial" status so
 * Premium surfaces stay locked on a flaky read (safe-default monetization).
 */
export async function loadPremiumStatus(ports: PremiumPorts = {}): Promise<PremiumStatus> {
  const now = (ports.now ?? Date.now)();
  const evaluatedAt = safeNow(now);
  const load = ports.loadTrialState ?? loadTrialState;
  let state: TrialState;
  try {
    state = await load();
  } catch {
    state = { trial_start_ts: evaluatedAt - TRIAL_DAYS * DAY_MS, premium_unlocked: false };
  }
  return evaluatePremiumStatus(state, evaluatedAt);
}

/**
 * Seed `trial_start_ts` on first run if storage doesn't already have a finite
 * number. background.ts already does this inside onInstalled; this helper
 * exists so popup / options can defensively call it on cold start without
 * duplicating the typeof-number check.
 *
 * Returns the trial_start_ts that is now considered authoritative (either
 * the existing value or the freshly seeded `now`). Never throws — write
 * failures fall through but the caller still gets a usable in-memory value.
 */
export async function ensureTrialStarted(ports: PremiumPorts = {}): Promise<number> {
  const now = (ports.now ?? Date.now)();
  const evaluatedAt = safeNow(now);
  const load = ports.loadTrialState ?? loadTrialState;
  let state: TrialState;
  try {
    state = await load();
  } catch {
    state = { trial_start_ts: evaluatedAt, premium_unlocked: false };
  }
  if (Number.isFinite(state.trial_start_ts) && state.trial_start_ts > 0) {
    return state.trial_start_ts;
  }
  try {
    await chrome.storage.local.set({ trial_start_ts: evaluatedAt });
  } catch {
    // Best-effort: in-memory value is still usable for this session.
  }
  return evaluatedAt;
}

/**
 * Flip the persistent paid flag. upgrade.ts (T033) calls this after the
 * Stripe Checkout return URL confirms a successful purchase. Swallows write
 * errors because upgrade.ts already polls loadTrialState to verify; better
 * to retry than to surface an exception in the upgrade flow.
 */
export async function markPremiumUnlocked(unlocked: boolean = true, ports: PremiumPorts = {}): Promise<void> {
  const write = ports.setPremiumUnlocked ?? setPremiumUnlocked;
  try {
    await write(unlocked);
  } catch {
    // Caller (upgrade.ts) will retry via loadTrialState verification.
  }
}
