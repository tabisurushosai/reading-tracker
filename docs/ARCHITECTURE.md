# Architecture — reading-tracker

Chrome Manifest V3 拡張機能のコンポーネント構成を可視化したドキュメント。
ファイル単位ではなく「役割の層」で捉えるためのリファレンス。

## レイヤー構成

- **Entry layer** — `manifest.json` が宣言する UI / service worker のエントリポイント
  (popup, options, background)。
- **Domain layer** — 副作用を持たない純粋ロジック (記事検出、難易度算定、読書記録、
  目標トラッカー、月次レポート)。テスト容易性のためここに集約する。
- **Infrastructure layer** — Chrome 拡張 API への薄いラッパ
  (`storage.ts` = chrome.storage.local, `i18n.ts` = chrome.i18n)。
- **Premium layer** — 7 日トライアル / Stripe Checkout 解放判定
  (`premium.ts`, `upgrade.ts`)。

## コンポーネント図

```mermaid
flowchart TB
  subgraph Chrome["Chrome 拡張ランタイム"]
    direction TB
    subgraph Entry["Entry layer (manifest.json)"]
      Popup["popup.html / popup.ts<br/>(toolbar action)"]
      Options["options.html / options.ts<br/>(options_ui)"]
      Background["background.ts<br/>(service_worker)"]
    end

    subgraph Domain["Domain layer (pure logic)"]
      ArticleDetect["article-detect.ts"]
      Difficulty["difficulty-score.ts"]
      ReadLog["read-log.ts"]
      GoalTracker["goal-tracker.ts"]
      MonthlyReport["monthly-report.ts"]
    end

    subgraph Premium["Premium layer"]
      PremiumMod["premium.ts<br/>(trial / unlock 判定)"]
      Upgrade["upgrade.ts<br/>(Stripe Checkout 連携)"]
    end

    subgraph Infra["Infrastructure layer"]
      Storage["storage.ts<br/>(typed chrome.storage.local)"]
      I18n["i18n.ts<br/>(chrome.i18n helper)"]
    end
  end

  subgraph ChromeAPI["Chrome platform APIs"]
    direction TB
    StorageAPI[("chrome.storage.local")]
    I18nAPI[("chrome.i18n")]
    TabsAPI[("chrome.tabs / scripting")]
    RuntimeAPI[("chrome.runtime")]
  end

  subgraph External["External / static"]
    Locales[/"_locales/{ja,en}/messages.json"/]
    Stripe(("Stripe Checkout<br/>(外部リンク)"))
  end

  Popup --> ArticleDetect
  Popup --> Difficulty
  Popup --> PremiumMod
  Popup --> I18n
  Popup --> Storage

  Options --> PremiumMod
  Options --> I18n
  Options --> Storage

  Background --> Storage
  Background --> RuntimeAPI

  ReadLog --> Difficulty
  GoalTracker --> Storage
  MonthlyReport --> Storage
  PremiumMod --> Storage
  Upgrade --> Storage
  Upgrade --> Stripe

  Storage --> StorageAPI
  I18n --> I18nAPI
  I18n --> Locales
  Popup --> TabsAPI
  ArticleDetect -. "scripting.executeScript で評価" .-> TabsAPI

  classDef entry fill:#1d4ed8,stroke:#1e3a8a,color:#fff;
  classDef domain fill:#0f766e,stroke:#134e4a,color:#fff;
  classDef infra fill:#7c3aed,stroke:#5b21b6,color:#fff;
  classDef premium fill:#b45309,stroke:#78350f,color:#fff;
  classDef api fill:#374151,stroke:#111827,color:#fff;
  classDef ext fill:#9ca3af,stroke:#4b5563,color:#fff;

  class Popup,Options,Background entry;
  class ArticleDetect,Difficulty,ReadLog,GoalTracker,MonthlyReport domain;
  class Storage,I18n infra;
  class PremiumMod,Upgrade premium;
  class StorageAPI,I18nAPI,TabsAPI,RuntimeAPI api;
  class Locales,Stripe ext;
```

## データフロー (代表例: 「読んだ」ボタン押下)

```mermaid
sequenceDiagram
  participant U as User
  participant P as popup.ts
  participant AD as article-detect.ts
  participant DS as difficulty-score.ts
  participant RL as read-log.ts
  participant S as storage.ts
  participant CS as chrome.storage.local

  U->>P: popup を開く
  P->>AD: detectActiveArticle(activeTab)
  AD-->>P: ArticleCandidate
  P->>DS: scoreArticle(text)
  DS-->>P: Difficulty
  U->>P: 「読んだ」クリック
  P->>RL: appendEntry(url, difficulty)
  RL->>S: saveDailyLog(date, entry)
  S->>CS: set({ "daily_log_YYYY-MM-DD": ... })
  CS-->>S: ok
  S-->>RL: ok
  RL-->>P: ok
  P-->>U: カウント更新 + i18n メッセージ
```

## 設計上の不変条件

- **個人情報は外部送信しない**: ネットワーク I/O は `Upgrade → Stripe Checkout` の
  外部リンク遷移のみ。Domain / Infrastructure 層からの fetch は禁止。
- **service worker は短時間**: `background.ts` は install / update イベント中心、
  長時間 keep-alive 禁止 (MV3 要件)。
- **schemaVersion で前方互換**: `Settings.schemaVersion` を経由して旧バージョンの
  設定を吸収。`storage.ts` の loader が defaults とマージして返す。
- **i18n は全文字列を経由**: UI 文字列は必ず `chrome.i18n` 経由
  (`_locales/{ja,en}/messages.json`)。manifest の `name` / `description` も
  `__MSG_appName__` / `__MSG_appDesc__` で参照。
- **Premium 判定は単一経路**: trial 期限 / unlock 状態の判定は `premium.ts` のみ。
  popup / options から直接 `chrome.storage` を覗かない。
