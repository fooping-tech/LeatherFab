# データモデル

保存形式は TypeFab プロジェクト JSON（`version: 2`）に `leather` ブロックを加えたもの。`leather` が無いファイル（素の TypeFab）はそのまま開ける。

```jsonc
{
  "version": 2, "name": "AirTag ケース", "width": 300, "height": 200,
  "layers": [...], "items": [...],            // TypeFab のまま。外形はここに居る
  "leather": {
    "schemaVersion": 1,
    "kerf": 0,                                 // mm、書き出し時のカーフ補正
    "hardwarePresets": [],                     // ユーザー定義金具
    "parts": [ LeatherPart ],
    "joints": [ StitchJoint ]
  }
}
```

## LeatherPart

| フィールド | 型 | 意味 |
|---|---|---|
| `id` | string | 一意 ID |
| `itemId` | string | 外形となる TypeFab アイテム（rect / circle / outline / polygon）。輪郭と内部穴はアイテムの `contours`（複数リング）で表現 |
| `name` | string | 名前 |
| `thickness` | mm | 革厚（0.2〜20） |
| `material` | enum | `veg-tan` `chrome-tan` `combination` `coated-pvc` `pu` `unknown`（レーザー適性: ok / caution / ng / unknown） |
| `color` | string | 表示色 |
| `quantity` | int | 必要枚数 |
| `side` | `front` / `back` | 表裏（裏はミラー加工の意図を記録。自動反転は未実装） |
| `stitchLines` | StitchLine[] | 縫い線 |
| `foldLines` | FoldLine[] | 折り線 |
| `hardware` | HardwarePlacement[] | 金具 |
| `outlineOperation` | `CUT` 等 | 外形の加工属性 |

## Geometry source（辺の参照）

縫い線・折り線は固定座標を持たず、外形アイテムの編集用パス（`workingPathOf(item)`）上のノード番号で辺を参照する。

```jsonc
{ "subpath": 0, "from": null, "to": null }   // サブパス全周
{ "subpath": 0, "from": 1,    "to": 0 }      // ノード 1 から前進してノード 0 まで（閉じたパスでは折り返す）
{ "subpath": 0, "from": 2,    "to": 2 }      // ノード 2 を起点とする全周
```

長方形・楕円は `shapePath()` の正確なベジェ（長方形: 角 R の有無で 4 または 8 ノード、時計回りで上辺左端から）。ノードが減って参照先が無くなった場合は `issues` に error を出し、その線は派生されない。

## StitchLine / StitchPattern

```jsonc
{ "id": "...", "name": "外周", "source": {...}, "offset": 3.0,
  "pattern": {
    "shape": "diamond",            // round | diamond | french | slit | flat
    "pitch": 3.85, "width": 0.6, "length": 2.0, "angle": 30,
    "spacing": "chord",            // arc（弧長）| chord（弦長）
    "fit": "fit",                  // fit（自動）| fixed（ピッチ固定・余りは末尾）| count（穴数）
    "count": 0, "corner": "auto",  // auto | apex | straddle | none
    "cornerAngle": 40, "startOffset": 0, "startMargin": 0, "endMargin": 0,
    "reverse": false, "flip": false, "maxDeviation": 0.12
  } }
```

## FoldLine

`{ id, name, source, offset, kind: "mountain" | "valley", operation: "SCORE" }` — 辺に平行な線（外形を offset だけ内側に入れた線のうち、その辺の範囲）。

## HardwarePlacement / preset

`{ id, presetId, x, y, rotation }`（x, y はパーツのローカル mm）。プリセットは `{ id, type, label, holes: [{dx, dy, d}], slot?: {w, h, pitch}, outer }`。17 種類を同梱（バネホック・ジャンパーホック・カシメ・ハトメ・マグネット・Dカン・ベルト穴・キーリング穴）。寸法は目安。

## StitchJoint

```jsonc
{ "id": "...", "name": "表 × 裏",
  "a": { "partId": "...", "lineId": "..." }, "b": { "partId": "...", "lineId": "..." },
  "reverse": false, "master": "a" }
```

派生時: master の穴数で slave を `fit: count` として再配置し、各穴 i を slave の穴 i（reverse なら n-1-i）と対応付ける。master の穴の正規化位置 u = s/L を slave 側の L' に写した位置と実際の穴位置の差を「位置ずれ」として報告（辺の長さ差 > 0.5 mm、ずれ > 1 mm で警告）。

## 派生結果（保存しない）

`deriveProject(project)` → `{ parts: [{ part, item, outline, stitch: [{ line, points, closed, result, holes:[{x,y,s,tangent,angle,anchor,contour}] }], folds, hardware, issues }], joints, issues }`

## マイグレーション方針

- `schemaVersion` は整数。読み込み時に `validateLeather()` が既定値を補い、未知の上位バージョンは拒否する。
- 既存フィールドの意味を変える変更は `schemaVersion` を上げ、`validateLeather()` に旧→新の変換を追加する。
