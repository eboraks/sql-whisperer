// ─── Shared Types between Extension Host and Webviews ────────────────────────

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string;
}

export interface ForeignKeyInfo {
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
  constraintName?: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  rowCount?: number;
}

export interface SchemaInfo {
  dbType: string;
  database: string;
  tables: TableInfo[];
}

export interface QueryResultsSnapshot {
  query: string;
  queryType: 'select' | 'insert' | 'update' | 'delete' | 'other';
  rows?: Record<string, any>[];
  columns?: string[];
  rowsAffected?: number;
  graphSummary?: {
    nodeCount: number;
    edgeCount: number;
    nodeLabels: string[];
    edgeLabels: string[];
  };
  error?: string;
  timestamp: number;
  executionMs?: number;
}

// ─── Graph Payload ────────────────────────────────────────────────────────────
export interface GraphNode {
  id: string;
  label: string;
  schema?: string;
  columnCount?: number;
  properties?: Record<string, string>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  sourceColumn?: string;
  targetColumn?: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  queryType: 'schema' | 'query';
  tableCount?: number;
  edgeCount?: number;
}

// ─── Webview Messages: Results Panel ─────────────────────────────────────────
export type ResultsViewMessage =
  | { command: 'results:showData'; data: QueryResultsSnapshot }
  | { command: 'results:clear' }
  | { command: 'results:loading' };

export type ResultsViewRequest =
  | { command: 'webview:ready' }
  | { command: 'results:exportCsv' };

// ─── Webview Messages: Schema Graph ──────────────────────────────────────────
export type GraphViewMessage =
  | { command: 'graph:showResults'; data: GraphPayload }
  | { command: 'graph:clear' }
  | { command: 'graph:error'; message: string }
  | { command: 'graph:resourceDetailResult'; data: Record<string, string> };

export type GraphViewRequest =
  | { command: 'webview:ready' }
  | { command: 'graph:requestDetail'; tableId: string }
  | { command: 'graph:exportPng' };
