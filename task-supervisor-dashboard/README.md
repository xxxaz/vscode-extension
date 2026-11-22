# Task Supervisor

監督台帳を一覧で見ながら、依頼の完了・キック済み・判断の回答を記録します。0.2.0では一覧を主画面にしました。0.2.1では中央のエディタータブを主表示とし、ウィンドウ再起動後もタブを復元します。0.4.0では常駐部と同じ共通の依頼一覧を使い、表示版・取得状態を明示します。Markdownへは書き戻しません。
更新日: 2026-11-20。

## 開発候補: 本人実行のportとfixture

資料・コマンド・実行結果のDB保存はU1898で採用されました。この候補は、既存の0.4.0共通read候補へ未配線のprocess/表示portを追加した準備段階です。正式受付・DB・実Node process・DevContainerの所在確認adapterは未接続です。製品の実行ボタンを追加せず、この候補のVSIX配布・実コマンド実行も行いません。既存の0.2.1/0.2.2/0.2.3/0.4.0と親PRは保全します。

`executionRunner.ts`は正式なcontext/claimをopaque型としてadapterへ委譲します。私有portのpreviewは固定版の資料本文とコマンド全文です。明示確認・所在の再確認・永続起動ラッチ・一度限りのclaimを通し、同じ本文をBashのstdinへ渡す起動要求を人工processへ接続します。実adapterはまだなく、端末のsendTextやagent daemonの本人実行経路は追加しません。起動ファイルや継承された関数を本文へ混ぜないBashオプションも固定します。

spawnを観測した後に開始保存を待ちます。claimの結果不明・開始保存失敗・close不明・終了保存失敗でもラッチを解除せず、自動再実行しません。終了コード・signal・unknownと出力保存状態は別です。終了のack後も正本readと照合し、exit0をUの完了へ変換しません。

`executionCapture.ts`はstreamごとの未完UTF-8を保持します。共通seqは復号が確定して生成した出力片の観測順であり、OS発生順や未完文字の最初のbyte到着順ではありません。この境界はT342/T337との正式型の照合対象です。不正なUTF-8や末尾切断を無印で置換しません。保存不明byteと、drainして保存しなかったbyteを区別します。

上限は正本から注入する私有設定で、既定値を複製しません。本文byte上限と片数上限を持ち、全体のJSON化後の容量予約はT342の正式受付へ委譲します。入力は有界とし、未ackの片を並列に増やさず1片ずつ待ちます。timeout・容量超過ではdrainへ移り、無制限メモリ保持・tmpへの退避・無断killをしません。保存成功のack後に限定readを照合してから表示します。read失敗は保存済みbyteと画面取得失敗を分けます。現在の私有portは1片ずつ保存し、coalescing/batchは未実装です。Nodeの実stream adapterでは、このpullに合わせてstdout/stderrをpause/resumeし、観測順の有界queueを実装する必要があります。

`executionView.ts`は固定版の資料/コマンド全文の確認と、結果閲覧の私有表示です。本人表示・DB保存・担当AIへの開示・needsOkを分けます。AI開示未設定は許可へ変換しません。閲覧設定は保存後readまで保存済みと表示せず、結果不明時は再取得まで変更を止めます。これらのUIは正式なread/受付adapterに未接続です。機密原文とAI開示の既定値はT342の判断資料を待ちます。

正式な操作型・CLI・capabilities、runner登録/実行場所の束縛、原子容量予約、形式3の移行とexport/restore、機密条件がそろってから接続します。この候補を理由に既存回答API・一般ran・全文保持patchの正式反映を待たせません。

## 一覧を開く

コマンドパレットで **Task Supervisor: 監督のダッシュボードを開く** を実行します。エクスプローラーの **監督の一覧** にも同じ内容を表示します。中央のエディタータブが主表示です。サイドバー右上の「監督のダッシュボードを開く」からも開けます。既に開いている場合は同じタブを表示します。タブは通常のエディターと同様に別のグループへ移動できます。

タブを開いたままウィンドウを閉じるかReload Windowすると、同じワークスペースのタブを復元します。検索・開いた区分/行・スクロール位置も保存します。閉じたタブを自動で開き直すことはありません。VS Codeが背面タブを遅れて復元する場合も、保存されていたタブを優先します。先にコマンドで開いた新規タブがあれば、復元時に閉じて保存済みのタブへ統一します。保存されたルートが現ワークスペースにない場合は別の台帳へ接続せず、エラーを表示します。ルート情報のない保存状態も推測せず拒否します。初期化に失敗した場合は通知してタブを閉じ、コマンドから再試行できます。

