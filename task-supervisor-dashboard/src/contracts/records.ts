// 自動生成。tools/sync-record-types.ts で再生成してください。

// 正式checkpoint: 1cd5c8787d5434bb0c167d686ee7462f9d8b9077

// record-protocol.ts SHA256: 499ed0a52b4499852ddd2eb856366d94a1c8cb5ab3e6032205e40fe83fca88c8

export const RECORD_LIMITS = {
    documentBytes: 256 * 1024,
    chunkBytes: 16 * 1024,
    attemptBytes: 8 * 1024 * 1024,
    outputBudgetBytes: 256 * 1024 * 1024,
    chunks: 4096,
    metadataReservePerChunk: 4096,
} as const;

export type RecordCommandHeader = {
    schemaVersion: 1;
    commandId: string;
    targetId: string;
    expectedVersion: number;
    source: string;
};

export type RecordOperation =
    | {
          type: 'document.publish';
          payload: {
              documentId?: string;
              expectedRevision: number;
              title: string;
              body: string;
          };
      }
    | {
          type: 'execution.prepare';
          payload: { actionId: string; requestVersion: string };
      }
    | {
          type: 'execution.claim';
          payload: { attemptId: string; requestVersion: string };
      }
    | {
          type: 'execution.started';
          payload: {
              attemptId: string;
              processIdentity: string;
              startedAt: number;
          };
      }
    | {
          type: 'execution.output';
          payload: {
              attemptId: string;
              seq: number;
              stream: 'stdout' | 'stderr';
              body: string;
              capturedAt: number;
          };
      }
    | {
          type: 'execution.finished';
          payload: {
              attemptId: string;
              outcome: 'exited' | 'signaled' | 'unknown';
              exitCode: number | null;
              signal: string | null;
              lastSeq: number;
              complete: boolean;
              missingStdoutBytes: number | null;
              missingStderrBytes: number | null;
          };
      }
    | {
          type: 'execution.disclosure';
          payload: {
              attemptId: string;
              expectedRevision: number;
              allow: boolean;
          };
      };

export type RecordCommand = RecordCommandHeader & RecordOperation;

export type RecordPrivilege =
    | 'documents.write'
    | 'documents.read'
    | 'executions.prepare'
    | 'executions.run'
    | 'executions.read'
    | 'executions.output.read'
    | 'executions.disclose';

export type RecordCaller = {
    subject: string;
    taskIds: readonly string[];
    privileges: readonly RecordPrivilege[];
    audience: 'person' | 'agent';
    runnerId?: string;
    policyRef?: string;
    recipient?: { recipientKey: string; assignmentGeneration: number };
    authorizeNonSensitiveCommand?: (command: string) => boolean;
};

export type RecordRead = {
    schemaVersion: 1;
    requestId: string;
    targetId: string;
} & (
    | { type: 'document.read'; documentId: string; revision: number }
    | { type: 'execution.read'; attemptId: string }
    | { type: 'execution.output.read'; attemptId: string; afterSeq: number }
);

export type RecordTransportAccess = {
    commandCaller(command: RecordCommand): RecordCaller | undefined;
    queryCaller(query: RecordRead): RecordCaller | undefined;
};

// record-values.ts SHA256: af22307bdff9d6eba2c0ea15a4a537415a6b4f69bf2d1e603e54f439bde9538a

export type DocumentRecord = {
    schemaVersion: 1;
    documentId: string;
    revision: number;
    taskId: string;
    title: string;
    contentType: 'text/markdown';
    body: string;
    sha256: string;
    utf8Bytes: number;
    createdAt: number;
    createdBy: string;
    sourceRef: null;
};

export type ExecutionAttempt = {
    schemaVersion: 1;
    attemptId: string;
    taskId: string;
    actionId: string;
    requestVersion: string;
    command: string;
    commandSha256: string;
    executionWhere: 'devcontainer';
    confirmedBy: string;
    runnerId: string;
    policyRef: string;
    createdAt: number;
};

export type ExecutionOutcome = {
    outcome: 'exited' | 'signaled' | 'unknown';
    exitCode: number | null;
    signal: string | null;
};

export type ExecutionState = {
    schemaVersion: 1;
    attemptId: string;
    status: 'prepared' | 'launching' | 'running' | 'ended' | 'unknown';
    claimedAt: number | null;
    startedAt: number | null;
    processIdentity: string | null;
    lastSeq: number;
    capturedBytes: number;
    encodedBytes: number;
    reservedBytes: number;
    limited: boolean;
    integrity: 'unknown' | 'complete' | 'incomplete';
    endedAt: number | null;
    result: ExecutionOutcome | null;
    observedLastSeq: number | null;
    missingStdoutBytes: number | null;
    missingStderrBytes: number | null;
    disclosure: {
        revision: number;
        allow: boolean;
        changedBy: string | null;
        changedAt: number | null;
    };
};

export type ExecutionOutput = {
    attemptId: string;
    seq: number;
    stream: 'stdout' | 'stderr';
    body: string;
    sha256: string;
    utf8Bytes: number;
    capturedAt: number;
    storedAt: number;
};

export type RecordNamespace =
    | 'document'
    | 'execution-attempt'
    | 'execution-state'
    | 'execution-output'
    | 'records-control';

export type RecordKey =
    | `document:${string}`
    | `execution-attempt:${string}`
    | `execution-state:${string}`
    | `execution-output:${string}`
    | 'records-control:output-budget'
    | `records-control:document-head:${string}`
    | `records-control:action-attempt:${string}`;

export type RecordValue<K extends RecordKey> = K extends `document:${string}`
    ? DocumentRecord
    : K extends `execution-attempt:${string}`
      ? ExecutionAttempt
      : K extends `execution-state:${string}`
        ? ExecutionState
        : K extends `execution-output:${string}`
          ? ExecutionOutput
          : K extends 'records-control:output-budget'
            ? { used: number; reserved: number }
            : K extends `records-control:document-head:${string}`
              ? { revision: number; taskId: string }
              : K extends `records-control:action-attempt:${string}`
                ? { attemptId: string }
                : never;

export type KeysForNamespace<N extends RecordNamespace> = Extract<
    RecordKey,
    `${N}:${string}`
>;

export type MutableRecordKey = Extract<
    RecordKey,
    `execution-state:${string}` | `records-control:${string}`
>;

export type ExecutionMetadata = Omit<ExecutionAttempt, 'command'>;

export type ExecutionReadResult = {
    attempt: ExecutionAttempt | ExecutionMetadata;
    state: ExecutionState;
};

export type ExecutionOutputResult = {
    rows: ExecutionOutput[];
    nextSeq: number;
    more: boolean;
    integrity: ExecutionState['integrity'];
};

export type RecordReadResult<
    Type extends 'document.read' | 'execution.read' | 'execution.output.read',
> = Type extends 'document.read'
    ? DocumentRecord
    : Type extends 'execution.read'
      ? ExecutionReadResult
      : ExecutionOutputResult;

// record-engine.ts SHA256: 4976437807a7f0f2ee8c7b44ea31dfad621726146ab33a7d70985be4b4311336

export type RecordResult = {
    document?: {
        documentId: string;
        revision: number;
        sha256: string;
        utf8Bytes: number;
    };
    attemptId?: string;
    status?: ExecutionState['status'];
    seq?: number;
    stored?: boolean;
    drain?: boolean;
    nextSeq?: number;
    outputComplete?: boolean;
    disclosureRevision?: number;
};
