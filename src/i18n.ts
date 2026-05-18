/**
 * chrome.i18n helper utilities.
 *
 * Centralizes access to chrome.i18n.getMessage so callers can use a
 * type-checked, string-keyed API and apply translations declaratively to DOM
 * nodes via `data-i18n` / `data-i18n-attr` attributes.
 */

export type MessageKey =
  | "appName"
  | "appDesc"
  | "popup_title"
  | "popup_current_article"
  | "popup_no_article"
  | "popup_difficulty"
  | "popup_difficulty_easy"
  | "popup_difficulty_medium"
  | "popup_difficulty_hard"
  | "popup_log_read"
  | "popup_logged"
  | "popup_today_count"
  | "popup_goal"
  | "popup_open_options"
  | "popup_view_report"
  | "options_title"
  | "options_language"
  | "options_daily_goal"
  | "options_difficulty_pref"
  | "options_theme"
  | "options_theme_auto"
  | "options_theme_light"
  | "options_theme_dark"
  | "options_export"
  | "options_import"
  | "options_import_invalid_json"
  | "options_import_invalid_format"
  | "options_import_schema_mismatch"
  | "options_reset"
  | "options_reset_confirm"
  | "options_saved"
  | "options_premium"
  | "options_premium_unlock"
  | "options_premium_confirm"
  | "options_premium_unavailable_hint"
  | "options_trial_remaining"
  | "options_premium_active"
  | "options_premium_trial_expired"
  | "options_premium_locked"
  | "options_premium_locked_hint"
  | "popup_trial_banner"
  | "popup_trial_expired"
  | "popup_trial_upgrade"
  | "popup_premium_active"
  | "report_title"
  | "report_total_articles"
  | "report_by_difficulty"
  | "report_streak"
  | "common_save"
  | "common_cancel"
  | "common_close";

/**
 * Resolve a localized message. Falls back to the raw key when running outside
 * a Chrome extension context (e.g., during unit tests in plain Node).
 */
export function t(key: MessageKey, substitutions?: string | string[]): string {
  if (typeof chrome === "undefined" || !chrome.i18n?.getMessage) {
    return key;
  }
  const msg = chrome.i18n.getMessage(key, substitutions);
  return msg || key;
}

/** Resolve the active UI locale (e.g., "ja", "en"). */
export function getLocale(): string {
  if (typeof chrome === "undefined" || !chrome.i18n?.getUILanguage) {
    return "en";
  }
  return chrome.i18n.getUILanguage();
}

/**
 * Walks the given root and replaces:
 *   - textContent of elements with `data-i18n="<key>"`
 *   - attributes named in `data-i18n-attr="attr1:key1;attr2:key2"`
 */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n as MessageKey | undefined;
    if (key) el.textContent = t(key);
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((el) => {
    const spec = el.dataset.i18nAttr;
    if (!spec) return;
    for (const pair of spec.split(";")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key as MessageKey));
    }
  });
}
