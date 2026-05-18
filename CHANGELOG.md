# Changelog

All notable changes to **reading-tracker** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Phase 6 quality-improvement work. These changes are in the working tree and
have not yet been bundled into a new `release/reading-tracker.zip`; the
shipped extension is still 1.0.0.

### Added
- README に日英の機能一覧と使用例を追加 (T101).
- `src/` 配下の helper 関数群に JSDoc を追加 (T102).
- popup / options の全 button / input に `aria-label` を付与しスクリーン
  リーダー対応を強化 (T103).
- popup / options のキーボード操作対応 (auto-focus、Escape での閉じ、
  Tab ナビゲーション) (T104).
- ダークモードおよび `prefers-contrast: more` での高コントラスト対応
  (T105).
- 設定の `export` / `import` 機能。`schemaVersion` 付き envelope で
  互換チェック (T106).
- `tests/` ディレクトリに vitest ベースの単体テスト (storage /
  difficulty-score / article-detect / i18n) を 40 個以上追加 (T110).
- `docs/ARCHITECTURE.md` にコンポーネント図 + データフロー Mermaid を
  追加 (T111).
- GitHub Actions workflow (`.github/workflows/ci.yml`、lint + build + test)
  (T112).
- `CHANGELOG.md` 本ファイルの新設 (T113).

### Changed
- i18n メッセージキーを総点検し、未使用キーを削除。ja / en の整合性 (44
  キー一致) を確認 (T107).
- `popup.openOptionsPage` / `options.saveSettings` など chrome.* API
  呼び出しを try-catch でガード (T108).
- `manifest.json` の `description` を `__MSG_appDesc__` 経由で多言語化
  (`_locales/{ja,en}/messages.json`) (T109).

## [1.0.0] — 2026-05-17

初回 Chrome Web Store 申請版。SPEC.md の「完成基準」を満たし
`release/reading-tracker.zip` を生成済み。

### Added
- Manifest V3 (`manifest_version: 3`) ベースの Chrome 拡張プロジェクト
  雛形 (TypeScript + Vite ビルド、`npm run build` / `npm run package`)。
- `_locales/{ja,en}/messages.json` による日英 i18n と `chrome.i18n`
  ヘルパ (`src/i18n.ts`、`t()` / `applyI18n()` / `getLocale()`、
  `MessageKey` 型で全キー型保証)。
- 拡張アイコン 16 / 48 / 128 px (`icons/`、本+オレンジしおりデザイン)。
- `chrome.storage.local` 型付きラッパ `src/storage.ts`
  (`Settings` / `DailyLog` / `TrialState` の単一情報源、
  `SCHEMA_VERSION` / `TRIAL_DAYS` / `DAILY_LOG_PREFIX` 定数、
  `export/import/reset` ヘルパ、`daily_log_YYYY-MM-DD` キー契約)。
- Service worker `src/background.ts` (`onInstalled` / `onStartup` で
  デフォルト設定 + `trial_start_ts` + `premium_unlocked` を seed)。
- 記事検出 `src/article-detect.ts` (URL 分類 / ホスト拒否リスト /
  `chrome.scripting.executeScript` による本文サンプリング、
  activeTab 最小権限、`MAX_BODY_SAMPLE_CHARS` 上限)。
- 難易度算定 `src/difficulty-score.ts` (日英対応、`detectLanguage` +
  言語別メトリクス、`easy` / `medium` / `hard` / `unknown` バケット、
  例外無し契約のピュア関数)。
- 読書ログ `src/read-log.ts` (日次集計、`groupByDifficulty` /
  `groupByHost`、`streakDays` 算出)。
- 目標トラッカー `src/goal-tracker.ts` (今日達成 / 週次進捗 /
  ストリーク、`shouldFireGoalMetNotification` で 1 日 1 通知契約)。
- 月次レポート `src/monthly-report.ts` (calendar-month ロールアップ、
  日別グリッド / 曜日別 / 月対月比較 / month-bound streak、Premium
  解放範囲は view 露出のみで分岐しない)。
- Popup UI (`src/popup.{html,css,ts}`)、Options UI
  (`src/options.{html,css,ts}`、設定編集 + Premium 状態 +
  export / import / reset)。
- Premium gating `src/premium.ts` (`isPremium` / `isTrial` /
  `hasPremiumAccess` / `trialDaysRemaining` / `evaluatePremiumStatus`)。
- Stripe Checkout 連携 `src/upgrade.ts` ($3 USD 買い切り、
  `chrome.tabs.create` で外部タブへ遷移、拡張内で決済情報は扱わない)。
- 法務文書 `legal/PRIVACY.md`、`legal/TERMS.md` (日英バイリンガル、
  個人情報非収集・外部送信なし、Premium / 7 日無料お試し条項、
  子供のプライバシー配慮)。
- Chrome Web Store 申請用 `release/reading-tracker.zip` と
  `STORE_DESCRIPTION.md`、プロモタイル (440x280)。

### Security
- `chrome.storage.local` のみ使用し外部送信を行わない設計を確立。
  `host_permissions` を一切要求せず、ネットワーク I/O は Stripe
  Checkout への外部タブ遷移のみ。

[Unreleased]: https://github.com/tabisurushosai/reading-tracker/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tabisurushosai/reading-tracker/releases/tag/v1.0.0
