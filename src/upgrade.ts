/**
 * upgrade — Stripe Checkout integration for the $3 Premium unlock (T033).
 *
 * Boundary
 * ────────
 * upgrade.ts is the *only* module in the extension that interacts with the
 * network — and even then, "interaction" is the user manually visiting a
 * Stripe-hosted Payment Link URL we opened in a new browser tab. The
 * extension itself never makes an `fetch`/XHR, never sends PII, and never
 * receives a server response. Stripe collects payment on their hosted page;
 * we only act on the fact that the user came back and clicked "I've completed
 * payment", at which point we flip the local Premium flag via premium.ts.
 *
 * This split is deliberate and SPEC.md-compliant:
 *
 *   - SPEC.md §制約 says "個人情報の収集・外部送信なし (オフライン動作前提)"
 *     and "Chrome Web Store ポリシー遵守 (権限最小限)". By keeping the only
 *     network step on a Stripe-hosted page that the user themselves navigates
 *     to in a normal browser tab, the extension itself stays offline-only
 *     and needs no extra host permissions or `tabs` permission.
 *
 *   - SPEC.md §収益モデル says "Premium 機能: $3 USD 買い切り (Stripe Checkout
 *     連携)" and "7日無料お試し: chrome.storage.local の trial_start_ts で判定".
 *     upgrade.ts owns the Stripe URL; premium.ts owns the trial / unlocked
 *     bookkeeping. T031–T032 already wired the gate; T033 supplies the actual
 *     transition.
 *
 * What this module does NOT do
 * ────────────────────────────
 *   - It does NOT cryptographically verify a Stripe payment. With no backend
 *     and no extra permissions, that's impossible inside an MV3 extension.
 *     Verification is a trust step: after the Stripe-hosted Checkout returns
 *     a "success" page, the user comes back to the extension and clicks
 *     "I've completed payment", and we trust them. The trade-off is an
 *     intentionally simple architecture; SPEC.md prioritizes "no external
 *     API / no PII" over server-side receipt validation.
 *
 *   - It does NOT auto-detect navigation to the Stripe success URL. Doing so
 *     would require either the `tabs` permission (chrome.tabs.onUpdated only
 *     exposes URLs when granted that permission or a matching host permission)
 *     or a content script with a host permission on the Stripe domain. Both
 *     widen the permission surface beyond SPEC.md's "権限最小限" rule.
 *
 *   - It does NOT store the customer's email, Stripe session id, or anything
 *     else returned by Checkout. The only persisted state is the boolean
 *     `premium_unlocked` flag, which is what gates UI surfaces.
 *
 * Public surface
 * ──────────────
 *   buildCheckoutUrl(opts)    — pure URL builder; adds locale + client ref.
 *   isCheckoutUrlAvailable()  — false when STRIPE_PAYMENT_LINK is unset (so
 *                               the options page can hide the Unlock button
 *                               in dev / fork builds where the URL was never
 *                               populated by the maintainer).
 *   openCheckoutTab(ports?)   — creates a new tab pointing at the Stripe URL
 *                               via chrome.tabs.create. Returns the tab id
 *                               (when available) so caller can highlight or
 *                               close it later. Never throws — failures
 *                               collapse to a Promise<null>.
 *   confirmPurchase(ports?)   — flips premium_unlocked = true through
 *                               premium.markPremiumUnlocked, then re-loads
 *                               and returns the resulting PremiumStatus so
 *                               the caller can re-render gated UI from a
 *                               single authoritative value.
 *   runUpgradeFlow(ports?)    — orchestrator: open tab + return a confirm
 *                               handle that callers wire to a button. Keeps
 *                               the two halves of the flow co-located so
 *                               options.ts doesn't have to coordinate them.
 *
 * Test seam
 * ─────────
 * UpgradePorts mirrors the PremiumPorts pattern (now, loadTrialState,
 * setPremiumUnlocked) plus an `openTab` shim so the chrome.tabs.create call
 * can be observed without a real chrome global. This means upgrade.ts can be
 * driven by the in-memory storage fake the goal-tracker.test.ts /
 * monthly-report.test.ts files already use (installStorageFake pattern).
 *
 * Configuration
 * ─────────────
 * STRIPE_PAYMENT_LINK is the Stripe-hosted Payment Link URL. It's a constant
 * here (no remote config, no env var indirection) so the build output is a
 * static asset Chrome Web Store reviewers can audit. Maintainer flips it to
 * the real Payment Link before publishing; the dev placeholder is the empty
 * string, which causes isCheckoutUrlAvailable() to return false and the
 * Unlock button to hide rather than open a broken URL.
 */

