# 競合調査: Leathercraft CAD / Stitch Hero（2026-10-24 時点）

凡例: 確認済み＝一次ソースに明記 / 部分＝断片的 / 未確認＝記述なし（不在の意味ではない）

主要ソース
- [LCC] https://coffee-craft.net/leathercraft_cad
- [LCC-Web] https://coffee-craft.net/leathercraft_cad_web
- [LCC-RN] https://coffee-craft.net/leathercraft_cad/release_notes
- [LCC-420] https://coffee-craft.net/3ee272ed14a8813eabb3fe7bbbdd25c7 （v4.2.0 2026-10-03）
- [SH] https://stitch-hero.com/
- [SH-UG] https://github.com/heathmanc/leather-drafting/blob/HEAD/docs/USER_GUIDE.md
- [SH-GH] https://github.com/heathmanc/leather-drafting

## A. Leathercraft CAD（作者 LuthierTN）

「縫い穴を縫い穴として認識する」革細工専用CAD。デスクトップ版は寄付歓迎のフリー、Web版はベータ。

- Windows / macOS（確認済み）。Web版 cad.coffee-craft.net は Google アカウント必須、iPad＋Apple Pencil 可、20言語（確認済み [LCC-Web]）
- 価格: デスクトップ無料（寄付）。Web版は1か月無料、以後はメンバー／寄付者のみ継続。課金形態は未定（確認済み）
- Web ベータ: Phase1 2026-10-03（約100名）、Phase2 2026-10-21（約1,000名）

| 機能 | 判定 | 内容 |
|---|---|---|
| 自動目打ち | 確認済み | 直線・曲線に沿って配置、工具角度は線に追従。固定／可変ピッチ。可変では「4mm→4.13mm」のように実効ピッチを表示。弦長/弧長の区別は未確認 |
| 目打ち工具登録 | 確認済み | 菱目・ヨーロッパ目・丸目・平目、ピッチ/刃数/角度/サイズを任意登録 |
| スマートコーナー目打ち | 部分 | v3.5.0（2026-05-07）見出しのみ。アルゴリズムは未確認 |
| スマートオフセット | 部分 | v3.5.0 新設、v3.6.1 改善。仕様未記載 |
| 縫い線編集 | 部分 | 縫い順自動修復、ステッチシミュレータ、ベジエ再編集 |
| 駒合わせ縫いヘルパー | 確認済み | 両パーツの穴数を一致させる |
| 逆目打ち／ミラー | 確認済み | 逆向き目打ちの後変更、ミラー反転。斜め穴の向き処理詳細は未確認 |
| 3D型紙・3D治具 | 部分 | v3.5.0 見出し、v3.6.1 多色3Dプリント |
| 革シミュレーター | 確認済み | v4.2.0 で塗りつぶしバケツ方式 |
| SVG/DXF 出力 | 確認済み | DXF R14、v4.2.0 で線種別 DXF、DXF 読み込み（R12→円弧復元） |
| カーフ補正 / ネスティング | 未確認 | 記述なし |
| 画像/PDF トレース | 確認済み | 実寸PDF透過読込、画像はDPI入力 |

v4.2.0 要点: 寸法線が図形追従、グループ階層化、円弧の結合/トリム/延長、フィレット半径自動調整、距離ベース重複検出、数万本規模の高速化、Web版とのコピペ。

参考点: 工具をユーザー登録制にする／実効ピッチの提示／駒合わせ（穴数一致）を独立機能に／大規模でも実用速度。
弱点: コーナー対称性・弦長/弧長・カーフの公開仕様がない、Web版収益モデル未定、第三者レビューが乏しい。

## B. Stitch Hero（heathmanc/leather-drafting）

レーザーカット前提の革型紙＋手縫い穴 CAD。Python/PySide6、v0.2、MIT ライセンス、開発中は無料（確認済み）。macOS/Windows ビルド、Web版なし。

| 機能 | 判定 | 内容 |
|---|---|---|
| 弦長 vs 弧長 | 確認済み | 「Chord marching」: 次の穴を直線距離で決定。弧長配置は「wrong for irons on curves」と明記 |
| 目打ちピッチ | 部分 | 2.0〜5.0 mm または SPI、既定 3.85 mm、数式入力可。メーカー別プリセットは未確認 |
| 自動ピッチ最適化 | 確認済み | span ごとにピッチを数%補正（上限 ≤12%）。fit モード auto/endpoints/closed/none |
| コーナー対称配置 | 確認済み | 「every corner is symmetric about its apex (a hole on it, or an even pair straddling it)」。auto は各戦略を試し弦長ズレ最小を採用。急角では必ず apex 1穴 |
| 穴の完全一致 | 確認済み | 「Same outline + same settings = byte-identical hole layouts.」Check seam mates で穴数一致を検証 |
| ミラー時の穴向き | 確認済み | 「slanted slits mirror too, so they line up when the piece is turned over.」 |
| 共有縫い線 | 確認済み | 縫い線はワールド座標で1本描き、接する全パーツが同じ穴を得る |
| カーフ補正 | 確認済み | 外周 +kerf/2、内側くり抜きと穴は縮小、典型 0.1〜0.3 mm、PDF には非適用 |
| 出力 | 確認済み | SVG（mm、レイヤー色分け）、DXF R12、Cut/Score/Engrave/Stitch レイヤー、JSON プロジェクト、1:1 タイル PDF（8 mm 重なり） |
| ネスティング | 確認済み | 実輪郭で詰める、90°回転、余白 |
| 穴形状 | 確認済み | Round（0.8/1.0/1.2/1.5）、Oblique、French、Diamond。スリット長・角度設定 |

参考点: 弦長マーチングを設計原則に／コーナー戦略の列挙と自動選択／決定論性／縫い線の独立オブジェクト化／カーフの符号規則。
弱点: ごく初期（v0.2）、デスクトップのみ、ピッチ補正上限の表記不一致（LP「a few percent」vs UG「≤12%」）。
