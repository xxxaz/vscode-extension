import { createServer } from 'node:http';
import { build } from 'esbuild';

// 表示だけの人工fixture。本人実行・台帳・DBの操作経路は持たない。
const shownCommand =
    "printf '%s\\n' '確認した本文'\nprintf '%s\\n' 'stderr' >&2\n";
const entry = `
import { mountExecutionPreview, mountExecutionOutput, mountResultAccess } from './src/executionView.ts';
const host=document.querySelector('main');
const preview=mountExecutionPreview(host,{command:${JSON.stringify(shownCommand)},requestLabel:'U1 / 固定版の実行（表示fixture）',workingDirectory:'/workspace',documents:[{label:'固定資料@1',body:'<script>も資料の原文として表示します\\n'}]},()=>{},()=>{});
const output=mountExecutionOutput(host);
let seq=0;
window.fixture={ append(text){output.showSaved({sequence:++seq,stream:seq%2?'stdout':'stderr',text,byteLength:new TextEncoder().encode(text).length,sha256:'fixture'});}, preview };
for(let i=0;i<150;i++)window.fixture.append('保存済み出力 '+i+'\\n');
output.status('人工fixture: 正式DBの保存後readに相当する表示です');
let revision=0,allow=false;
const access=mountResultAccess(host,{async read(){return{context:{revision},canChangeDisclosure:true,userDisplay:'本人の画面',databaseStorage:'表示fixture',aiDisclosure:allow?'allowed':'denied',resultConfirmation:'needsOkとは別'};},async changeDisclosure(context,value){if(context.revision!==revision)throw Error('版競合');allow=value;revision++;}});
await access.load();
`;
const result = await build({
    stdin: {
        contents: entry,
        resolveDir: process.cwd(),
        sourcefile: 'execution-preview-entry.ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
});
const script = result.outputFiles[0].text;
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>本人実行の表示fixture</title><style>body{background:var(--bg,#202124);color:var(--fg,#eee);font:15px sans-serif;margin:24px}main{max-width:960px;margin:auto}section{border:1px solid #777;padding:16px;margin:12px 0}.field-value{white-space:pre-wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px monospace;background:#7772;padding:10px}button{padding:6px 12px;margin:8px}input{margin:8px}</style><main><h1>本人実行の表示確認</h1><p>人工fixture。実コマンドや実台帳は操作しません。</p></main><script type="module" src="/fixture.js"></script></html>`;
const server = createServer((request, response) => {
    if (request.url === '/fixture.js') {
        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.end(script);
    } else if (request.url === '/') {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(html);
    } else if (request.url === '/favicon.ico') {
        response.statusCode = 204;
        response.end();
    } else {
        response.statusCode = 404;
        response.end();
    }
});
server.listen(8894, '0.0.0.0', () =>
    console.log('表示fixture: http://localhost:8894 （実行操作なし）'),
);
