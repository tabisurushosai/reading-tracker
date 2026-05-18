/**
 * Popup entry point.
 *
 * Boots the popup UI when the toolbar action is clicked:
 *   - applies localized strings via chrome.i18n (data-i18n attributes)
 *   - syncs <html lang> with the active UI locale
 *   - reads the active tab to surface the "current article" placeholder
 *   - reads settings + today's count from chrome.storage.local
 *   - wires up read-log / open-options / view-report buttons
 *
 * Storage schema for read counts is intentionally minimal here; T022–T024
 * (read-log design) will replace this with the canonical structure.
 */

import { applyI18n, getLocale, t } from "./i18n.js";
import {
  detectActiveArticle,
  extractArticleBody,
  type ArticleCandidate,
} from "./article-detect.js";
import { scoreArticle, type Difficulty } from "./difficulty-score.js";
import {
  formatTrialBannerCopy,
  loadPremiumStatus,
  type PremiumStatus,
} from "./premium.js";

interface Settings {
  schemaVersion: number;
  dailyGoal: number;
  difficultyPref: "easy" | "medium" | "hard" | "any";
  theme: "auto" | "light" | "dark";
}

interface DailyLogEntry {
  url: string;
  title: string;
  ts: number;
  difficulty?: Difficulty;
}

interface DailyLog {
  count: number;
  entries: DailyLogEntry[];
}

const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  dailyGoal: 1,
  difficultyPref: "any",
  theme: "auto",
};

/** Format the chrome.storage key for `date`'s daily log (`daily_log_YYYY-MM-DD`). */
function todayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `daily_log_${y}-${m}-${d}`;
}

/** Strongly-typed `getElementById`. Throws if the popup template is missing the id. */
function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[popup] missing element #${id}`);
  return el as T;
}

/** Read user settings, merging stored values over defaults to survive partial records. */
async function loadSettings(): Promise<Settings> {
  let stored: { settings?: unknown };
  try {
    stored = await chrome.storage.local.get("settings");
  } catch {
    return DEFAULT_SETTINGS;
  }
  const settings = stored.settings;
  if (settings && typeof settings === "object") {
    return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings>) };
  }
  return DEFAULT_SETTINGS;
}

/** Load today's read log from chrome.storage.local. Returns an empty log on first run. */
async function loadTodayLog(): Promise<DailyLog> {
  const key = todayKey();
  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.local.get(key);
  } catch {
    return { count: 0, entries: [] };
  }
  const log = stored[key] as Partial<DailyLog> | undefined;
  if (log && typeof log === "object" && typeof log.count === "number") {
    return { count: log.count, entries: Array.isArray(log.entries) ? log.entries : [] };
  }
  return { count: 0, entries: [] };
}

/** Append `entry` to today's log and persist the updated DailyLog. */
async function appendTodayLog(entry: DailyLogEntry): Promise<DailyLog> {
  const key = todayKey();
  const current = await loadTodayLog();
  const next: DailyLog = {
    count: current.count + 1,
    entries: [...current.entries, entry],
  };
  await chrome.storage.local.set({ [key]: next });
  return next;
}

/**
 * Sample the active tab's body and return a Difficulty bucket, or undefined
 * when scoring is not possible (missing tabId, blocked scripting, body too
 * short, mixed-language sample). Never throws — callers fall back to
 * storing the entry without a difficulty field.
 */
async function scoreActiveTab(): Promise<Difficulty | undefined> {
  try {
    if (!chrome.tabs?.query) return undefined;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId !== "number") return undefined;
    const text = await extractArticleBody(tabId);
    if (!text) return undefined;
    const result = scoreArticle({ text });
    return result.difficulty === "unknown" ? undefined : result.difficulty;
  } catch {
    return undefined;
  }
}

/**
 * Paint the "current article" line and toggle the Log Read button. Returns the
 * article unchanged so callers can keep a single reference around for the
 * click handler.
 */
function renderArticle(article: ArticleCandidate | null): ArticleCandidate | null {
  const titleEl = $<HTMLParagraphElement>("current-article-title");
  const logBtn = $<HTMLButtonElement>("log-read-btn");

  if (!article) {
    titleEl.textContent = t("popup_no_article");
    logBtn.disabled = true;
    return null;
  }

  titleEl.textContent = article.title;
  logBtn.disabled = false;
  return article;
}

/** Paint today's count / daily-goal pair shown below the article line. */
function renderStats(log: DailyLog, settings: Settings): void {
  $<HTMLSpanElement>("today-count").textContent = String(log.count);
  $<HTMLSpanElement>("daily-goal").textContent = String(settings.dailyGoal);
}

