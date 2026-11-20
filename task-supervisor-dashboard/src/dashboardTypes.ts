import type { Operation } from './boardClient.ts';

export type BoardTarget =
    | { kind: 'task'; id: string }
    | { kind: 'file'; path: string }
    | { kind: 'external'; uri: string };
export interface BoardLink {
    id: string;
    label: string;
    target: BoardTarget;
}
export interface BoardText {
    text: string;
    link?: BoardLink;
    code?: boolean;
}
export interface BoardField {
    label: string;
    parts: BoardText[];
    pre?: boolean;
}
export interface BoardOperation {
    operation: Operation;
    id: string;
    revision: string;
    label: string;
}
export interface BoardCard {
    id: string;
    title: string;
    summary: string;
    badge?: string;
    tone?: 'normal' | 'warning' | 'success';
    fields: BoardField[];
    links: BoardLink[];
    operations: BoardOperation[];
    command?: { id: string; revision: string; text: string };
}
export interface BoardSection {
    id: string;
    title: string;
    description?: string;
    defaultOpen: boolean;
    cards: BoardCard[];
}
export interface BoardSnapshot {
    schemaVersion: 1;
    source: 'legacy' | 'authoritative';
    workspace?: string;
    updatedAt: number;
    counts: { label: string; value: number; section: string }[];
    supervisor?: BoardLink;
    warnings: string[];
    sections: BoardSection[];
}
export type BoardMessage =
    | { type: 'ready' | 'refresh' }
    | { type: 'open'; linkId: string }
    | { type: 'copy-command'; id: string; revision: string }
    | { type: 'operation'; operation: Operation; id: string; revision: string };
export type BoardUpdate =
    | { type: 'snapshot'; snapshot: BoardSnapshot }
    | {
          type: 'status';
          message: string;
          failed?: boolean;
          busy?: boolean;
          state?: 'info' | 'pending' | 'success' | 'error';
      };
