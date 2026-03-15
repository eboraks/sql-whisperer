import * as vscode from 'vscode';
import type { SchemaInfo, TableInfo, ColumnInfo, ForeignKeyInfo } from '../shared/messages';

export interface DbConnectionOptions {
  dbType: 'postgresql' | 'mysql' | 'sqlite' | 'mssql';
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

export interface DbQueryResult {
  rows: Record<string, any>[];
  columns: string[];
  rowsAffected?: number;
  executionMs: number;
}

// ─── Adapter Interface ────────────────────────────────────────────────────────
interface DbAdapter {
  connect(): Promise<void>;
  query(sql: string, params?: any[]): Promise<DbQueryResult>;
  getSchema(): Promise<SchemaInfo>;
  disconnect(): Promise<void>;
}

// ─── PostgreSQL Adapter ───────────────────────────────────────────────────────
class PostgresAdapter implements DbAdapter {
  private client: any;
  private pg: any;

  constructor(private opts: DbConnectionOptions) {}

  async connect(): Promise<void> {
    this.pg = require('pg');
    const { Client } = this.pg;
    this.client = this.opts.connectionString
      ? new Client({ connectionString: this.opts.connectionString })
      : new Client({
          host: this.opts.host,
          port: this.opts.port || 5432,
          database: this.opts.database,
          user: this.opts.username,
          password: this.opts.password,
          ssl: this.opts.ssl ? { rejectUnauthorized: false } : false,
        });
    await this.client.connect();
  }

  async query(sql: string, params?: any[]): Promise<DbQueryResult> {
    const start = Date.now();
    const result = await this.client.query(sql, params);
    return {
      rows: result.rows,
      columns: result.fields?.map((f: any) => f.name) ?? [],
      rowsAffected: result.rowCount ?? undefined,
      executionMs: Date.now() - start,
    };
  }

  async getSchema(): Promise<SchemaInfo> {
    const tablesResult = await this.client.query(`
      SELECT t.table_schema, t.table_name
      FROM information_schema.tables t
      WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_schema, t.table_name
    `);

    const tables: TableInfo[] = [];
    for (const row of tablesResult.rows) {
      const colsResult = await this.client.query(`
        SELECT
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = $1 AND tc.table_schema = $2
        ) pk ON pk.column_name = c.column_name
        WHERE c.table_name = $1 AND c.table_schema = $2
        ORDER BY c.ordinal_position
      `, [row.table_name, row.table_schema]);

      const fkResult = await this.client.query(`
        SELECT
          kcu.column_name,
          ccu.table_name AS referenced_table,
          ccu.column_name AS referenced_column,
          tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = $1 AND tc.table_schema = $2
      `, [row.table_name, row.table_schema]);

      tables.push({
        schema: row.table_schema,
        name: row.table_name,
        columns: colsResult.rows.map((c: any): ColumnInfo => ({
          name: c.column_name,
          dataType: c.data_type,
          nullable: c.is_nullable === 'YES',
          isPrimaryKey: c.is_primary_key === true,
          defaultValue: c.column_default,
        })),
        foreignKeys: fkResult.rows.map((fk: any): ForeignKeyInfo => ({
          columnName: fk.column_name,
          referencedTable: fk.referenced_table,
          referencedColumn: fk.referenced_column,
          constraintName: fk.constraint_name,
        })),
      });
    }

    return { dbType: 'postgresql', database: this.opts.database || '', tables };
  }

  async disconnect(): Promise<void> {
    await this.client?.end();
  }
}

// ─── MySQL Adapter ────────────────────────────────────────────────────────────
class MysqlAdapter implements DbAdapter {
  private conn: any;

  constructor(private opts: DbConnectionOptions) {}

  async connect(): Promise<void> {
    const mysql = require('mysql2/promise');
    this.conn = this.opts.connectionString
      ? await mysql.createConnection(this.opts.connectionString)
      : await mysql.createConnection({
          host: this.opts.host,
          port: this.opts.port || 3306,
          database: this.opts.database,
          user: this.opts.username,
          password: this.opts.password,
          ssl: this.opts.ssl ? {} : undefined,
        });
  }

  async query(sql: string, params?: any[]): Promise<DbQueryResult> {
    const start = Date.now();
    const [rows, fields] = await this.conn.execute(sql, params ?? []);
    return {
      rows: Array.isArray(rows) ? rows as Record<string, any>[] : [],
      columns: Array.isArray(fields) ? (fields as any[]).map((f: any) => f.name) : [],
      rowsAffected: (rows as any).affectedRows,
      executionMs: Date.now() - start,
    };
  }