先頭に更新時刻・件数・監督へのリンクと区分の案内を表示します。検索はID・本文・状態・詳細を対象にします。行は要約を表示し、開くと全文と関連情報が見られます。

- 実行待ち・判断待ち: 優先度、ID、タスク、依頼全文、コマンド、依頼日時、資料、推奨回答。
- 保留・前提待ち、実行済みで結果確認待ち: 理由と前提、実行の記録を区別します。
- 進行中・保留中・完了済み・アーカイブのタスク: 状態と補足、Jira、ブランチ、PR、WT、セッション、関連、メモ。
- 監督のお知らせ、取得できなかった情報、直近20件の出来事。

タスクのリンクは一覧内の該当行を開きます。Jira・PR・セッションのリンクは対応するアプリ、資料はワークスペース内のファイルを開きます。ブランチやCodexの再開コマンドを勝手に実行しません。

台帳の4原票と常駐部の表示用ファイルを監視します。イベントは原稿順のままタスク別に一度だけ整理します。変更行のDOMだけを更新し、スクロール・開いた行・検索・フォーカスを保ちます。行が「実行待ち」から「結果確認待ち」へ移っても同じカードを使います。フォーカス中の行が閉じた区分へ移る場合だけ、その区分を開いてフォーカスを保ちます。取得失敗では前の表示と更新時刻を残して警告します。補助原票の初回不在は空値と警告にしますが、一度読めた原票の消失は取得失敗として扱います。

## 行から操作する

依頼の行を開くと、その状態で使える操作だけが表示されます。コマンドパレットの従来の3操作も使えます。

- **完了（結果確認 OK）**: 一般の実行依頼は通常完了、結果確認が必要な依頼は結果OKとして記録します。判断行の「推奨で完了」は資料と回答者を確認し、「推奨で進める」という回答を保存します。
- **キック済み**: 実行の事実を `ran` で記録し、結果確認待ちを完了と混同しません。
- **判断に回答**: 「推奨で進める」または自由記述と回答者を保存します。自由記述は開いた無題テキストへ入力し、通知の「回答を確認」を押します。改行と前後の空白を原文として取得し、ディスクへの保存は不要です。

操作前に確認画面を出します。一覧の表示後に依頼が変われば拒否し、別の依頼へ付け替えません。操作候補は共通一覧のoperationsを使い、保存直前にGatewayが最新の依頼・正本・権限を再検証します。回答を完了印だけで代用しません。

保存成功・失敗・受付済み結果待ちを区別して表示します。未保存回答や結果不明の操作は、原文と同じ操作IDをワークスペース状態に保持します。次の操作で保存済みか照会し、必要なら同じ内容・IDで再送します。

## 読取りと常駐部への接続

利用者操作一覧は共通の `UserActionsView` を読みます。常駐部では `snapshot.json` の `userActions`、切替前は正式な `board.ts user-actions --json` を使います。分類・並び・操作候補を拡張内で再定義しません。旧CLIに正式read入口がない場合は取得失敗として表示し、独自分類へ戻りません。この版の導入には共通read対応CLIが必要です。

正式readの切替前の取得元は `shadow`・epochなしです。元の値を表示し、書込み許可には読み替えません。終了コード1で返る正式な `unavailable` JSONも取得失敗の型と理由を保ちます。壊れたJSON、正常JSONを伴う異常終了、上限超過、その他の操作の異常終了は成功へ変換しません。

タスク・お知らせ・出来事の補足は `.agents/ローカルタスク/監督/` の `registry.json`、`events.jsonl`、`state.json`、`archive.json` を使います。正本切替後のタスク一覧はsnapshot内のregistryを使います。生成Markdownの表は解析しません。`test:board-parity` は正本の共通射影を直接読み、実台帳との表示対応を確認する補助です。

操作UIは `ActionGateway` を使います。切替前は既存CLI、`runtime/authority.json` が `authoritative` なら常駐CLIへ接続します。`preparing`・破損・観測済みの切替記録の消失は拒否し、常駐部の停止や未対応を理由に旧CLIへ戻りません。切替後の一覧も常駐部の `snapshot.json` を正本にします。切替や破損を読取りだけで観測した場合も、操作ポートと同じ永続記録へ保存し、Reload後の旧CLI復帰を防ぎます。heartbeatの欠損・期限切れ・未来時刻・世代不一致・snapshot保存エラーを取得失敗として扱います。ファイル更新が止まっても、表示中は5秒間隔の再検査で停止を検出します。最後の正常な行と更新時刻・共通表示版を残し、取得失敗と取得時点を表示して行操作を無効にします。正常な空一覧とは区別します。

