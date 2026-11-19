import { build } from 'esbuild';

await build({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
});
await build({
    entryPoints: ['src/dashboardEntry.ts'],
    outfile: 'dist/dashboard.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
});