  async getSchema(): Promise<SchemaInfo> {
    const db = this.opts.database || '';
    const [tableRows] = await this.conn.execute(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ? AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `, [db]);

    const tables: TableInfo[] = [];
    for (const row of tableRows as any[]) {
      const [colRows] = await this.conn.execute(`
        SELECT
          c.column_name, c.data_type, c.is_nullable, c.column_default,
          CASE WHEN c.column_key = 'PRI' THEN 1 ELSE 0 END AS is_primary_key
        FROM information_schema.columns c
        WHERE c.table_schema = ? AND c.table_name = ?
        ORDER BY c.ordinal_position
      `, [db, row.table_name]);

      const [fkRows] = await this.conn.execute(`
        SELECT
          kcu.column_name, kcu.referenced_table_name AS referenced_table,
          kcu.referenced_column_name AS referenced_column, kcu.constraint_name
        FROM information_schema.key_column_usage kcu
        JOIN information_schema.table_constraints tc
          ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND kcu.table_schema = ? AND kcu.table_name = ?
      `, [db, row.table_name]);

      tables.push({
        schema: db,
        name: row.table_name,
        columns: (colRows as any[]).map((c: any): ColumnInfo => ({
          name: c.column_name,
          dataType: c.data_type,
          nullable: c.is_nullable === 'YES',
          isPrimaryKey: c.is_primary_key === 1,
          defaultValue: c.column_default,
        })),
        foreignKeys: (fkRows as any[]).map((fk: any): ForeignKeyInfo => ({
          columnName: fk.column_name,
          referencedTable: fk.referenced_table,
          referencedColumn: fk.referenced_column,
          constraintName: fk.constraint_name,
        })),
      });
    }

    return { dbType: 'mysql', database: db, tables };
  }

  async disconnect(): Promise<void> {
    await this.conn?.end();
  }
}

// ─── SQLite Adapter ───────────────────────────────────────────────────────────
class SqliteAdapter implements DbAdapter {
  private db: any;

  constructor(private opts: DbConnectionOptions) {}

  async connect(): Promise<void> {
    const Database = require('better-sqlite3');
    this.db = new Database(this.opts.database);
  }

  async query(sql: string, _params?: any[]): Promise<DbQueryResult> {
    const start = Date.now();
    const isSelect = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(sql);
    if (isSelect) {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all();
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { rows, columns, executionMs: Date.now() - start };
    } else {
      const info = this.db.prepare(sql).run();
      return {
        rows: [],
        columns: [],
        rowsAffected: info.changes,
        executionMs: Date.now() - start,
      };
    }
  }

  async getSchema(): Promise<SchemaInfo> {
    const tableRows = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all();

    const tables: TableInfo[] = [];
    for (const row of tableRows) {
      const colRows = this.db.prepare(`PRAGMA table_info(${row.name})`).all();
      const fkRows = this.db.prepare(`PRAGMA foreign_key_list(${row.name})`).all();

      tables.push({
        schema: 'main',
        name: row.name,
        columns: colRows.map((c: any): ColumnInfo => ({
          name: c.name,
          dataType: c.type,
          nullable: c.notnull === 0,
          isPrimaryKey: c.pk > 0,
          defaultValue: c.dflt_value,
        })),
        foreignKeys: fkRows.map((fk: any): ForeignKeyInfo => ({
          columnName: fk.from,
          referencedTable: fk.table,
          referencedColumn: fk.to,
        })),
      });
    }

    return { dbType: 'sqlite', database: this.opts.database || 'main', tables };
  }

  async disconnect(): Promise<void> {
    this.db?.close();
  }
}

// ─── MSSQL Adapter ────────────────────────────────────────────────────────────
class MssqlAdapter implements DbAdapter {
  private pool: any;

  constructor(private opts: DbConnectionOptions) {}

  async connect(): Promise<void> {
    const mssql = require('mssql');
    this.pool = this.opts.connectionString
      ? await mssql.connect(this.opts.connectionString)
      : await mssql.connect({
          server: this.opts.host || 'localhost',
          port: this.opts.port || 1433,
          database: this.opts.database,
          user: this.opts.username,
          password: this.opts.password,
          options: { encrypt: this.opts.ssl ?? false, trustServerCertificate: true },
        });
  }

  async query(sql: string, _params?: any[]): Promise<DbQueryResult> {
    const start = Date.now();
    const result = await this.pool.request().query(sql);
    return {
      rows: result.recordset ?? [],
      columns: result.recordset?.columns ? Object.keys(result.recordset.columns) : [],
      rowsAffected: result.rowsAffected?.[0],
      executionMs: Date.now() - start,
    };
  }

  async getSchema(): Promise<SchemaInfo> {
    const tableResult = await this.pool.request().query(`
      SELECT t.TABLE_SCHEMA, t.TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES t
      WHERE t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
    `);

    const tables: TableInfo[] = [];
    for (const row of tableResult.recordset) {
      const colResult = await this.pool.request().query(`
        SELECT
          c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
          CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            AND tc.TABLE_NAME = '${row.TABLE_NAME}' AND tc.TABLE_SCHEMA = '${row.TABLE_SCHEMA}'
        ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.TABLE_NAME = '${row.TABLE_NAME}' AND c.TABLE_SCHEMA = '${row.TABLE_SCHEMA}'
        ORDER BY c.ORDINAL_POSITION
      `);

      const fkResult = await this.pool.request().query(`
        SELECT
          kcu.COLUMN_NAME, ccu.TABLE_NAME AS REFERENCED_TABLE,
          ccu.COLUMN_NAME AS REFERENCED_COLUMN, tc.CONSTRAINT_NAME
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc ON tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ccu ON rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
          AND tc.TABLE_NAME = '${row.TABLE_NAME}' AND tc.TABLE_SCHEMA = '${row.TABLE_SCHEMA}'
      `);

      tables.push({
        schema: row.TABLE_SCHEMA,
        name: row.TABLE_NAME,
        columns: colResult.recordset.map((c: any): ColumnInfo => ({
          name: c.COLUMN_NAME,
          dataType: c.DATA_TYPE,
          nullable: c.IS_NULLABLE === 'YES',
          isPrimaryKey: c.IS_PRIMARY_KEY === 1,
          defaultValue: c.COLUMN_DEFAULT,
        })),
        foreignKeys: fkResult.recordset.map((fk: any): ForeignKeyInfo => ({
          columnName: fk.COLUMN_NAME,
          referencedTable: fk.REFERENCED_TABLE,
          referencedColumn: fk.REFERENCED_COLUMN,
          constraintName: fk.CONSTRAINT_NAME,
        })),
      });
    }

    return { dbType: 'mssql', database: this.opts.database || '', tables };
  }

  async disconnect(): Promise<void> {
    await this.pool?.close();
  }
}

// ─── Connection Manager ───────────────────────────────────────────────────────
export class ConnectionManager implements vscode.Disposable {
  private adapter?: DbAdapter;
  private _connected = false;
  private _schema?: SchemaInfo;

  get isConnected(): boolean { return this._connected; }
  get cachedSchema(): SchemaInfo | undefined { return this._schema; }

  async connect(opts: DbConnectionOptions): Promise<void> {
    await this.disconnect();
    switch (opts.dbType) {
      case 'postgresql': this.adapter = new PostgresAdapter(opts); break;
      case 'mysql':      this.adapter = new MysqlAdapter(opts); break;
      case 'sqlite':     this.adapter = new SqliteAdapter(opts); break;
      case 'mssql':      this.adapter = new MssqlAdapter(opts); break;
      default: throw new Error(`Unsupported database type: ${opts.dbType}`);
    }
    await this.adapter.connect();
    this._connected = true;
  }

  async query(sql: string, params?: any[]): Promise<DbQueryResult> {
    if (!this.adapter || !this._connected) {
      throw new Error('Not connected to a database. Use sqlwhisperer.connect first.');
    }
    return this.adapter.query(sql, params);
  }

  async refreshSchema(): Promise<SchemaInfo> {
    if (!this.adapter || !this._connected) {
      throw new Error('Not connected to a database.');
    }
    this._schema = await this.adapter.getSchema();
    return this._schema;
  }

  async disconnect(): Promise<void> {
    if (this.adapter) {
      try { await this.adapter.disconnect(); } catch { /* ignore */ }
      this.adapter = undefined;
    }
    this._connected = false;
    this._schema = undefined;
  }

  dispose(): void {
    this.disconnect().catch(() => {});
  }
}