import {
  loadPremiumStatus,
  markPremiumUnlocked,
  type PremiumPorts,
  type PremiumStatus,
} from "./premium.js";
import { loadTrialState, setPremiumUnlocked } from "./storage.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Stripe Payment Link URL. Empty in the source tree so a forked / dev build
 * can't accidentally collect payments to the wrong account. Maintainer sets
 * this to the real Payment Link before the production build.
 *
 * Why a Payment Link (not a session created via Stripe Checkout API)?
 *   Creating a session needs a Stripe secret key, which means a backend.
 *   SPEC.md's "個人情報の収集・外部送信なし" rule precludes shipping a
 *   backend the extension calls. Payment Links are pre-configured on the
 *   Stripe dashboard and require zero runtime API calls from us.
 */
export const STRIPE_PAYMENT_LINK = "";

/**
 * URL query parameters Stripe appends to the *return* URL of a successful
 * Checkout. We don't act on them inside the extension (we can't see them
 * without extra permissions), but they're documented here so the success
 * page maintainer knows what's available if they later add a redemption
 * code flow.
 */
export const STRIPE_SUCCESS_QUERY_KEYS = ["session_id"] as const;

/**
 * Locale codes Stripe Checkout accepts. We mirror chrome.i18n.getUILanguage()
 * to keep the Checkout UI in the same language as the rest of the extension.
 * Anything we don't recognize falls back to "auto" (Stripe's default).
 */
