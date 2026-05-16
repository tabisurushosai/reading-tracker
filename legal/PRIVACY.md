# プライバシーポリシー / Privacy Policy

最終更新日 / Last updated: 2026-05-17

---

## 日本語

### 概要
「読書記録 (reading-tracker)」(以下「本拡張機能」) は、ユーザーのプライバシーを最大限尊重して設計されています。本拡張機能は **個人情報を一切収集せず、外部サーバーへ送信しません**。

### 取得・保存するデータ
本拡張機能がローカル (`chrome.storage.local`) に保存するのは、機能提供に必要な以下の情報のみです。

- 閲覧した記事の URL、タイトル、推定難易度、読了時間 (ユーザーが記録操作を行った場合のみ)
- 読書目標、達成状況などのユーザー設定
- 無料お試し開始日時 (`trial_start_ts`)、Premium 解放フラグ (`premium_unlocked`)

これらのデータはすべて **ユーザーのブラウザ内にのみ保存** され、開発者を含む第三者に送信されることはありません。

### 外部送信について
- **アナリティクス・トラッキング**: 一切実装していません。
- **広告**: 配信していません。
- **クラウド同期**: 行いません (`chrome.storage.sync` は使用しません)。
- **外部 API 呼び出し**: 課金処理 (Stripe Checkout) を除き、本拡張機能から外部サーバーへの通信は発生しません。Stripe Checkout 利用時のみ、ユーザーが明示的にアップグレード操作を行った場合に Stripe のページへ遷移します。Stripe におけるデータ取り扱いは Stripe のプライバシーポリシーに従います。

### 子供のプライバシー
本拡張機能は不登校児・発達特性児を含む子供のユーザーが利用することを想定しています。広告、外部リンク誘導、データ収集は一切行わず、子供の安全に最大限配慮しています。

### データの削除
ユーザーは Chrome の拡張機能管理画面から本拡張機能を削除することで、保存されたすべてのデータを完全に削除できます。

### 権限
本拡張機能が要求する Chrome の権限は、機能要件に必要な最小限のものに限定しています。詳細は `manifest.json` を参照してください。

### お問い合わせ
ご質問・ご意見は GitHub Issues にてお願いいたします。

---

## English

### Overview
"reading-tracker" (the "Extension") is designed with maximum respect for user privacy. The Extension **does not collect any personal information and does not transmit any data to external servers**.

### Data We Store
The Extension stores only the following information locally (`chrome.storage.local`), strictly for providing its features:

- URL, title, estimated difficulty, and reading time of articles you read (only when you explicitly record them)
- Your reading goals and progress
- Trial start timestamp (`trial_start_ts`) and Premium unlock flag (`premium_unlocked`)

All such data is **stored only within your browser** and is never transmitted to the developer or any third party.

### External Transmissions
- **Analytics / Tracking**: Not implemented.
- **Advertising**: None.
- **Cloud sync**: Not used (`chrome.storage.sync` is not used).
- **External API calls**: Except for payment processing (Stripe Checkout), the Extension does not communicate with any external server. Only when the user explicitly initiates an upgrade, the user is redirected to Stripe Checkout. Data handling at Stripe follows Stripe's own privacy policy.

### Children's Privacy
The Extension is intended for children including those who do not attend school regularly and those with developmental differences. No advertisements, no external link promotions, and no data collection are conducted, with utmost consideration for child safety.

### Data Deletion
Users can completely delete all stored data by uninstalling the Extension from Chrome's extension management page.

### Permissions
The Chrome permissions requested by the Extension are kept to the minimum necessary for its features. See `manifest.json` for details.

### Contact
Please contact us via GitHub Issues for any questions or feedback.
