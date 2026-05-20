import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// 拡張ホスト (Node) 側エントリ
const extOpts = {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
    minify: !watch,
    logLevel: 'info',
};

// webview (browser) 側エントリ。mermaid を含む bundle を media/webview.js に出力する。
const webviewOpts = {
    entryPoints: ['src/webviewMermaid.ts'],
    outfile: 'media/webview.js',
    bundle: true,
    platform: 'browser',
    target: 'es2020',
    format: 'iife',
    sourcemap: true,
    minify: !watch,
    logLevel: 'info',
};

if (watch) {
    const ctx1 = await esbuild.context(extOpts);
    const ctx2 = await esbuild.context(webviewOpts);
    await Promise.all([ctx1.watch(), ctx2.watch()]);
} else {
    await Promise.all([esbuild.build(extOpts), esbuild.build(webviewOpts)]);
}
