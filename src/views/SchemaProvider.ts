import * as vscode from 'vscode';
import type { SchemaInfo, TableInfo, ColumnInfo } from '../shared/messages';
import type { ConnectionManager } from '../db/ConnectionManager';

export type SchemaItemType = 'root' | 'schema-group' | 'table' | 'columns-group' | 'fk-group' | 'column' | 'fk' | 'message';

export class SchemaItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: SchemaItemType,
    public readonly meta?: {
      schemaName?: string;
      tableName?: string;
      tableInfo?: TableInfo;
      columnInfo?: ColumnInfo;
      fkTable?: string;
      fkColumn?: string;
    }
  ) {
    super(label, collapsibleState);
    this.tooltip = label;
    this.contextValue = type;

    switch (type) {
      case 'schema-group':
        this.iconPath = new vscode.ThemeIcon('database');
        break;
      case 'table':
        this.iconPath = new vscode.ThemeIcon('symbol-class');
        this.description = meta?.tableInfo?.columns.length
          ? `${meta.tableInfo.columns.length} cols`
          : undefined;
        break;
      case 'columns-group':
        this.iconPath = new vscode.ThemeIcon('list-unordered');
        break;
      case 'fk-group':
        this.iconPath = new vscode.ThemeIcon('references');
        break;
      case 'column':
        if (meta?.columnInfo?.isPrimaryKey) {
          this.iconPath = new vscode.ThemeIcon('key');
          this.description = meta.columnInfo.dataType;
        } else {
          this.iconPath = new vscode.ThemeIcon('symbol-field');
          this.description = meta?.columnInfo?.dataType;
        }
        break;
      case 'fk':
        this.iconPath = new vscode.ThemeIcon('arrow-right');
        this.description = `→ ${meta?.fkTable}.${meta?.fkColumn}`;
        break;
      case 'message':
        this.iconPath = new vscode.ThemeIcon('info');
        break;
    }
  }
}

