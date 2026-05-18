# 読書記録 (reading-tracker)

Web 記事の読書時間と難易度を自動で記録する Chrome 拡張機能 (Manifest V3)。
オフライン動作、個人情報の外部送信なし、広告なし。

A Chrome extension (Manifest V3) that automatically tracks reading time and difficulty of web articles.
Works offline, no personal data sent externally, no ads.

---

## 機能一覧 / Features

| 機能 / Feature | 説明 / Description |
| --- | --- |
| article-detect | ページ内の本文を自動検出 / Detects article body in the current page |
| difficulty-score | 文章難易度 (語彙・文長) をスコア化 / Scores difficulty (vocabulary, sentence length) |
| read-log | 読了記事をローカル保存 / Stores read articles in `chrome.storage.local` |
| goal-tracker | 日次/週次の読書目標を管理 / Tracks daily / weekly reading goals |
| monthly-report | 月次サマリー (記事数・難易度分布) / Monthly summary (count, difficulty distribution) |
| i18n | 日本語 / 英語 UI 切替 / Japanese / English UI |

### Premium (買い切り $3 USD)

- 詳細統計 / Detailed statistics
- 設定の export/import / Settings export & import
- 無制限保存 / Unlimited storage
- 7 日間無料お試し / 7-day free trial

---

## 使い方 / Usage

### 日本語

1. Chrome Web Store からインストール、または `release/reading-tracker.zip` を展開してデベロッパーモードで読み込む。
2. 記事ページを開いてツールバーのアイコンをクリック。
3. ポップアップで読了ボタンを押すと、本文・難易度・読書時間が `chrome.storage.local` に記録される。
4. オプションページで目標値や言語を変更できる。

### English

1. Install from the Chrome Web Store, or load `release/reading-tracker.zip` (unzipped) via Developer Mode.
2. Open an article page and click the toolbar icon.
3. Click the "Mark as read" button to save the article body, difficulty score, and reading time to `chrome.storage.local`.
4. Adjust goals and language on the options page.

---

## 開発 / Development

```bash
npm install         # 依存インストール / install dependencies
npm run lint        # TypeScript チェック / type-check
npm run build       # dist/ をビルド / build to dist/
npm run package     # release/reading-tracker.zip 生成 / build the release zip
```

詳細仕様は `SPEC.md`、進捗管理は `TODO.md` / `TODO_PHASE6.md` を参照。
See `SPEC.md` for full spec; `TODO.md` and `TODO_PHASE6.md` for task status.

---

## ライセンス / License

`legal/PRIVACY.md`, `legal/TERMS.md` を参照 / See `legal/PRIVACY.md` and `legal/TERMS.md`.
