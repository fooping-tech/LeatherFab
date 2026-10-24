# CLAUDE.md

LeatherFab — TypeFab をフォークした、ブラウザで動く革製品設計 CAD（型紙・縫い穴・レーザー加工 SVG）。公開 URL（予定）: https://fooping-tech.github.io/LeatherFab/

## 作業の進め方

1. 作業前に `README.md` と `docs/roadmap.md`（既知の制約・フェーズ）、`docs/testing.md`（検証済み／未検証の境界）を読む。
2. 形状処理を変えたら `tests/` にテストを足し、`npm test` と `npm run build` を通す。実機加工していないことを「検証済み」と書かない。
3. 利用者向けの仕様が変わったら `README.md` を更新する。設計が変わったら `docs/architecture.md` `docs/data-model.md` `docs/stitch-engine.md` を更新する。
4. `project.leather.schemaVersion` を上げる変更では `validateLeather()` に移行を追加し、旧ファイルが開けることをテストする。

## 開発コマンド

Node.js 22 以降。

```sh
npm ci
npm run dev
npm test
npm run build
npm run preview
node scripts/samples.mjs
```

ブラウザ確認は Playwright（`~/.npm/_npx/*/node_modules/playwright` のキャッシュ版）を Node スクリプトから使った実績がある。`npm run preview` は 127.0.0.1:4173。

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` / `src/main.js` | エディタ本体（TypeFab 由来、5,000 行超）。LeatherFab のフックは `leather.` で grep できる |
| `src/leather-ui.js` | 革パーツの UI 拡張層（ツールバー・プロパティ・オーバーレイ・加工チェック・書き出し・辺クリック） |
| `src/leather/model.js` | LeatherPart / StitchLine / FoldLine / Hardware / StitchJoint の定義・検証・`remapItems` |
| `src/leather/stitch.js` | 縫い穴エンジン（弧長/弦長、fit/fixed/count、角、穴形状）。純粋関数 |
| `src/leather/polyline.js` | 弧長パラメータ化・接線・角検出・内側オフセット・スライス |
| `src/leather/derive.js` | 依存エンジン: 外形アイテム → 派生要素、縫合、設計ルール検査 |
| `src/leather/manufacturing.js` | 加工属性グループ、カーフ、加工前検証、SVG 書き出し |
| `src/leather/hardware.js` / `templates.js` | 金具プリセット、AirTag・カードケースのテンプレート |
| `src/geometry.js` `path.js` `cad.js` `polygon.js` `operations.js` ほか | TypeFab の CAD コア（無変更）。`project.js` だけ `leather` の検証を追加 |
| `tests/` | `node:test`。`stitch` `leather` `svg-verify` が LeatherFab 分 |
| `samples/` | テンプレートから生成した JSON と SVG |
| `docs/` | 設計・テスト・競合調査 |

## 守るべき前提

- TypeFab のモジュールは原則変更しない。革固有の処理は `src/leather/` と `src/leather-ui.js` に置く。
- 派生ジオメトリ（縫い穴座標）を保存しない。常にパラメータから再計算する。無効な参照は `issues` に出し、黙って形状を作らない。
- SVG は mm 単位・`viewBox` 付き・パスのみ。加工属性は `data-operation` のグループで明示し、線色に依存させない。
- 材料のレーザー適性は `MATERIALS` の値どおりに表示し、不明な材料を「適」としない。
- 保存済みプロジェクト（TypeFab v1/v2、`leather.schemaVersion: 1`）の互換性を壊さない。
- `vite.config.js` の `base: "/LeatherFab/"` は Pages のパス。変更しない。
- フォント・プロジェクトを外部に送信しない。
