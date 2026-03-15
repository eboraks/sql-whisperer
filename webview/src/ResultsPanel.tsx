import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type { QueryResultsSnapshot, ResultsViewMessage, ResultsViewRequest } from '../../src/shared/messages';

declare const acquireVsCodeApi: () => {
  postMessage: (msg: ResultsViewRequest) => void;
};
const vscode = acquireVsCodeApi();

// ─── Utility ─────────────────────────────────────────────────────────────────
function exportToCsv(columns: string[], rows: Record<string, any>[]): void {
  const header = columns.join(',');
  const body = rows.map(row =>
    columns.map(col => {
      const val = row[col] ?? '';
      const str = String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(',')
  ).join('\n');
  const csv = `${header}\n${body}`;
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'results.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Components ───────────────────────────────────────────────────────────────
function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{
      background: color,
      color: 'var(--vscode-badge-foreground)',
      borderRadius: '3px',
      padding: '1px 6px',
      fontSize: '11px',
      fontWeight: 600,
      fontFamily: 'monospace',
    }}>
      {children}
    </span>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: Record<string, any>[] }) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
    setPage(0);
  };

  const filtered = filter
    ? rows.filter(row =>
        Object.values(row).some(v => String(v ?? '').toLowerCase().includes(filter.toLowerCase()))
      )
    : rows;

  const sorted = sortCol
    ? [...filtered].sort((a, b) => {
        const av = a[sortCol] ?? '';
        const bv = b[sortCol] ?? '';
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filtered;

  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '6px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
        <input
          placeholder="Filter results..."
          value={filter}
          onChange={e => { setFilter(e.target.value); setPage(0); }}
          style={{
            flex: 1,
            padding: '4px 8px',
            background: 'var(--vscode-input-background)',
            border: '1px solid var(--vscode-input-border)',
            color: 'var(--vscode-input-foreground)',
            borderRadius: '3px',
            fontSize: '12px',
          }}
        />
        <button
          onClick={() => exportToCsv(columns, filtered)}
          style={{
            padding: '4px 10px',
            background: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          ↓ CSV
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '12px',
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
        }}>
          <thead>
            <tr>
              {columns.map(col => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  style={{
                    padding: '5px 8px',
                    textAlign: 'left',
                    background: 'var(--vscode-editor-lineHighlightBackground)',
                    borderBottom: '1px solid var(--vscode-panel-border)',
                    cursor: 'pointer',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                    color: sortCol === col ? 'var(--vscode-textLink-foreground)' : 'var(--vscode-foreground)',
                    fontWeight: 600,
                  }}
                >
                  {col} {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((row, i) => (
              <tr key={i} style={{
                background: i % 2 === 0 ? 'transparent' : 'var(--vscode-list-hoverBackground)',
              }}>
                {columns.map(col => {
                  const val = row[col];
                  const display = val === null || val === undefined ? <em style={{ opacity: 0.4 }}>NULL</em> : String(val);
                  return (
                    <td key={col} style={{
                      padding: '3px 8px',
                      borderBottom: '1px solid var(--vscode-panel-border)',
                      maxWidth: '300px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--vscode-foreground)',
                    }}>
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', flexShrink: 0 }}>
          <button
            disabled={page === 0}
            onClick={() => setPage(p => p - 1)}
            style={{ padding: '2px 8px', cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1 }}
          >
            ‹
          </button>
          <span style={{ color: 'var(--vscode-foreground)' }}>
            Page {page + 1} of {totalPages} ({sorted.length} rows)
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage(p => p + 1)}
            style={{ padding: '2px 8px', cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1 }}
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function ResultsApp() {
  const [state, setState] = useState<'idle' | 'loading' | 'results' | 'error'>('idle');
  const [snapshot, setSnapshot] = useState<QueryResultsSnapshot | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ResultsViewMessage;
      switch (msg.command) {
        case 'results:loading':
          setState('loading');
          break;
        case 'results:showData':
          setSnapshot(msg.data);
          setState(msg.data.error ? 'error' : 'results');
          break;
        case 'results:clear':
          setState('idle');
          setSnapshot(null);
          break;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ command: 'webview:ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  if (state === 'idle') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.5, flexDirection: 'column', gap: '8px' }}>
        <div style={{ fontSize: '32px' }}>⬡</div>
        <div style={{ fontSize: '13px', color: 'var(--vscode-foreground)' }}>Run a query with Cmd+Enter</div>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.6, gap: '8px' }}>
        <div style={{ fontSize: '13px', color: 'var(--vscode-foreground)' }}>Executing query...</div>
      </div>
    );
  }

  if (!snapshot) { return null; }

  const queryTypeBadgeColor = {
    select: 'var(--vscode-gitDecoration-addedResourceForeground)',
    insert: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
    update: 'var(--vscode-charts-orange)',
    delete: 'var(--vscode-gitDecoration-deletedResourceForeground)',
    other: 'var(--vscode-descriptionForeground)',
  }[snapshot.queryType] || 'var(--vscode-descriptionForeground)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '6px', boxSizing: 'border-box', gap: '8px', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
        <Badge color={queryTypeBadgeColor}>{snapshot.queryType.toUpperCase()}</Badge>
        {snapshot.executionMs !== undefined && (
          <span style={{ fontSize: '11px', opacity: 0.7, color: 'var(--vscode-foreground)' }}>
            {snapshot.executionMs}ms
          </span>
        )}
        {snapshot.rows !== undefined && (
          <span style={{ fontSize: '11px', opacity: 0.7, color: 'var(--vscode-foreground)' }}>
            {snapshot.rows.length} rows
          </span>
        )}
        {snapshot.rowsAffected !== undefined && snapshot.queryType !== 'select' && (
          <span style={{ fontSize: '11px', opacity: 0.7, color: 'var(--vscode-foreground)' }}>
            {snapshot.rowsAffected} affected
          </span>
        )}
      </div>

      {/* Error */}
      {snapshot.error && (
        <div style={{
          padding: '8px 12px',
          background: 'var(--vscode-inputValidation-errorBackground)',
          border: '1px solid var(--vscode-inputValidation-errorBorder)',
          borderRadius: '4px',
          fontSize: '12px',
          color: 'var(--vscode-inputValidation-errorForeground)',
          fontFamily: 'monospace',
          flexShrink: 0,
        }}>
          ⚠️ {snapshot.error}
        </div>
      )}

      {/* Query preview */}
      <details style={{ flexShrink: 0 }}>
        <summary style={{ fontSize: '11px', opacity: 0.6, cursor: 'pointer', userSelect: 'none' }}>
          Query
        </summary>
        <pre style={{
          fontSize: '11px',
          margin: '4px 0 0',
          padding: '6px',
          background: 'var(--vscode-textCodeBlock-background)',
          borderRadius: '3px',
          overflow: 'auto',
          maxHeight: '100px',
          color: 'var(--vscode-foreground)',
        }}>
          {snapshot.query}
        </pre>
      </details>

      {/* Results table */}
      {snapshot.rows && snapshot.columns && snapshot.rows.length > 0 && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <DataTable columns={snapshot.columns} rows={snapshot.rows} />
        </div>
      )}

      {snapshot.rows && snapshot.rows.length === 0 && !snapshot.error && (
        <div style={{ opacity: 0.5, fontSize: '12px', textAlign: 'center', marginTop: '16px' }}>
          Query returned 0 rows.
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('results-root')!);
root.render(<ResultsApp />);
