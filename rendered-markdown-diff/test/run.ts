const { build }: typeof import('esbuild') = require('esbuild');
const {
    spawnSync,
}: typeof import('node:child_process') = require('node:child_process');
const { resolve }: typeof import('node:path') = require('node:path');

async function main(): Promise<void> {
    await build({
        entryPoints: [
            'test/checkboxes.test.ts',
            'test/checkboxEditing.test.ts',
            'test/webview.test.ts',
        ],
        outdir: 'out/test',
        bundle: true,
        platform: 'node',
        format: 'cjs',
        alias: { vscode: resolve('test/vscodeMock.ts') },
    });
    const result = spawnSync(
        process.execPath,
        [
            '--test',
            'out/test/checkboxes.test.js',
            'out/test/checkboxEditing.test.js',
            'out/test/webview.test.js',
        ],
        { stdio: 'inherit' }
    );
    process.exitCode = result.status ?? 1;
}
main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