常駐経路は選択時のタスク版と回答contextの版を固定し、型付きの `action.complete`・`action.executed`・`action.answer` を `submit` へ渡します。`capabilities` に対象操作がない場合は送信前に拒否します。受付の `queued` と適用済み、担当の受領・処理完了は別の状態です。結果はCLI返却の対象ルート内のパスから読み、拡張はSQLiteを開きません。

常駐部の孤立・稼働・待機・報告の詳細表示は次段階です。この一覧だけで全体が正常とは判定しません。常駐部の業務書込み公開後の実結合・実運用切替は別途必要です。未対応の段階で切り替えないでください。切替前の旧CLIには、完了・キック済みの原子的な版照合や永続的な操作IDの重複排除がありません。保存前の再読取りと保存後の読戻しで確認します。

正規release後に旧正本へ戻る受付選択は、この候補では未対応です。既知の切替記録を拡張が独自に解除せず、`preparing` として拒否します。正式な受付契約との接続を確認してから対応します。

## 実行記録への接続候補（未公開）

この候補は正式checkpoint `1cd5c8787d5434bb0c167d686ee7462f9d8b9077` の型と保存処理へ接続する準備版です。既存のコピー機能も含めます。本人認可の公開transport、runner所在の登録、機密原文の受付条件は未接続です。拡張の実行ボタンは有効にせず、実台帳・実DB・daemon・LLMの切替を行いません。

`RecordConnection` は正式型を使い、固定資料・実行原票を読みます。prepare、claim、実processのspawn観測、started、共通seq出力、finished、開示変更を正式操作へ変換します。appliedだけでは出力保存成功とせず、storedとseqのack、正式readの本文ハッシュを照合します。task版の競合・応答不明の後に現在版へ差し替えません。実行権取得後の再起動は行いません。終了値0も依頼の完了には変換しません。

Bashへ確認した本文の全文をstdinで送ります。stdoutとstderrの待ち行列は合計128KiB、1送信片16KiB、1実行8MiB、片数4096までです。DB応答期限は5秒です。期限・容量超過では出力を排出し、stream別の欠落と不明を記録します。子を無断でkillしません。保存済み出力の表示はテキストとして追加し、読みかけのスクロールを保ちます。本人表示・DB保存・AI開示・needsOkを別々に扱います。

公開transportは、payloadのsourceやUIの自己申告とは独立した認可、正式capabilities、DevContainer所在、永続的な起動ラッチを供給する必要があります。現在の人工fixtureを本番の認可として使いません。ラッパースクリプトの本文展開と依頼に紐づく固定資料参照も正式接続の前提です。任意の手元資料を、依頼に添付された資料として扱いません。

質問の送受信APIと推奨回答原文の正式フィールドは、このcheckpointにはありません。質問の送信・推奨原文の自動選択が完成したとは扱いません。既存の自由回答は正式なanswer APIを使い、ログと完了印の組合せへ代替しません。

正式型と定数は手書きで複製せず、固定commitから型だけを再現生成します。parser・分類・SQLは拡張へ複製しません。次の検査は正式リポジトリの隔離WTを明示して実行します。引数なし・checkpoint不一致は失敗です。

```sh
npm run sync:record-types -- <正式リポジトリのWT> --check
npm run test:record-connection -- <正式リポジトリのWT>
```

結合検査は一時ディレクトリの形式3SQLiteと非機密のprintfだけを使用します。人工の本人callerを使った隔離成功と、実DevContainerでの本人実行・運用受入は別です。

## 必要な環境

信頼したローカルワークスペースを使います。拡張はワークスペース側で動き、DevContainer接続中はDevContainer内でCLIを呼びます。Dockerを使う実行経路はありません。

マシン設定:

- `taskSupervisor.nodePath`: TypeScriptを直接実行できるNode 24以降。初期値 `/usr/local/bin/node`。
- `taskSupervisor.boardPath`: 信頼した共通board CLI。初期値 `.claude/worktrees/supervisor-watch/.agents/skills/task-supervisor/board.ts`。
- `taskSupervisor.runtimeCliPath`: 契約v1の常駐受付。初期値 `.agents/skills/task-supervisor/runtime/cli.ts`。

