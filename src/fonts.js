// Bundled font catalogue, lazy loader and the user-font policy (issue #3).
// Fonts are fetched only when a text item needs them; each id is fetched at
// most once and cached together with its HarfBuzz shaping font.
export const FONT_POLICY_VERSION = 1;
export const FONT_CATEGORIES = {
  gothic: "ゴシック",
  mincho: "明朝",
  rounded: "丸ゴシック",
  display: "ディスプレイ",
  handwriting: "手書き",
  pixel: "ドット / ピクセル",
};
const OFL = {
  license: "SIL Open Font License 1.1",
  licenseId: "OFL-1.1",
  licenseUrl: "https://openfontlicense.org/open-font-license-official-text/",
};
// Ids "zen" and "shippori" are stored in existing project files; keep them.
export const FONT_CATALOG = [
  {
    id: "zen",
    label: "Zen Kaku Gothic New",
    file: "ZenKakuGothicNew-Regular.ttf",
    licenseFile: "ZenKakuGothicNew-OFL.txt",
    category: "gothic",
    copyright: "Copyright 2022 The Zen Kaku Gothic Project Authors",
    source: "https://github.com/google/fonts/tree/main/ofl/zenkakugothicnew",
    upstream: "https://github.com/googlefonts/zen-kakugothic",
    default: true,
    ...OFL,
  },
  {
    id: "shippori",
    label: "しっぽり明朝",
    file: "ShipporiMincho-Regular.ttf",
    licenseFile: "ShipporiMincho-OFL.txt",
    category: "mincho",
    copyright: "Copyright 2021 The Shippori Mincho Project Authors",
    source: "https://github.com/google/fonts/tree/main/ofl/shipporimincho",
    upstream: "https://github.com/fontdasu/ShipporiMincho",
    ...OFL,
  },
  {
    id: "zenmaru",
    label: "Zen Maru Gothic",
    file: "ZenMaruGothic-Regular.ttf",
    licenseFile: "ZenMaruGothic-OFL.txt",
    category: "rounded",
    copyright: "Copyright 2021 The Zen Maru Gothic Project Authors",
    source: "https://github.com/google/fonts/tree/main/ofl/zenmarugothic",
    upstream: "https://github.com/googlefonts/zen-marugothic",
    ...OFL,
  },
  {
    id: "delagothic",
    label: "Dela Gothic One",
    file: "DelaGothicOne-Regular.ttf",
    licenseFile: "DelaGothicOne-OFL.txt",
    category: "display",
    copyright: "Copyright 2020 The Dela Gothic Project Authors",
    source: "https://github.com/google/fonts/tree/main/ofl/delagothicone",
    upstream: "https://github.com/syakuzen/DelaGothic",
    ...OFL,
  },
  {
    id: "rocknroll",
    label: "RocknRoll One",
    file: "RocknRollOne-Regular.ttf",
    licenseFile: "RocknRollOne-OFL.txt",
    category: "display",
    copyright: "Copyright 2020 The RocknRoll Project Authors",
    source: "https://github.com/google/fonts/tree/main/ofl/rocknrollone",
    upstream: "https://github.com/fontworks-fonts/RocknRoll",
    ...OFL,
  },
  {
    id: "kaiseidecol",
    label: "Kaisei Decol",
    file: "KaiseiDecol-Regular.ttf",
    licenseFile: "KaiseiDecol-OFL.txt",
    category: "mincho",
    copyright: "Copyright 2020 The Kaisei Project Authors",
    source: "https://github.com/google/fonts/tree/main/ofl/kaiseidecol",
    upstream: "https://github.com/Font-Kai/Kaisei",
    ...OFL,
  },
  {
    id: "zenkurenaido",
    label: "Zen Kurenaido",
    file: "ZenKurenaido-Regular.ttf",
    licenseFile: "ZenKurenaido-OFL.txt",
    category: "handwriting",
    copyright: "Copyright 2021 The Zen Kurenaido Project Authors",
    source: "https://github.com/google/fonts/tree/main/ofl/zenkurenaido",
    upstream: "https://github.com/googlefonts/zen-kurenaido",
    ...OFL,
  },
  {
    id: "dotgothic",
    label: "DotGothic16",
    file: "DotGothic16-Regular.ttf",
    licenseFile: "DotGothic16-OFL.txt",
    category: "pixel",
    copyright: "Copyright 2020 The DotGothic16 Project Authors",
    source: "https://github.com/google/fonts/tree/main/ofl/dotgothic16",
    upstream: "https://github.com/fontworks-fonts/DotGothic16",
    ...OFL,
  },
];
export const DEFAULT_FONT = FONT_CATALOG.find((f) => f.default).id;
export const bundledFont = (id) => FONT_CATALOG.find((f) => f.id === id) ?? null;