/**
 * Render the trial / premium banner. Premium-paid users see a small "Premium
 * active" badge; trial users see the days-remaining countdown plus an
 * Unlock-Premium CTA; expired-trial free users see the upgrade CTA only.
 * The CTA opens the options page where the Stripe Checkout button lives.
 */
function renderPremiumBanner(status: PremiumStatus): void {
  const banner = $<HTMLElement>("premium-banner");
  const text = $<HTMLSpanElement>("premium-banner-text");
  const cta = $<HTMLButtonElement>("premium-banner-cta");
  const copy = formatTrialBannerCopy(status);

  banner.classList.remove("popup__banner--premium");

  if (copy.kind === "premium") {
    banner.hidden = false;
    banner.classList.add("popup__banner--premium");
    text.textContent = t("popup_premium_active");
    cta.hidden = true;
    return;
  }

  if (copy.kind === "trial-active") {
    banner.hidden = false;
    text.textContent = t("popup_trial_banner", String(copy.daysRemaining));
    cta.hidden = false;
    cta.textContent = t("popup_trial_upgrade");
    return;
  }

  banner.hidden = false;
  text.textContent = t("popup_trial_expired");
  cta.hidden = false;
  cta.textContent = t("popup_trial_upgrade");
}

/** Briefly show the "logged!" toast after a successful read append. */
function flashLogged(): void {
  const msg = $<HTMLParagraphElement>("logged-message");
  msg.hidden = false;
  window.setTimeout(() => {
    msg.hidden = true;
  }, 1600);
}

/**
 * Open the options page via chrome.runtime, swallowing any platform error so
 * a click never throws into the popup. chrome.runtime.openOptionsPage rejects
 * (or, on some channels, throws synchronously) when the worker is unreachable
 * or the page is mid-reload; we treat that as a no-op rather than a crash.
 */
function safeOpenOptionsPage(): void {
  if (!chrome.runtime?.openOptionsPage) return;
  try {
    const result = chrome.runtime.openOptionsPage();
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch((err) => {
        console.error("[popup] openOptionsPage failed", err);
      });
    }
  } catch (err) {
    console.error("[popup] openOptionsPage threw", err);
  }
}

/**
 * Popup boot sequence: apply localization, load state in parallel, render each
 * surface, then wire button click handlers. Runs once per popup open.
 */
async function init(): Promise<void> {
  document.documentElement.lang = getLocale().split("-")[0] || "en";
  applyI18n(document);

  const [settings, log, detection, premiumStatus] = await Promise.all([
    loadSettings(),
    loadTodayLog(),
    detectActiveArticle(),
    loadPremiumStatus(),
  ]);

  renderStats(log, settings);
  renderPremiumBanner(premiumStatus);
  let article = renderArticle(detection.kind === "article" ? detection.article : null);

  $<HTMLButtonElement>("log-read-btn").addEventListener("click", async () => {
    if (!article) return;
    const btn = $<HTMLButtonElement>("log-read-btn");
    btn.disabled = true;
    try {
      const difficulty = await scoreActiveTab();
      const entry: DailyLogEntry = {
        url: article.url,
        title: article.title,
        ts: Date.now(),
      };
      if (difficulty) entry.difficulty = difficulty;
      const updated = await appendTodayLog(entry);
      renderStats(updated, settings);
      flashLogged();
      article = null;
    } catch (err) {
      console.error("[popup] failed to log read", err);
      btn.disabled = false;
    }
  });

  $<HTMLButtonElement>("open-options-btn").addEventListener("click", () => {
    safeOpenOptionsPage();
  });

  $<HTMLButtonElement>("premium-banner-cta").addEventListener("click", () => {
    safeOpenOptionsPage();
  });

  $<HTMLButtonElement>("view-report-btn").addEventListener("click", () => {
    // Monthly report page is not yet implemented (T028–T030).
    // Fall back to opening the options page so the click is never a dead-end.
    safeOpenOptionsPage();
  });

  // Keyboard support: focus the primary action so Enter activates it immediately,
  // and let Escape close the popup as a quick exit.
  const logBtn = $<HTMLButtonElement>("log-read-btn");
  if (!logBtn.disabled) {
    logBtn.focus();
  } else {
    $<HTMLButtonElement>("open-options-btn").focus();
  }

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      window.close();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    console.error("[popup] init failed", err);
  });
});
