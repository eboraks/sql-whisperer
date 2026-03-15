import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import cytoscape from 'cytoscape';
import coseBilkent from 'cytoscape-cose-bilkent';
import type { GraphPayload, GraphViewMessage, GraphViewRequest } from '../../src/shared/messages';

cytoscape.use(coseBilkent as any);

declare const acquireVsCodeApi: () => { postMessage: (msg: GraphViewRequest) => void };
const vscode = acquireVsCodeApi();

// ─── Read VS Code CSS variables at runtime (Cytoscape canvas ignores var()) ──
function getCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function buildGraphStyles(): cytoscape.Stylesheet[] {
  const btnBg = getCssVar('--vscode-button-background', '#0e639c');
  const focusBorder = getCssVar('--vscode-focusBorder', '#007fd4');
  const panelBorder = getCssVar('--vscode-panel-border', '#888');
  const descFg = getCssVar('--vscode-descriptionForeground', '#ccc');
  const editorBg = getCssVar('--vscode-editor-background', '#1e1e1e');
  const fontFamily = getCssVar('--vscode-font-family', 'sans-serif');

  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        shape: 'round-rectangle',
        'background-color': btnBg,
        'border-width': 2,
        'border-color': focusBorder,
        color: '#fff',
        'text-valign': 'top',
        'text-halign': 'left',
        'text-margin-x': 4,
        'text-margin-y': 4,
        'text-wrap': 'wrap',
        'font-size': '11px',
        'font-family': fontFamily,
        'padding-top': '8px',
        'padding-bottom': '8px',
        'padding-left': '12px',
        'padding-right': '12px',
        width: 'label',
        height: 'label',
      } as any,
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': '#fff',
        'border-width': 3,
        'background-color': '#1f8ad2',
      } as any,
    },
    {
      selector: '.search-highlight',
      style: {
        'border-color': '#f0b72f',
        'border-width': 3,
        'background-color': '#1f8ad2',
      } as any,
    },
    {
      selector: 'edge',
      style: {
        width: 2,
        'line-color': panelBorder,
        'target-arrow-color': panelBorder,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': '10px',
        color: descFg,
        'text-background-color': editorBg,
        'text-background-opacity': 0.8,
        'text-background-padding': '2px',
      } as any,
    },
    {
      selector: 'edge:selected',
      style: {
        'line-color': '#007fd4',
        'target-arrow-color': '#007fd4',
      } as any,
    },
  ];
}

