# Third-party fonts

TypeFab に標準搭載しているフォントの一覧です。すべて SIL Open Font License 1.1（OFL-1.1）で、Google Fonts の公式リポジトリ（github.com/google/fonts）で配布されている静的 TTF をそのまま同梱しています。フォント本体と OFL 本文は `public/fonts/` にあります。エディタ内の「フォントライセンス」画面にも同じ情報を表示します。

フォントを追加・更新するときは、公式配布元の最新の LICENSE / OFL 本文を確認し、フォント本体と OFL 本文を必ず同梱し、`src/fonts.js` の `FONT_CATALOG` とこのファイルを更新してください。サブセット化・変換・改変を行う場合は Reserved Font Name 条項を確認してください（現在は改変していません）。

## Zen Kaku Gothic New
- License: SIL Open Font License 1.1
- Copyright: Copyright 2022 The Zen Kaku Gothic Project Authors (https://github.com/googlefonts/zen-kakugothic)
- Source: https://github.com/google/fonts/tree/main/ofl/zenkakugothicnew
- Files: `public/fonts/ZenKakuGothicNew-Regular.ttf`, `public/fonts/ZenKakuGothicNew-OFL.txt`
- Category: ゴシック（既定フォント）

## しっぽり明朝 (Shippori Mincho)
- License: SIL Open Font License 1.1
- Copyright: Copyright 2021 The Shippori Mincho Project Authors (https://github.com/fontdasu/ShipporiMincho)
- Source: https://github.com/google/fonts/tree/main/ofl/shipporimincho
- Files: `public/fonts/ShipporiMincho-Regular.ttf`, `public/fonts/ShipporiMincho-OFL.txt`
- Category: 明朝

## Zen Maru Gothic
- License: SIL Open Font License 1.1
- Copyright: Copyright 2021 The Zen Maru Gothic Project Authors (https://github.com/googlefonts/zen-marugothic)
- Source: https://github.com/google/fonts/tree/main/ofl/zenmarugothic
- Files: `public/fonts/ZenMaruGothic-Regular.ttf`, `public/fonts/ZenMaruGothic-OFL.txt`
- Category: 丸ゴシック

## Dela Gothic One
- License: SIL Open Font License 1.1
- Copyright: Copyright 2020 The Dela Gothic Project Authors (https://github.com/syakuzen/DelaGothic)
- Source: https://github.com/google/fonts/tree/main/ofl/delagothicone
- Files: `public/fonts/DelaGothicOne-Regular.ttf`, `public/fonts/DelaGothicOne-OFL.txt`
- Category: ディスプレイ

## RocknRoll One
- License: SIL Open Font License 1.1
- Copyright: Copyright 2020 The RocknRoll Project Authors (https://github.com/fontworks-fonts/RocknRoll)
- Source: https://github.com/google/fonts/tree/main/ofl/rocknrollone
- Files: `public/fonts/RocknRollOne-Regular.ttf`, `public/fonts/RocknRollOne-OFL.txt`
- Category: ディスプレイ

## Kaisei Decol
- License: SIL Open Font License 1.1
- Copyright: Copyright 2020 The Kaisei Project Authors (https://github.com/Font-Kai/Kaisei)
- Source: https://github.com/google/fonts/tree/main/ofl/kaiseidecol
- Files: `public/fonts/KaiseiDecol-Regular.ttf`, `public/fonts/KaiseiDecol-OFL.txt`
- Category: 明朝（装飾）

## Zen Kurenaido
- License: SIL Open Font License 1.1
- Copyright: Copyright 2021 The Zen Kurenaido Project Authors (https://github.com/googlefonts/zen-kurenaido)
- Source: https://github.com/google/fonts/tree/main/ofl/zenkurenaido
- Files: `public/fonts/ZenKurenaido-Regular.ttf`, `public/fonts/ZenKurenaido-OFL.txt`
- Category: 手書き

## DotGothic16
- License: SIL Open Font License 1.1
- Copyright: Copyright 2020 The DotGothic16 Project Authors (https://github.com/fontworks-fonts/DotGothic16)
- Source: https://github.com/google/fonts/tree/main/ofl/dotgothic16
- Files: `public/fonts/DotGothic16-Regular.ttf`, `public/fonts/DotGothic16-OFL.txt`
- Category: ドット / ピクセル

## 採用しなかった候補

- **M PLUS Rounded 1c**: Google Fonts の METADATA では OFL とされていますが、公式リポジトリの `ofl/mplusrounded1c/` に OFL 本文（OFL.txt）が同梱されておらず、上流ソースの所在も未確認のため、「フォント本体と対応する OFL 本文を必ず同梱する」という方針に沿って見送りました。丸ゴシックには代わりに Zen Maru Gothic を採用しています。

## ユーザー追加フォント

エディタで追加したフォント（TTF / OTF / WOFF）はブラウザ内でのみ処理され、TypeFab から再配布されることはありません。利用に必要な権利・許諾の確認はユーザーの責任です。規約全文はエディタの「フォントライセンス」画面と `src/fonts.js`（`FONT_POLICY_TEXT`、バージョン `FONT_POLICY_VERSION`）にあります。
