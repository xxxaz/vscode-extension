# vscode-extension monorepo (xxxaz)

汎用な開発支援系 VS Code 拡張を 1 リポジトリに集約した monorepo。各拡張は独立した
`.vsix` として VS Code Marketplace / Open VSX に publish される。共通ロジック
(git CLI ラッパー、URI 解析等) は [`shared/src/`](./shared/) に集約し、相対 import で
共有する (npm package 化はしない)。

更新日: 2026-05-20

## 同梱拡張

- [`rendered-markdown-diff`](./rendered-markdown-diff/) — `*.md` の default editor。
    レンダリング表示と HEAD / 対向との差分ハイライト、タブ右上アイコンでテキスト
    ↔ ビューワー切替。拡張を無効化すると通常の text editor に戻る
- [`git-commit-browser`](./git-commit-browser/) — 任意のエディタ上のコミット参照
    (実在検証済み bare SHA / GitHub・GitLab の commit・blob URL) をクリック可能にし、
    変更ファイル一覧・前後コミットを辿るコミットブラウザを開く

詳細は各ディレクトリの `README.md` を参照。

## ディレクトリ構成

```
vscode-extension/
├── README.md                            ← この文書
├── shared/
│   └── src/                             各拡張から相対 import で共有するロジック
├── <extension-name>/
│   ├── package.json                     VS Code manifest + npm scripts
│   ├── tsconfig.json
│   ├── esbuild.config.mjs               bundle 設定
│   ├── .vscodeignore                    vsce package で vsix に含めない物
│   ├── .gitignore                       node_modules/ dist/ out/ を除外
│   ├── README.md                        拡張個別の設計メモ
│   ├── src/*.ts
│   ├── media/                           CSS / 画像等
│   └── dist/                            ビルド成果物 (gitignored)
└── ...
```

`shared/` 自体は package を持たず、各拡張の esbuild が相対 import を解決して
bundle に含める。`shared/` を一つ編集すれば両拡張で同時に反映される。

## ローカル開発

```sh
cd <extension-name>
npm install
npm run package           # dist/*.vsix を生成
# ホットリロード:
#   npm run watch         # esbuild の watch mode
```

生成した `.vsix` は VS Code で「Install from VSIX...」または `code --install-extension`
で試せる。

## Publish (Marketplace / Open VSX)

新規バージョン release 時:

1. 該当拡張の `package.json` の `version` をインクリメント
2. `npm run package` で `.vsix` を作る
3. `vsce publish` (Marketplace) / `ovsx publish` (Open VSX) で publish
    - publisher は `xxxaz` 固定
    - 認証 token は CI / 開発者のローカル環境に保持し、リポジトリには載せない

## VS Code Extension 開発の落とし穴

shared/ や本 monorepo の設計時に踏んだ罠を集約しておく。新規拡張を起こす前に
通読推奨。

### `window.activeTextEditor` は preview タブで `undefined`

`workbench.editorAssociations` で `*.md` を `vscode.markdown.preview.editor` に
紐付けると、md を開いたタブは **TextEditor ではなく CustomEditor (webview)** に
なるため `window.activeTextEditor` は `undefined` を返す。
従って、ファイル URI を取得する処理は

```ts
const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
const input = tab?.input;
if (input instanceof vscode.TabInputText) {
    // 通常のテキストエディタ: input.uri
} else if (input instanceof vscode.TabInputCustom) {
    // custom editor (markdown preview 等): input.uri
} else if (input instanceof vscode.TabInputTextDiff) {
    // diff editor: input.original / input.modified
}
```

の Tab API ベースで書く。これによりタブ種別を問わず URI を取れる。

### `git:` scheme URI は `vscode.workspace.fs.readFile` で HEAD/index を返す

Source Control の diff 等で `TabInputTextDiff.original` (場合により `modified` も)
は `git:` scheme の URI になる。これを `vscode.workspace.fs.readFile` で読むと
git extension の FS provider が動き、**作業ツリーではなく HEAD / index の内容** が
返る。作業ツリーと比較したい場合は scheme を `file` に書き換える:

```ts
const fileUri =
    uri.scheme === 'git'
        ? uri.with({ scheme: 'file', query: '', fragment: '' })
        : uri;
```

### Source Control の click を奪うには `onDidChangeTabs` で hook する

Source Control 左ペインや Git Graph 拡張から `.md` をクリックすると VS Code が
`TabInputTextDiff` を生成する。これを我々の preview に差し替えるには:

```ts
vscode.window.tabGroups.onDidChangeTabs((event) => {
    for (const tab of event.opened) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
            // 条件で絞ったうえで tabGroups.close(tab) + 自前コマンド起動
        }
    }
});
```

このリスナーを動かすには `activationEvents` に `"onStartupFinished"` を入れて
**eager activate** にする必要がある (commandPalette 経由でないと activate しないと
リスナーが間に合わない)。

### `execFile` は引数配列で渡してシェル展開を避ける

git コマンド呼び出しで `` git show `HEAD:${path}` `` のようなテンプレートリテラルを
シェルに渡すと、ファイル名にメタ文字があるリポジトリで command injection になる。
必ず `` execFile('git', ['show', `HEAD:${path}`]) `` の **配列形式** で呼ぶこと。

### `engines.vscode` は実機 VS Code の version を確認してから決める

`engines.vscode` を満たさない VS Code では install しても **activate しない**
(エラーは出ず単に動かない)。`code --version` で確認した上で決める。

## License

[MIT](./LICENSE)

## 参考リンク

- [VS Code Extension API: Tab](https://code.visualstudio.com/api/references/vscode-api#Tab)
- [VS Code Extension API: TabInputTextDiff](https://code.visualstudio.com/api/references/vscode-api#TabInputTextDiff)
- [activationEvents](https://code.visualstudio.com/api/references/activation-events)
- [`@vscode/vsce` packaging](https://github.com/microsoft/vscode-vsce)
- 過去調査: VS Code の `workbench.editorAssociations` が source control diff を壊す件 — [microsoft/vscode#268139](https://github.com/microsoft/vscode/issues/268139) / [microsoft/vscode#138525](https://github.com/microsoft/vscode/issues/138525)