// Loader state per id: "idle" (bundled, not fetched) | "loading" | "loaded" |
// "error". `fonts` / `shaping` are the maps the editor reads synchronously.
export function createFontLoader({ fetch, baseUrl, parse, makeShaping, onChange = () => {} }) {
  const fonts = new Map(),
    shaping = new Map(),
    labels = new Map(FONT_CATALOG.map((f) => [f.id, f.label])),
    pending = new Map(),
    errors = new Map();
  let fetched = 0;
  const loader = {
    fonts,
    shaping,
    labels,
    get fetchCount() {
      return fetched;
    },
    state(id) {
      if (fonts.has(id)) return "loaded";
      if (pending.has(id)) return "loading";
      if (errors.has(id)) return "error";
      return bundledFont(id) ? "idle" : "missing";
    },
    error: (id) => errors.get(id) ?? null,
    // Fetches a bundled font once; concurrent calls share the same promise.
    load(id) {
      if (fonts.has(id)) return Promise.resolve({ font: fonts.get(id), shaping: shaping.get(id) });
      if (pending.has(id)) return pending.get(id);
      const entry = bundledFont(id);
      if (!entry) return Promise.reject(Error("このフォントは同梱されていません。追加フォントを読み込み直してください。"));
      const p = (async () => {
        try {
          fetched++;
          const res = await fetch(`${baseUrl}fonts/${entry.file}`);
          if (!res.ok) throw Error(`HTTP ${res.status}`);
          const bytes = await res.arrayBuffer();
          const font = parse(bytes),
            shape = makeShaping(bytes);
          fonts.set(id, font);
          shaping.set(id, shape);
          errors.delete(id);
          return { font, shaping: shape, bytes };
        } catch (e) {
          const message = `フォント「${entry.label}」を読み込めませんでした（${e.message}）。ネットワークを確認して、もう一度選んでください。`;
          errors.set(id, message);
          throw Error(message);
        } finally {
          pending.delete(id);
          onChange(id);
        }
      })();
      pending.set(id, p);
      onChange(id);
      return p;
    },
    // Registers a user-supplied font (already parsed) for this session.
    add(id, font, shape, label) {
      fonts.set(id, font);
      shaping.set(id, shape);
      labels.set(id, label);
      onChange(id);
    },
  };
  return loader;
}
// The stored value is the policy version the person accepted.
export const fontPolicyAccepted = (stored) => Number(stored) === FONT_POLICY_VERSION;
export const FONT_POLICY_TEXT = `TypeFabでは、ユーザー自身が保有するフォントファイルを読み込んでデザインに使用できます。

アップロードまたは読み込むフォントについて、そのフォントを使用・加工・アウトライン化し、生成物を利用するために必要な権利または許諾を有していることを、ユーザー自身で確認してください。

フォントによっては、商用利用、Webサービスでの利用、アウトライン化、ロゴ利用、再配布、加工データへの埋め込み等が制限されている場合があります。

TypeFabは、ユーザーが追加したフォントのライセンス内容、利用可能範囲、第三者の権利を保証または確認するものではありません。

権利者の許可なく利用できないフォント、第三者の著作権・商標権その他の権利を侵害するフォント、または利用条件に違反するフォントを使用しないでください。

TypeFabから生成したSVG、加工データ、画像、製品その他の成果物を利用・販売・配布する場合も、元のフォントのライセンス条件を満たす責任はユーザーにあります。

現行のTypeFabでは、ユーザー追加フォントはブラウザ内で処理され、TypeFabの標準フォントとして再配布されるものではありません。ただし、将来クラウド保存等の機能を追加する場合は、その仕様と規約を別途明示します。`;
export const BUNDLED_FONTS_NOTE = `TypeFabに標準搭載されているフォントは、各フォントのライセンスに基づいてTypeFabに同梱しています。

現在の標準搭載フォントは、原則としてSIL Open Font License 1.1（OFL-1.1）で提供されているものを採用しています。

OFL-1.1では、フォントの利用、埋め込み、ソフトウェアへの同梱、再配布、商用利用等が一定の条件のもとで認められています。フォントそのものを単体の商品として販売することはできません。

TypeFabで生成したSVGや、そのSVGを用いて制作した加工物・製品については、それ自体をOFLで公開する必要はありません。ただし、個別フォントに追加条件や別ライセンスが存在する場合は、その条件が優先されます。`;
