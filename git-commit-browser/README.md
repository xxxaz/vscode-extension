<!-- 全面更新: 2026-05-15 -->

# Git Commit Browser

任意のエディタ（ソースコードのコメント・生 Markdown・設定ファイル等）に出てくる
**コミット参照をクリック可能**にし、そのコミットを拡張内のブラウザで辿れるようにする
VS Code 拡張です。`rendered-markdown-diff` から独立した汎用機能として切り出しています。

## 認識する形

「規定された記法ではないが GitHub/GitLab で実際に動く形」だけを扱います（独自 scheme は採用しません）。

- **bare SHA**（7〜40 hex）: GitHub と同様、**リポジトリに実在する commit のみ**リンク化（`git rev-parse` で検証してから link / verify-before-link）。`.ts` の `// see abc1234` のようなコメントでも有効
- **GitHub/GitLab の commit URL**: `…/commit/<sha>` / `…/-/commit/<sha>`
- **GitHub/GitLab の blob URL**（コミット＋ファイル両方を指定）: `…/blob/<ref>/<path>` / `…/-/blob/<ref>/<path>`

`DocumentLinkProvider` として全テキストエディタに登録されるため、webview ではなく
通常のエディタ上でリンク（Ctrl/⌘+クリック）として機能します。

## ファイルパスのリンク化（ref 文脈追従）

コミット参照とは別に、ソースコードのコメント・文字列リテラル等に出てくる
**ファイルパス**（`/` を含み拡張子で終わる、または `./` `../` 始まり。URL 内は除外）も
クリック可能にします。解決は共有 `ContentRef.resolveRelative()` に委譲し、

- `file:` ドキュメント → 作業ツリーの対象ファイル（実在するもののみ）
- `git:` / `gitfs:`（ある ref を表示中）→ **同じ ref** の対象ファイル
- `git-graph:`（ある commit）→ 同じ commit の対象ファイル

を自動で選びます（= git ファイルとして開いている時は同 ref の対象を開く）。

## クリック後の挙動

- **commit 参照（コミット単体 / commit URL）** → コミットブラウザ QuickPick
    - そのコミットで**変更された全ファイル**を一覧。選択でそのファイルの **親 commit ↔ 該当 commit** の diff（追加 `A` は左空 / 削除 `D` は右空 にした diff＝全行追加・削除表示）
        - `.md` は `rendered-markdown-diff` がレンダリング diff として結合表示（インストール時）。非 md は `vscode.git` の `git:` で標準 diff
    - ファイルを開いてもフォーカスは QuickPick に残る（`preserveFocus`）。連続閲覧用に Esc / `$(close)` まで閉じない
    - ファイルは status 別アイコン（A/M/D/R）、**フラット / ツリー切替**（既定ツリー、`$(list-tree)`/`$(list-flat)`）。参照元ファイルは一覧で注記ハイライト
    - タイトルバー: `←` 親 / `→` 子コミット（連続探索）、`$(info)` コミットメッセージ全文（hover / クリック）、`$(github)` origin リモートで開く、`$(close)` 閉じる
        - 子は DAG 上一意でないため、`branch` ヒント → `HEAD` → **`ref` を含む branch/remote** の順で tip を辿る（HEAD に繋がらないブランチ上の commit でも機能）
- **blob URL（コミット＋ファイル）** → その特定ファイルの ref 時点を直接開く
- ローカル repo に commit が無い場合 → 元の URL を外部ブラウザで開く（URL 由来時）

## ref 間比較

その diff の左右 ref 間で差分のあるファイル一覧を出し、選択で各ファイルの git diff を
開く（片側が作業ツリー `file:` なら「ref ↔ 作業ツリー」比較。旧「作業ツリーと比較」は
これで実現）。起動口は 2 系統:

- **通常の text diff エディタ**（非 md / md をテキストで開いた時 / SCM diff 等、
  ファイル種別を問わず）→ エディタタイトル右の `$(git-compare)` ボタン
  （`editor/title`, `when: isInDiffEditor || activeCustomEditorId == rendered-markdown-diff`）
- **`rendered-markdown-diff` のレンダリング比較ビュワー** → そのビュワー（右 pane）の
  ヘッダー `⎇ Compare` ボタンが本拡張の同コマンドへ橋渡し
    - 理由: rmd の比較は各 pane を **custom editor (webview)** として描画するため、
      `editor/title` の `when` からは確実に拾えない（VSCode 制約）。diff を確実に
      判定できる rmd 側にボタンを置くのが唯一安定する方法

repo は参照元文書のパスから解決し、解決不能（repo 外の scratch ファイル等）なら
**ワークスペースフォルダ**へフォールバックする（コミット参照クリックも同様。リンクの
有効/無効や開ける/開けないがファイル位置で変わるのを防ぐ）。

> Note: Git Graph を外部から特定コミットにフォーカスさせることは不可能（公開 API
> 無し）なため、その代替として本ブラウザを提供しています。QuickPick はキーイベントを
> 拡張へ公開しないため、左右キーでのコミット移動・任意色付けは未対応（タイトルバーの
> ←/→ ボタンと status 別アイコンで代替）。

## 配布

- `extensionDependencies`: `vscode.git`（hard。`toGitUri` と git 連携に使用）
- git 取得・URI 解決 (`git.ts` / `gitApi.ts` / `contentRef.ts` / `gitGraphUri.ts`
  / `gitLensUri.ts`) は `../shared/src/` を `rendered-markdown-diff` と共用
  （npm package ではなく esbuild が相対 import でバンドル）
- `rendered-markdown-diff` 側は MD ビュワーのヘッダー `⎇ Commit` ボタンと、
  本文中の検証済み SHA / commit・blob URL クリックを本拡張のコマンドへ橋渡しする
  （拡張間は command 経由の疎結合。本拡張が無効なら URL は外部ブラウザにフォールバック）

ローカルでビルドする場合:

```sh
npm install
npm run package    # dist/git-commit-browser.vsix を生成
```

`.vsix` を VS Code で「Install from VSIX...」または `code --install-extension` で
適用すると即時利用可能。リリース時は `vsce publish` で Marketplace に上げる。
