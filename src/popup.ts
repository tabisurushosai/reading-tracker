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

function todayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `daily_log_${y}-${m}-${d}`;
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[popup] missing element #${id}`);
  return el as T;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  if (!chrome.tabs?.query) return undefined;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  if (settings && typeof settings === "object") {
    return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings>) };
  }
  return DEFAULT_SETTINGS;
}

async function loadTodayLog(): Promise<DailyLog> {
  const key = todayKey();
  const stored = await chrome.storage.local.get(key);
  const log = stored[key];
  if (log && typeof log === "object" && typeof log.count === "number") {
    return { count: log.count, entries: Array.isArray(log.entries) ? log.entries : [] };
  }
  return { count: 0, entries: [] };
}

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

function isHttpArticle(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

function renderArticle(tab: chrome.tabs.Tab | undefined): { url: string; title: string } | null {
  const titleEl = $<HTMLParagraphElement>("current-article-title");
  const logBtn = $<HTMLButtonElement>("log-read-btn");

  if (!tab || !isHttpArticle(tab.url)) {
    titleEl.textContent = t("popup_no_article");
    logBtn.disabled = true;
    return null;
  }

  const title = tab.title?.trim() || tab.url || "";
  titleEl.textContent = title;
  logBtn.disabled = false;
  return { url: tab.url!, title };
}

function renderStats(log: DailyLog, settings: Settings): void {
  $<HTMLSpanElement>("today-count").textContent = String(log.count);
  $<HTMLSpanElement>("daily-goal").textContent = String(settings.dailyGoal);
}

function flashLogged(): void {
  const msg = $<HTMLParagraphElement>("logged-message");
  msg.hidden = false;
  window.setTimeout(() => {
    msg.hidden = true;
  }, 1600);
}

async function init(): Promise<void> {
  document.documentElement.lang = getLocale().split("-")[0] || "en";
  applyI18n(document);

  const [settings, log, tab] = await Promise.all([
    loadSettings(),
    loadTodayLog(),
    getActiveTab(),
  ]);

  renderStats(log, settings);
  let article = renderArticle(tab);

  $<HTMLButtonElement>("log-read-btn").addEventListener("click", async () => {
    if (!article) return;
    const btn = $<HTMLButtonElement>("log-read-btn");
    btn.disabled = true;
    try {
      const updated = await appendTodayLog({ ...article, ts: Date.now() });
      renderStats(updated, settings);
      flashLogged();
      article = null;
    } catch (err) {
      console.error("[popup] failed to log read", err);
      btn.disabled = false;
    }
  });

  $<HTMLButtonElement>("open-options-btn").addEventListener("click", () => {
    if (chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });

  $<HTMLButtonElement>("view-report-btn").addEventListener("click", () => {
    // Monthly report page is not yet implemented (T028–T030).
    // Fall back to opening the options page so the click is never a dead-end.
    if (chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    console.error("[popup] init failed", err);
  });
});
