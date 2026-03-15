# SQL Whisperer

**SQL Whisperer** is a professional-grade VS Code extension for SQL development — inspired by [SPARQL Whisperer](https://github.com/eboraks/graph-whisperer). It combines a powerful schema explorer, query execution engine, visual results, schema graph, and an AI assistant powered by Claude.

---

## Features

### 🔍 Schema Explorer
- Tree view: **databases → schemas → tables → columns & foreign keys**
- Icons differentiate primary keys 🔑, columns, and FK relationships
- **Smart Drag & Drop** — drag a table or column name directly into your SQL editor
- Search across all tables and columns

### ⚡ Query Execution
- Run queries with **Cmd+Enter** in any `.sql` file
- Supports **SELECT** (with partial selection support), **INSERT**, **UPDATE**, **DELETE**, **DDL**
- Detects query type automatically

### 📊 Table Visualization
- Sortable, filterable data grid for SELECT results
- Pagination for large result sets (100 rows/page)
- **Export to CSV** with one click
- NULL values displayed clearly

### ⬡ Schema Graph Visualization
- Interactive force-directed graph: **tables = nodes, foreign keys = edges**
- Click any node to inspect its columns and types
- Fit, reset zoom, and **export as PNG**
- Auto-renders whenever you connect or refresh schema

### 🧠 AI Assistant (Claude)
- `@sql` chat participant in VS Code's built-in chat
- Schema-aware: the agent always knows your tables, columns, and relationships
- Latest query results automatically shared with the agent
- Ask in natural language: *"Write a query that finds all orders placed in the last 30 days"*
- Follow up: *"@sql Now group them by customer and sort by total"*

### 🔌 Built-in MCP Server
- Auto-starts at `http://localhost:3331/sse`
- Exposes tools for Cursor, Claude Code, Windsurf, and any MCP-compatible AI tool:
  - `sql_query` — execute any SQL
  - `get_schema` — introspect tables, columns, FK relationships
  - `fix_query` — pass a failing query + error, get a corrected version
  - `explain_query` — get plain-English explanation of a query
  - `read_query_results` — read the latest results without re-running

---

## Supported Databases

| Database | Driver | Default Port |
|---|---|---|
| PostgreSQL | `pg` | 5432 |
| MySQL / MariaDB | `mysql2` | 3306 |
| SQLite | `better-sqlite3` | (file path) |
| SQL Server | `mssql` | 1433 |

---

## Installation

### From Source
```bash
git clone https://github.com/your-org/sql-whisperer.git
cd sql-whisperer
npm install
npm run build:webview
# Press F5 in VS Code to launch the Extension Host
```

---

## Configuration

Go to **Settings > Extensions > SQL Whisperer**:

| Setting | Description | Default |
|---|---|---|
| `sqlwhisperer.dbType` | Database type | `postgresql` |
| `sqlwhisperer.host` | Server hostname | `localhost` |
| `sqlwhisperer.port` | Server port | `5432` |
| `sqlwhisperer.database` | Database name (or SQLite file path) | |
| `sqlwhisperer.username` | Username | |
| `sqlwhisperer.password` | Password (plain text — use command for secure) | |
| `sqlwhisperer.ssl` | Enable SSL/TLS | `false` |
| `sqlwhisperer.anthropic.apiKey` | Anthropic API key (use command for secure) | |
| `sqlwhisperer.anthropic.model` | Claude model | `claude-sonnet-4-20250514` |
| `sqlwhisperer.mcp.enabled` | Auto-start MCP server | `true` |
| `sqlwhisperer.mcp.port` | MCP server port | `3331` |

### Secure Credential Storage

Use the Command Palette (`Cmd+Shift+P`):
- **SQL Whisperer: Set Connection Password** — stores password in VS Code SecretStorage
- **SQL Whisperer: Set Anthropic API Key** — stores API key securely

---

## MCP Server Setup

The MCP server starts automatically when the extension activates.

### Connect Claude Code
```bash
claude mcp add sql-whisperer --transport sse http://localhost:3331/sse
```

### Connect Cursor
1. Open **Cursor Settings → Features → MCP**
2. Click **+ Add New Server**
3. Set Name: `SQL Whisperer`, Type: `sse`, URL: `http://localhost:3331/sse`

### Available MCP Tools

| Tool | Description |
|---|---|
| `sql_query` | Execute any SQL query |
| `get_schema` | Get full schema with tables, columns, and FK relationships |
| `fix_query` | Fix a failing query given the error message |
| `explain_query` | Explain what a SQL query does in plain English |
| `read_query_results` | Read the latest query results without re-running |

---

## Usage Examples

### 1. Writing a Query with AI
Open the Chat view (`Cmd+Shift+I`) and type:
```
@sql Show me the top 10 customers by total order value, with their email
```
The agent will inspect your schema and generate a valid JOIN query.

### 2. Drag & Drop
1. Open the **SQL Whisperer** sidebar
2. Expand a table in the Schema Explorer
3. Drag the table name (or a column) into your `.sql` editor

### 3. Fixing a Query
Run a query that errors, then:
```
@sql The query failed with "column users.email does not exist" — fix it
```
The agent has access to your actual schema and last query, so it can correct it immediately.

### 4. Analyzing Results
After running a query:
```
@sql What does the distribution of order_status look like in these results?
```

---

## Architecture

```
src/
├── extension.ts          # Activation, command registration
├── db/
│   └── ConnectionManager.ts  # pg / mysql2 / sqlite / mssql adapters
├── views/
│   └── SchemaProvider.ts     # Tree view: tables, columns, FK
├── panels/
│   └── ResultsPanel.ts       # Webview: sortable/filterable results table
├── graph/
│   └── SchemaGraphProvider.ts  # Webview: Cytoscape schema graph
├── features/
│   └── SqlWhispererChat.ts   # @sql chat participant (Claude API)
├── mcp/
│   └── McpManager.ts         # Built-in MCP SSE server
└── shared/
    └── messages.ts           # Shared types between host and webviews

webview/src/
├── ResultsPanel.tsx      # React: data table with sort/filter/export
└── SchemaGraph.tsx       # React + Cytoscape: interactive schema graph
```

---

## License

AGPL-3.0-or-later
