# 競合・先行実装調査: LeatherCAD / Pathstitch（2026-10-24 時点、リポジトリを読んで確認。コードは実行していない）

## C. LeatherCAD（crnlsp/leathercad）

- ライセンス: 確認済み Apache-2.0（`LICENSE`、package.json）。NOTICE ファイルなし。
- 成熟度: created 2026-09-24、最終 push 2026-10-23、★3、main 218 commits、v1.5.0。作者1名、AI駆動開発。
- スタック: Electron + TypeScript + React + Canvas2D、pnpm workspaces（core/geometry/domain/document/editor/render/export/persist/platform/typography）。geometry は外部依存ゼロ（Clipper は不採用）。pdf-lib、zod、fflate。

### データモデル（docs/domain-model.md、packages/domain/src/feature.ts）
- Project{settings, parts[]} / Part{name, quantity, features[]}
- Feature kind: cut-contour(outer|inner) / stitch-line / stitch-hole-set / fold-line / marking-line / hardware-hole / measurement / text-label
- `GeometrySource = path | shape | derived{sourceId, op}`
- `Derivation = offset{distanceMm, side, run: whole|between(anchors)} | stitch-holes{pitchMm, mode: fit-whole|exact-pitch, corners: continuous|hole-at-corner, startOffsetMm, endOffsetMm, ironLabel} | mirror`
- 穴に id はなく派生ジオメトリは保存しない（再計算）。

### 依存関係・再計算
参照グラフ（derives/references、非循環）。派生フィーチャは source を先に解決、失敗はフィーチャ単位で報告し依存側は SOURCE_FAILED。アンカー（コーナー番号）はオフセット関数が入力コーナーの写像を返す（最近点探索はしない）。source 削除時は freeze / re-point を明示選択。

### 縫い穴配置（docs/geometry.md §9）
弧長パラメータ化（0.005 mm で平坦化し弦長累積）。exact-pitch＝始点から刻み余りは末尾。fit-whole＝n=round(L/pitch)、閉路は n 穴。hole-at-corner はコーナーで分割し各ランを独立配分、共有コーナー穴は1回だけ出力、ラン毎の count/spacing を報告。MIN_PITCH 0.5 mm。弦長モード・コーナー対称配置は未実装。

### 縫い代
「プロパティではなく派生方向」: 縫い線を描き outward offset で外形を導出。

### 検証（§8.6）
不変条件（拒否）: SOURCE_MISSING, DERIVATION_INCOMPATIBLE, CORNER_IN_USE, WOULD_SHEAR など。評価失敗: SOURCE_FAILED, ANCHOR_MISSING, OFFSET_COLLAPSED, PARAMETER_INVALID。設計ルール（報告のみ）: CONTOUR_SELF_INTERSECTS, OUTSIDE_PART, HOLE_TOO_CLOSE_TO_EDGE(<1.5mm), HOLE_SPACING_UNEVEN(>5%), HOLE_SPACING_DEVIATION(>25%), HOLE_COUNT_TOO_LOW, EMPTY_PART。計画: SEAM_HOLE_COUNT_MISMATCH。

### 出力・永続化・テスト
- 1:1 PDF: pdf-lib、タイル overlap 10 mm、登録十字、100×5 mm ゲージ、CI で poppler 実測。
- SVG: 1 unit = 1 mm、DXF R12、ロール別レイヤー。
- `.lcp` = ZIP(manifest + document.json)、formatVersion 整数 v9、各版マイグレーション＋fixture。
- テスト: Vitest + fast-check、golden、Playwright、Stryker。test 呼び出し約 2,700。

### 借用価値 / 再利用条件
統一 GeometrySource と「1派生1ソース」、派生方向の縫い代、幾何プリミティブとドメイン方針の分離、拒否/報告/評価失敗の3分類、formatVersion 管理。Apache-2.0 でコードを取り込む場合は LICENSE 同梱・改変表示・著作権表示の保持。LeatherFab は現時点でコードを取り込まず設計思想のみ参考にしている。

## E. Pathstitch（Mason363/Pathstitch）

- ライセンス: 確認済み GPL-3.0（Potrace 依存のため全体 GPLv3）。
- 成熟度: created 2026-06-03、最終コミット 2026-06-24、★7、約4か月更新なし。
- スタック: macOS 14+ Apple Silicon 専用。SwiftUI ↔ Python worker（JSON stdin/stdout）。エンジン `pathstitch_core/dxf_ops.py`（約6,000行の単一ファイル）、shapely/ezdxf/numpy/pythonocc/potrace。
- 計算幾何: shapely 依存（buffer / offset_curve / ブール）。
- パラメトリックフィレット: G1 真円弧、G2 biarc、chamfer。コーナーごとにパラメータ保持。
- 参照画像の校正: 2点クリック＋実距離入力。ラスター→ベクタは potrace。
- STEP 展開: 平面/円筒/円錐は解析展開、二重曲率は三角形化→LSCM 共形パラメータ化＋緩和。
- 縫い穴: `op_add_holes`（spacing 4.0、offset 2.0、corner_holes、角度閾値 45°、可変ピッチ、千鳥2列、金具 keep-out）。閉路は N=round(L/s)。
- 出力: DXF、SVG、PDF は matplotlib 経由（1:1 保証やゲージは未確認）。`.stch` = ZIP。テストは少数、CI なし。

### GPL-3.0 の含意
コードのコピーは不可（コピーレフト）。アイデア（2点キャリブレーション、角度閾値＋可変ピッチのコーナー穴、G1/G2 フィレット、keep-out、LSCM 展開）の独立実装は可。LeatherFab はコードを一切流用していない。
