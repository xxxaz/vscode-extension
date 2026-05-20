import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// 拡張ホスト (Node) 側エントリのみ。webview は持たない。
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

if (watch) {
    const ctx = await esbuild.context(extOpts);
    await ctx.watch();
} else {
    await esbuild.build(extOpts);
}