export class SchemaProvider
  implements vscode.TreeDataProvider<SchemaItem>, vscode.TreeDragAndDropController<SchemaItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<SchemaItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  dropMimeTypes = ['text/uri-list'];
  dragMimeTypes = ['text/uri-list', 'text/plain'];

  private schema?: SchemaInfo;
  private filterTerm = '';
  private tableCache = new Map<string, TableInfo>();

  constructor(private connectionManager: ConnectionManager) {}

  // ─── Drag & Drop ───────────────────────────────────────────────────────────
  handleDrag(
    source: readonly SchemaItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void {
    const parts: string[] = [];
    for (const item of source) {
      if (item.type === 'table' && item.meta?.tableName) {
        const schemaPrefix = item.meta.schemaName && item.meta.schemaName !== 'main'
          ? `${item.meta.schemaName}.`
          : '';
        parts.push(`${schemaPrefix}${item.meta.tableName}`);
      } else if (item.type === 'column' && item.meta?.columnInfo) {
        parts.push(item.meta.columnInfo.name);
      } else if (item.type === 'fk' && item.meta?.fkTable) {
        parts.push(item.meta.fkTable);
      }
    }
    if (parts.length > 0) {
      dataTransfer.set('text/plain', new vscode.DataTransferItem(parts.join(', ')));
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────
  getTables(): TableInfo[] {
    return Array.from(this.tableCache.values());
  }

  getTableByName(name: string): TableInfo | undefined {
    return this.tableCache.get(name) ?? Array.from(this.tableCache.values()).find(
      t => t.name.toLowerCase() === name.toLowerCase()
    );
  }

  refresh(schema?: SchemaInfo): void {
    if (schema) {
      this.schema = schema;
      this.tableCache.clear();
      for (const table of schema.tables) {
        this.tableCache.set(`${table.schema}.${table.name}`, table);
      }
    }
    this._onDidChangeTreeData.fire();
  }

  async search(term: string): Promise<void> {
    this.filterTerm = term;
    this._onDidChangeTreeData.fire();
  }

  // ─── Tree Data Provider ────────────────────────────────────────────────────
  getTreeItem(element: SchemaItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SchemaItem): Promise<SchemaItem[]> {
    if (!this.connectionManager.isConnected) {
      const item = new SchemaItem('Click here to connect...', vscode.TreeItemCollapsibleState.None, 'message');
      item.command = {
        command: 'sqlwhisperer.connect',
        title: 'Connect to Database',
      };
      return [item];
    }

    if (!this.schema) {
      return [new SchemaItem('Loading schema...', vscode.TreeItemCollapsibleState.None, 'message')];
    }

    // ── Root level ───────────────────────────────────────────────────────────
    if (!element) {
      if (this.filterTerm) {
        return this.getFilteredResults();
      }

      // Group by schema name
      const schemas = new Map<string, TableInfo[]>();
      for (const table of this.schema.tables) {
        if (!schemas.has(table.schema)) { schemas.set(table.schema, []); }
        schemas.get(table.schema)!.push(table);
      }

      // If only one schema, show tables directly at root
      if (schemas.size === 1) {
        const [schemaName, tables] = [...schemas.entries()][0];
        return tables.map(t => this.makeTableItem(t, schemaName));
      }

      return [...schemas.entries()].map(([schemaName, tables]) =>
        new SchemaItem(
          `${schemaName} (${tables.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          'schema-group',
          { schemaName }
        )
      );
    }

    // ── Schema group → show tables ───────────────────────────────────────────
    if (element.type === 'schema-group' && element.meta?.schemaName) {
      const tables = this.schema.tables.filter(t => t.schema === element.meta!.schemaName);
      return tables.map(t => this.makeTableItem(t, element.meta!.schemaName!));
    }

    // ── Table → show columns-group + fk-group ────────────────────────────────
    if (element.type === 'table' && element.meta?.tableInfo) {
      const table = element.meta.tableInfo;
      const children: SchemaItem[] = [];

      // Columns group
      children.push(new SchemaItem(
        `Columns (${table.columns.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        'columns-group',
        { tableInfo: table }
      ));

      // FK group (if any)
      if (table.foreignKeys.length > 0) {
        children.push(new SchemaItem(
          `Foreign Keys (${table.foreignKeys.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          'fk-group',
          { tableInfo: table }
        ));
      }

      return children;
    }

    // ── Columns group → show columns ─────────────────────────────────────────
    if (element.type === 'columns-group' && element.meta?.tableInfo) {
      return element.meta.tableInfo.columns.map(col =>
        new SchemaItem(
          col.name,
          vscode.TreeItemCollapsibleState.None,
          'column',
          {
            tableName: element.meta!.tableInfo!.name,
            schemaName: element.meta!.tableInfo!.schema,
            columnInfo: col
          }
        )
      );
    }

    // ── FK group → show foreign keys ─────────────────────────────────────────
    if (element.type === 'fk-group' && element.meta?.tableInfo) {
      return element.meta.tableInfo.foreignKeys.map(fk =>
        new SchemaItem(
          fk.columnName,
          vscode.TreeItemCollapsibleState.None,
          'fk',
          {
            tableName: element.meta!.tableInfo!.name,
            fkTable: fk.referencedTable,
            fkColumn: fk.referencedColumn
          }
        )
      );
    }

    return [];
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  private makeTableItem(table: TableInfo, schemaName: string): SchemaItem {
    return new SchemaItem(
      table.name,
      vscode.TreeItemCollapsibleState.Collapsed,
      'table',
      { schemaName, tableName: table.name, tableInfo: table }
    );
  }

  private getFilteredResults(): SchemaItem[] {
    if (!this.schema) { return []; }
    const term = this.filterTerm.toLowerCase();
    const matches: SchemaItem[] = [];

    for (const table of this.schema.tables) {
      if (table.name.toLowerCase().includes(term)) {
        matches.push(this.makeTableItem(table, table.schema));
        continue;
      }
      for (const col of table.columns) {
        if (col.name.toLowerCase().includes(term)) {
          matches.push(new SchemaItem(
            `${table.name}.${col.name}`,
            vscode.TreeItemCollapsibleState.None,
            'column',
            { tableName: table.name, schemaName: table.schema, columnInfo: col }
          ));
        }
      }
    }

    if (matches.length === 0) {
      return [new SchemaItem(`No results for "${this.filterTerm}"`, vscode.TreeItemCollapsibleState.None, 'message')];
    }

    return matches;
  }
}
