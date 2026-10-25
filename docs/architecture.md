# LeatherFab アーキテクチャ概要

LeatherFab は TypeFab（https://github.com/fooping-tech/TypeFab）のエディタをフォークした独立アプリです。TypeFab のソース（`src/*.js`）はほぼそのまま再利用し、革固有の機能は `src/leather/`（純粋関数）と `src/leather-ui.js`（UI 拡張層）に分離しています。`main.js` への変更は少数のフック（ツールバー・プロパティ・キャンバスオーバーレイ・加工チェック・書き出し・ポインタ）に限定しています。

```
┌──────────────────────────────── UI Layer ────────────────────────────────┐
│ src/main.js (TypeFab editor)  ←hooks→  src/leather-ui.js (革パーツ UI)   │
└───────────────┬──────────────────────────────┬───────────────────────────┘
                │ items / undo / selection      │ project.leather
┌───────────────▼──────────────┐  ┌────────────▼──────────────────────────┐
│ CAD Geometry Core (TypeFab)  │  │ Leather Domain Core  src/leather/     │
│ geometry.js  flatten 0.02mm  │  │ model.js   LeatherPart / StitchLine / │
│ path.js      Bézier nodes    │  │            FoldLine / Hardware /      │
│ cad.js       offset, fillet  │  │            StitchJoint, schemaVersion │
│ polygon.js   Clipper union   │  │ stitch.js  穴配置エンジン（arc/chord）  │
│ operations.js boolean/resize │  │ hardware.js 金具プリセット             │
│ leather/polyline.js 弧長・接線│  │ templates.js AirTag / カードケース     │
└──────────────────────────────┘  └────────────┬──────────────────────────┘
                                               │
                 ┌─────────────────────────────▼───────────────────────────┐
                 │ Dependency Engine  src/leather/derive.js                │
                 │ item(外形) → path → run → offset → holes / folds / hw    │
                 │ joint → 2 本の縫い線の穴数・位置を照合（DAG、保存しない）   │
                 └─────────────────────────────┬───────────────────────────┘
                                               │
                 ┌─────────────────────────────▼───────────────────────────┐
                 │ Manufacturing Engine  src/leather/manufacturing.js       │
                 │ CUT / PUNCH / SCORE / ENGRAVE グループ、カーフ補正、        │
                 │ 加工前検証（未閉合・自己交差・重複・微小・はみ出し）、SVG 出力 │
                 └─────────────────────────────────────────────────────────┘
```

## 層の責務

| 層 | ファイル | 責務 | 依存 |
|---|---|---|---|
| CAD Geometry Core | `geometry.js` `path.js` `cad.js` `polygon.js` `operations.js` `leather/polyline.js` `leather/fillet.js` | ベジェ→折れ線（許容 0.02 mm）、ノード編集、Clipper オフセット、フィレット（直線どうしは解析解、曲線を含む角は `fillet.js` の接円探索）、弧長パラメータ化、接線、角検出 | clipper-lib |
| Leather Domain Core | `leather/model.js` `leather/stitch.js` `leather/hardware.js` `leather/templates.js` `leather/history.js` `leather/mirror.js` | データモデルと検証、縫い穴配置、穴形状、金具、テンプレート、操作履歴（基本形状＋フィーチャの再生成）、ミラーの一方向リンク | Geometry Core |
| Dependency Engine | `leather/derive.js` | 外形アイテムから派生要素を再計算。無効参照は `issues` として報告し派生要素を欠落させる（黙って不正形状を作らない） | Domain Core |
| Manufacturing Engine | `leather/manufacturing.js` | 加工属性の明示、カーフ、検証、mm 実寸 SVG | Dependency Engine |
| UI Layer | `main.js` `leather-ui.js` `style.css` | キャンバス、ツール、プロパティ、プレビュー、モバイルレイアウト | 上記すべて |

## 状態管理と幾何計算の分離

- 設計データは `project`（TypeFab 形式 JSON）＋ `project.leather`（`schemaVersion: 1`）だけ。派生ジオメトリ（縫い穴の座標）は保存しない。
- Undo/Redo は TypeFab の JSON スナップショット方式をそのまま使う。`project.leather` も同じスナップショットに含まれるため、パーツ・縫い線・縫合の編集はすべて取り消し可能。
- `leather-ui.js` はパーツ単位のキャッシュ（part と item の JSON をキー）で派生結果を再利用し、ドラッグ中もリアルタイムに追従する。
- アイテムの削除・置換（ブール演算・パス編集）は `remapItems()` で参照を追従／除去する。

## 依存の方向と循環防止

```
item (外形) ← part ← stitchLine / foldLine / hardware ← joint
```

一方向の DAG のみ。縫合（joint）は 2 本の縫い線の派生結果を読むだけで、縫い線の定義には影響しない（master の穴数で slave を再配置した結果を派生側に上書きする）。循環が生じ得る構造を持たないため、循環検出は不要。将来「他パーツの線を参照する縫い線」を追加する場合は、derive 時に訪問済み集合で循環を検出する。

## TypeFab との関係

- TypeFab のリポジトリは変更していない。LeatherFab は `src/` をコピーしたフォーク（注文・Worker・ランディング・ハンコ UI は除外。ハンコのコードは `stamp.js` として残るが UI からは隠している）。
- TypeFab モジュールへの変更は 2 か所だけ: `project.js` に `leather` の検証、`cad.js` の `filletCorner` に曲線を含む角のフォールバック（`leather/fillet.js`）。TypeFab の既存テスト（195 件）はそのまま通る。
- 将来は `geometry.js` `path.js` `cad.js` `polygon.js` `leather/polyline.js` を共通 CAD Core パッケージとして切り出す構成が理想。
