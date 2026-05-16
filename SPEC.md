# 読書記録 (reading-tracker)

## 概要
Web記事の読書記録、難易度別読解進捗

## カテゴリ
教育

## ターゲット
- 不登校児・発達特性児 + その保護者
- 教育支援者、療育関係者、放課後等デイサービス職員
- 一般大人 (集中困難・感覚過敏等を持つ人)
- 英語圏 Homeschool 市場 (日英対応必須)

## 技術スタック
- Manifest V3 (manifest_version: 3)
- TypeScript + Vite (`npm run build` で release ZIP 生成)
- chrome.storage.local (個人情報外部送信なし)
- chrome.i18n API (`_locales/ja`, `_locales/en` 完備、messages.json で全文字列管理)
- アイコン: 16, 48, 128 px (icons/)

## コア機能
article-detect,difficulty-score,read-log,goal-tracker,monthly-report

## 収益モデル
- 基本機能: 完全無料
- Premium 機能: $3 USD 買い切り (Stripe Checkout 連携)
- Premium 解放範囲: 詳細統計 / 無制限 / カスタマイズ拡張 など
- 7日無料お試し: chrome.storage.local の trial_start_ts で判定

## 制約 (絶対遵守)
- 個人情報の収集・外部送信なし (オフライン動作前提)
- 子供向けに配慮 (広告なし、不適切リンクなし)
- Chrome Web Store ポリシー遵守 (権限最小限、ホスト権限は機能要件分のみ)
- Manifest V3 必須 (V2 不可)
- service_worker は短時間で完了する処理のみ (長時間 keep-alive 禁止)

## ファイル構成 (期待)
```
reading-tracker/
├── manifest.json
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── background.ts (service_worker)
│   ├── popup.html
│   ├── popup.ts
│   ├── popup.css
│   ├── options.html (設定画面、必要なら)
│   ├── options.ts
│   ├── content.ts (content_script、必要なら)
│   └── i18n.ts (chrome.i18n ヘルパ)
├── _locales/
│   ├── ja/messages.json
│   └── en/messages.json
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── legal/
│   ├── PRIVACY.md
│   └── TERMS.md
└── release/
    └── reading-tracker.zip
```

## 完成基準
- TODO.md 全消化
- npm run lint 通過
- npm run build 通過
- release/reading-tracker.zip 生成
- _locales/ja, _locales/en 両方完備
- icons 3サイズ
- legal/PRIVACY.md, TERMS.md
- Chrome Web Store にアップロード可能な状態

## ストア掲載情報案
- 名前 (ja): 読書記録
- 名前 (en): 
- 概要 (132字以内, ja): Web記事の読書記録、難易度別読解進捗
- カテゴリ: 教育
- 言語: 日本語, English
- プライバシーポリシー URL: https://github.com/tabisurushosai/reading-tracker/blob/main/legal/PRIVACY.md
