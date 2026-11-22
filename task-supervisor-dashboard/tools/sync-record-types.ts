#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// 型と定数だけを正式checkpointから抽出する。parser・業務処理は複製しない。
const checkpoint = '1cd5c8787d5434bb0c167d686ee7462f9d8b9077';
const root = process.argv[2];
if (!root) throw new Error('正式リポジトリのパスを指定してください');
const prefix = '.agents/skills/task-supervisor/runtime/';
const selected = new Set([
    'RecordCommandHeader',
    'RecordOperation',
    'RecordCommand',
    'RecordPrivilege',
    'RecordCaller',
    'RecordRead',
    'RecordTransportAccess',
    'RecordResult',
]);
const parts = [
    `// 自動生成。tools/sync-record-types.ts で再生成してください。`,
    `// 正式checkpoint: ${checkpoint}`,
];
for (const file of [
    'record-protocol.ts',
    'record-values.ts',
    'record-engine.ts',
]) {
    const source = execFileSync(
        'git',
        ['-C', resolve(root), 'show', `${checkpoint}:${prefix}${file}`],
        { encoding: 'utf8' },
    );
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    parts.push(
        `// ${file} SHA256: ${createHash('sha256').update(source).digest('hex')}`,
    );
    for (const statement of ast.statements) {
        if (
            ts.isTypeAliasDeclaration(statement) &&
            statement.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.ExportKeyword,
            ) &&
            (file === 'record-values.ts' || selected.has(statement.name.text))
        )
            parts.push(statement.getText(ast));
        if (
            file === 'record-protocol.ts' &&
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (d) => d.name.getText(ast) === 'RECORD_LIMITS',
            )
        )
            parts.push(statement.getText(ast));
    }
}
const text = `${parts.join('\n\n')}\n`;
const target = fileURLToPath(
    new URL('../src/contracts/records.ts', import.meta.url),
);
if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== text)
        throw new Error('正式型の生成物が一致しません');
    console.log('正式checkpointの型と定数が一致しました');
} else writeFileSync(target, text);