const STRIPE_LOCALES = new Set([
  "auto",
  "en",
  "ja",
  "de",
  "es",
  "fr",
  "it",
  "ko",
  "nl",
  "pl",
  "pt",
  "ru",
  "zh",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckoutUrlOptions {
  /**
   * Stripe Checkout locale. Anything outside STRIPE_LOCALES → "auto".
   * Pass the raw chrome.i18n.getUILanguage() ("en-US", "ja"); we strip the
   * region tag because Stripe only accepts the language portion.
   */
  locale?: string;
  /**
   * Stripe `client_reference_id` query parameter. Useful for reconciliation
   * if a future build adds a backend. Pass nothing for the privacy-safe
   * default (omitted).
   */
  clientReferenceId?: string;
}

export interface UpgradePorts extends PremiumPorts {
  /**
   * Pluggable tab opener so tests don't need a real chrome.tabs global. The
   * production default routes through chrome.tabs.create when available, and
   * falls back to window.open for non-extension contexts (e.g., a future
   * standalone page that consumes this module).
   */
  openTab?: (url: string) => Promise<number | null>;
}

/**
 * Handle returned by runUpgradeFlow so callers can wire a confirm button to
 * the same flow that opened the tab without re-deriving the ports.
 */
export interface UpgradeFlowHandle {
  /** Tab id from the openTab call; null when the open failed or returned no id. */
  tabId: number | null;
  /** Confirm-and-flip helper. Idempotent — safe to call from a button click. */
  confirm: () => Promise<PremiumStatus>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function normalizeLocale(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return "auto";
  const lang = raw.toLowerCase().split(/[-_]/)[0];
  return STRIPE_LOCALES.has(lang) ? lang : "auto";
}

function safeBase(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  if (!/^https:\/\//.test(url)) return null;
  return url;
}

/**
 * Build the Stripe Checkout URL with locale + optional client reference id
 * query parameters. Returns null when STRIPE_PAYMENT_LINK is unset (dev /
 * fork build); callers should hide the Unlock button in that case rather
 * than navigate to a broken URL.
 *
 * Pure: no chrome.* access, no Date.now() — safe to unit-test as a
 * fixture-driven function.
 */
export function buildCheckoutUrl(opts: CheckoutUrlOptions = {}): string | null {
  const base = safeBase(STRIPE_PAYMENT_LINK);
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const locale = normalizeLocale(opts.locale);
  if (locale !== "auto") url.searchParams.set("locale", locale);
  if (typeof opts.clientReferenceId === "string" && opts.clientReferenceId.length > 0) {
    url.searchParams.set("client_reference_id", opts.clientReferenceId);
  }
  return url.toString();
}

/**
 * True iff STRIPE_PAYMENT_LINK is populated with an https:// URL. Callers
 * (options.ts T032 wiring) check this before showing the Unlock CTA so a
 * dev / fork build never opens a broken tab.
 */
export function isCheckoutUrlAvailable(): boolean {
  return buildCheckoutUrl() !== null;
}

// ---------------------------------------------------------------------------
// Async seams
// ---------------------------------------------------------------------------

async function defaultOpenTab(url: string): Promise<number | null> {
  try {
    if (typeof chrome !== "undefined" && chrome.tabs?.create) {
      const tab = await chrome.tabs.create({ url, active: true });
      return typeof tab.id === "number" ? tab.id : null;
    }
  } catch {
    // Fall through to window.open below.
  }
  try {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  } catch {
    // Best-effort: opening the tab is not critical to the flow; the user
    // can copy the URL from the options page if they're really stuck.
  }
  return null;
}

/**
 * Open the Stripe Checkout URL in a new browser tab. Returns the new tab's
 * id when chrome.tabs.create supplied one, otherwise null. Never throws —
 * failure to open is logged by the caller (which renders a "copy this URL"
 * fallback) and the upgrade flow continues to be re-tryable.
 */
export async function openCheckoutTab(
  ports: UpgradePorts = {},
  options: CheckoutUrlOptions = {},
): Promise<number | null> {
  const url = buildCheckoutUrl(options);
  if (!url) return null;
  const open = ports.openTab ?? defaultOpenTab;
  try {
    return await open(url);
  } catch {
    return null;
  }
}

/**
 * Mark the user as Premium-paid and return the resulting PremiumStatus.
 *
 * The flip is performed via premium.markPremiumUnlocked (which already
 * swallows write errors) and then we re-load the status so the caller can
 * re-render gated UI from a single authoritative value rather than locally
 * mutating its own copy of PremiumStatus.
 *
 * Trust model: this is the *only* place premium_unlocked transitions to
 * true. There is no remote verification; the assumption is the user has
 * already completed Stripe Checkout in the tab we opened. SPEC.md's
 * privacy stance favors this simplicity over a backend round-trip.
 *
 * Idempotent: calling confirmPurchase twice yields the same end state.
 */
export async function confirmPurchase(ports: UpgradePorts = {}): Promise<PremiumStatus> {
  await markPremiumUnlocked(true, {
    setPremiumUnlocked: ports.setPremiumUnlocked ?? setPremiumUnlocked,
  });
  return loadPremiumStatus({
    now: ports.now,
    loadTrialState: ports.loadTrialState ?? loadTrialState,
  });
}

/**
 * Orchestrator: open the Checkout tab and hand the caller a `confirm()`
 * function bound to the same ports. The two halves of the flow are split
 * intentionally so callers can wire `confirm` to a button click that fires
 * only after the user has actually completed payment.
 *
 * Returns `{ tabId: null, confirm }` when the Stripe Payment Link is not
 * configured; callers should detect this via isCheckoutUrlAvailable() *before*
 * calling runUpgradeFlow to avoid a no-op invocation, but the safe-default
 * here means even if they don't, the flow degrades gracefully.
 */
export async function runUpgradeFlow(
  ports: UpgradePorts = {},
  options: CheckoutUrlOptions = {},
): Promise<UpgradeFlowHandle> {
  const tabId = await openCheckoutTab(ports, options);
  return {
    tabId,
    confirm: () => confirmPurchase(ports),
  };
}

/**
 * Convenience: detect the active UI locale via chrome.i18n.getUILanguage()
 * for callers that don't want to pass it explicitly. Returns "auto" when
 * chrome.i18n is unavailable (non-extension contexts / tests).
 */
export function detectCheckoutLocale(): string {
  try {
    if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) {
      return normalizeLocale(chrome.i18n.getUILanguage());
    }
  } catch {
    // Fall through.
  }
  return "auto";
}