子プロセスの `CLAUDE_PROJECT_DIR` は選択したルートに固定します。自由回答には `answer-context`/`answer`、一般の実行依頼のキック済みには対応したCLIが必要です。古いCLIの拒否は成功にしません。共通一覧の全行を返せるようCLI出力のバッファ上限は1MiBから16MiBへ拡張しています。上限を超えた応答は切り詰めて表示せず、取得失敗にします。

## ビルド・画面確認・手動導入

```sh
npm ci
npm run package
npm run preview -- --skill-dir=<共通射影を含む監督skillディレクトリ>
```

`package` は型検査・テスト・バンドル生成・配布HTMLと配布JSの接続検査を実行し、`dist/task-supervisor-dashboard.vsix` を作ります。プレビューはローカルのサンプル台帳を使い、操作を書き込みません。`npm run preview -- <workspace-root> --skill-dir=<監督skillディレクトリ> --port=8875` で実台帳の読取り表示も確認できます。外部通信はありません。

正本との照合は次で実行します（外部リポジトリのためCIではなく、対象ワークスペースで行います）。

```sh
npm run test:board-parity -- <task-supervisorのディレクトリ> <workspace-root>
npm run test:runtime-view -- <公開候補のtask-supervisorディレクトリ>
```

手動導入では、VS Codeを動かす環境の端末で次を実行します。コンテナの構成へ入れる前にもVSIXから試せます。

```sh
code --install-extension <task-supervisor-dashboard-0.4.0.vsixのパス> --force
```

導入後はコマンドパレットで **Developer: Reload Window（開発者: ウィンドウの再読み込み）** を実行し、**Task Supervisor: 監督のダッシュボードを開く** を選びます。手元のVS Codeへ入れる場合は、NodeとCLIのマシン設定をローカルのパスへ合わせてください。表示だけのプレビュー検証と、VS Codeでの実CLI操作の受入は区別します。

既存CI matrixが検査とVSIX生成を行い、`task-supervisor-dashboard-v0.4.0` タグでRelease workflowが `task-supervisor-dashboard-0.4.0.vsix` を配布します。push・公開・標準のコンテナ再作成は開発者が行います。

## 実装の配置

| ファイル                                                              | 責務                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/extension.ts`                                                    | VS Codeの入口・監視・一覧と操作の接続                        |
| `src/dashboardPanels.ts`                                              | 中央タブの再利用・Serializerによる同じワークスペースへの復元 |
| `src/boardReader.ts`                                                  | 4原票と常駐正本の読取り・整合確認                            |
| `src/boardModel.ts`                                                   | 共通行の順序と状態を保った表示項目の純粋な投影               |
| `src/userActionsView.ts`                                              | 共通wireの検証・表示用取得状態・操作候補の対応               |
| `src/boardFeed.ts`                                                    | 更新の集約・直列読取り・失敗時の表示保持                     |
| `src/dashboardTypes.ts`                                               | 表示データと固定メッセージの契約                             |
| `src/dashboardClient.ts`                                              | キー付きDOMの差分更新と状態保持                              |
| `src/dashboardWebview.ts` / `dashboardEntry.ts`                       | テーマとCSP・バンドル入口                                    |
| `src/actions.ts` / `answerEditor.ts`                                  | 確認と原文入力・行指定・回答の保持                           |
| `src/boardClient.ts` / `gateway.ts`                                   | 既存台帳CLIと共通の操作ポート                                |
| `src/backend.ts` / `runtimeGateway.ts` / `runtimeFiles.ts`            | 正本選択・契約v1操作・結果の照会                             |
| `src/executionCapture.ts` / `executionRunner.ts` / `executionView.ts` | 未配線の本人実行process/表示portと人工fixture用の境界        |
| `src/recordConnection.ts`                                             | 正式型付き操作と保存ack後read、開示設定のadapter             |
| `src/nodeExecutionProcess.ts`                                         | 所在確認後の実Bash stdinと有界stream観測                     |
| `src/contracts/records.ts` / `tools/sync-record-types.ts`             | 正式checkpointの型・定数だけを再現生成                       |
| `test/`                                                               | 振舞い・差分更新・読取り・実CLI補助・画面プレビュー          |

本文はテキストノードとして表示し、Webviewから実行ファイル・任意のCLI引数・任意URLを受け付けません。リンクも現在の表示にあるIDから解決します。CSPはnonce付きの固定スクリプトとCSSに限定します。
