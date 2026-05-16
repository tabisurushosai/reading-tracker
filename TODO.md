# TODO: 読書記録 (reading-tracker)

## Phase 1: 基盤セットアップ (T001-T010)
- [x] T001: package.json (devDeps: typescript, vite, @types/chrome; scripts: build, lint, package)
- [x] T002: tsconfig.json (target ES2020, strict, jsx none)
- [x] T003: vite.config.ts (Chrome 拡張用ビルド設定、entry: popup + background + content)
- [x] T004: manifest.json (V3, name は __MSG_appName__、description は __MSG_appDesc__、default_locale ja、icons 3サイズ、permissions は機能要件最小限)
- [x] T005: _locales/ja/messages.json (appName, appDesc, popup_*, options_* 全項目)
- [x] T006: _locales/en/messages.json (上記の英訳)
- [x] T007: icons/icon16.png, icon48.png, icon128.png (シンプルなデザイン、絵文字風 SVG → PNG 変換)
- [x] T008: src/i18n.ts (chrome.i18n.getMessage ヘルパ)
- [x] T009: src/background.ts (service_worker 雛形、onInstalled で初期化)
- [x] T010: legal/PRIVACY.md, legal/TERMS.md (個人情報非収集、外部送信なし明記)

## Phase 2: UI 基盤 (T011-T015)
- [x] T011: src/popup.html (基本レイアウト、i18n attr)
- [x] T012: src/popup.css (シンプル・アクセシブル、ダークモード対応)
- [x] T013: src/popup.ts (popup を起動時に表示、i18n 適用)
- [ ] T014: src/options.html, options.ts (必要なら、設定UI)
- [ ] T015: src/storage.ts (chrome.storage.local ラッパ、型付き)

## Phase 3: コア機能実装 (T016-T030 = 15タスク、上の features 5個を3タスクずつ分解)
- [ ] T016: article-detect — 設計
- [ ] T017: article-detect — 実装
- [ ] T018: article-detect — テスト・整合
- [ ] T019: difficulty-score — 設計
- [ ] T020: difficulty-score — 実装
- [ ] T021: difficulty-score — テスト・整合
- [ ] T022: read-log — 設計
- [ ] T023: read-log — 実装
- [ ] T024: read-log — テスト・整合
- [ ] T025: goal-tracker — 設計
- [ ] T026: goal-tracker — 実装
- [ ] T027: goal-tracker — テスト・整合
- [ ] T028: monthly-report — 設計
- [ ] T029: monthly-report — 実装
- [ ] T030: monthly-report — テスト・整合

## Phase 4: Premium ゲート (T031-T033)
- [ ] T031: src/premium.ts (trial_start_ts 管理、is_premium / is_trial 判定関数)
- [ ] T032: Premium 機能の UI ゲート (無料: 基本機能のみ、Premium: 詳細統計/無制限)
- [ ] T033: src/upgrade.ts (Stripe Checkout URL 生成、購入後 chrome.storage に premium_unlocked=true)

## Phase 5: 仕上げ (T034-T035)
- [ ] T034: npm run lint 通過、npm run build 通過
- [ ] T035: release/reading-tracker.zip 生成 (manifest + icons + _locales + dist/)