// ─── Node Detail Panel ────────────────────────────────────────────────────────
function NodeDetail({ node, onClose }: { node: cytoscape.NodeSingular; onClose: () => void }) {
  const data = node.data();
  const props: Record<string, string> = data.properties || {};

  return (
    <div style={{
      position: 'absolute', top: 8, right: 8,
      background: 'var(--vscode-editor-background)',
      border: '1px solid var(--vscode-panel-border)',
      borderRadius: '6px', padding: '12px', minWidth: '200px',
      fontSize: '12px', zIndex: 100,
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <strong style={{ color: 'var(--vscode-foreground)' }}>{data.label}</strong>
        <span style={{ cursor: 'pointer', opacity: 0.6, fontSize: '14px' }} onClick={onClose}>✕</span>
      </div>
      {data.schema && (
        <div style={{ opacity: 0.6, marginBottom: '6px', fontSize: '11px' }}>
          schema: {data.schema}
        </div>
      )}
      {Object.entries(props).length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {Object.entries(props).map(([col, type]) => (
              <tr key={col}>
                <td style={{ padding: '2px 4px', color: 'var(--vscode-foreground)' }}>{col}</td>
                <td style={{ padding: '2px 4px', opacity: 0.6, fontFamily: 'monospace' }}>{type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function GraphApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [selectedNode, setSelectedNode] = useState<cytoscape.NodeSingular | null>(null);
  const [state, setState] = useState<'idle' | 'graph'>('idle');
  const [stats, setStats] = useState<{ nodes: number; edges: number } | null>(null);

  const showGraph = (payload: GraphPayload) => {
    if (!containerRef.current) { return; }

    if (cyRef.current) {
      cyRef.current.destroy();
    }

    const elements: cytoscape.ElementDefinition[] = [
      ...payload.nodes.map(n => ({
        data: {
          id: n.id,
          label: n.label,
          schema: n.schema,
          columnCount: n.columnCount,
          properties: n.properties || {},
        },
      })),
      ...payload.edges.map(e => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
        },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: buildGraphStyles(),
      layout: {
        name: 'cose-bilkent',
        animate: false,
        nodeDimensionsIncludeLabels: true,
        idealEdgeLength: 120,
        nodeRepulsion: 8000,
        padding: 30,
      } as any,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

    cy.on('tap', 'node', (evt) => {
      setSelectedNode(evt.target);
    });

    cy.on('tap', (evt) => {
      if (evt.target === cy) { setSelectedNode(null); }
    });

    // Tooltip on hover showing full table name
    const tooltip = document.createElement('div');
    tooltip.style.cssText =
      'position:fixed;padding:4px 8px;background:var(--vscode-editorHoverWidget-background,#252526);' +
      'color:var(--vscode-editorHoverWidget-foreground,#ccc);border:1px solid var(--vscode-editorHoverWidget-border,#454545);' +
      'border-radius:3px;font-size:11px;pointer-events:none;z-index:1000;display:none;white-space:nowrap;';
    document.body.appendChild(tooltip);

    cy.on('mouseover', 'node', (evt) => {
      const node = evt.target;
      const schema = node.data('schema');
      const label = node.data('label');
      const count = node.data('columnCount');
      tooltip.textContent = `${schema ? schema + '.' : ''}${label}${count ? ` (${count} columns)` : ''}`;
      tooltip.style.display = 'block';
    });
    cy.on('mousemove', 'node', (evt) => {
      const e = evt.originalEvent as MouseEvent;
      tooltip.style.left = `${e.clientX + 12}px`;
      tooltip.style.top = `${e.clientY + 12}px`;
    });
    cy.on('mouseout', 'node', () => {
      tooltip.style.display = 'none';
    });

    cyRef.current = cy;
    setStats({ nodes: payload.nodes.length, edges: payload.edges.length });
    setState('graph');
  };

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as GraphViewMessage;
      switch (msg.command) {
        case 'graph:showResults':
          showGraph(msg.data);
          break;
        case 'graph:clear':
          cyRef.current?.destroy();
          cyRef.current = null;
          setState('idle');
          setSelectedNode(null);
          setStats(null);
          break;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ command: 'webview:ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const [searchTerm, setSearchTerm] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const fitGraph = () => cyRef.current?.fit(undefined, 30);
  const resetZoom = () => cyRef.current?.reset();
  const zoomIn = () => {
    const cy = cyRef.current;
    if (cy) { cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); }
  };
  const zoomOut = () => {
    const cy = cyRef.current;
    if (cy) { cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); }
  };
  const exportPng = () => {
    if (!cyRef.current) { return; }
    const png = cyRef.current.png({ scale: 2, full: true });
    const a = document.createElement('a');
    a.href = png;
    a.download = 'schema-graph.png';
    a.click();
  };

  const handleSearch = (term: string) => {
    setSearchTerm(term);
    const cy = cyRef.current;
    if (!cy) { return; }

    // Clear previous highlights
    cy.nodes().removeClass('search-highlight');

    if (!term.trim()) { return; }

    const matches = cy.nodes().filter((node: any) =>
      node.data('label')?.toLowerCase().includes(term.toLowerCase())
    );

    if (matches.length > 0) {
      matches.addClass('search-highlight');
      // Focus on the first match
      cy.animate({ center: { eles: matches.first() }, zoom: 1.5, duration: 300 } as any);
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '4px 8px', flexShrink: 0,
        background: 'var(--vscode-editor-background)',
        borderBottom: '1px solid var(--vscode-panel-border)',
        flexWrap: 'wrap',
      }}>
        {stats && (
          <span style={{ fontSize: '11px', opacity: 0.6, color: 'var(--vscode-foreground)', marginRight: 4 }}>
            {stats.nodes} tables · {stats.edges} relationships
          </span>
        )}
        <input
          ref={searchRef}
          type="text"
          placeholder="Search tables..."
          value={searchTerm}
          onChange={(e) => handleSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { handleSearch(''); searchRef.current?.blur(); } }}
          style={{
            padding: '2px 6px', fontSize: '11px', width: '140px',
            background: 'var(--vscode-input-background, #3c3c3c)',
            color: 'var(--vscode-input-foreground, #ccc)',
            border: '1px solid var(--vscode-input-border, #3c3c3c)',
            borderRadius: '3px', outline: 'none',
          }}
        />
        <div style={{ flex: 1 }} />
        <button onClick={zoomIn} style={btnStyle} title="Zoom in">+</button>
        <button onClick={zoomOut} style={btnStyle} title="Zoom out">−</button>
        <button onClick={fitGraph} style={btnStyle} title="Fit to screen">⊡ Fit</button>
        <button onClick={resetZoom} style={btnStyle} title="Reset zoom">↺ Reset</button>
        <button onClick={exportPng} style={btnStyle} title="Export as PNG">↓ PNG</button>
      </div>

      {/* Graph canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        {state === 'idle' && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: '8px', opacity: 0.5,
          }}>
            <div style={{ fontSize: '40px' }}>⬡</div>
            <div style={{ fontSize: '13px', color: 'var(--vscode-foreground)' }}>
              Connect to a database to see the schema graph
            </div>
          </div>
        )}

        {selectedNode && (
          <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '3px 8px',
  background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
  color: 'var(--vscode-button-secondaryForeground, #ccc)',
  border: 'none',
  borderRadius: '3px',
  cursor: 'pointer',
  fontSize: '11px',
};

const root = createRoot(document.getElementById('graph-root')!);
root.render(<GraphApp />);
