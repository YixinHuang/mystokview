import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "portfolio.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,          -- westock 格式，如 sh600519
  name TEXT NOT NULL,
  quantity REAL NOT NULL,             -- 持仓数量（股/份）
  cost_price REAL NOT NULL,           -- 成本价
  open_date TEXT,                     -- 建仓日期 YYYY-MM-DD
  realized_pnl REAL NOT NULL DEFAULT 0, -- 已实现盈亏（元）
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS quote_cache (
  code TEXT PRIMARY KEY,
  name TEXT,
  price REAL,
  prev_close REAL,
  change_percent REAL,
  quote_time TEXT,
  fetched_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,                 -- user | assistant
  content TEXT NOT NULL,
  tools TEXT,                         -- assistant 消息的工具调用名列表（JSON 数组），历史恢复用
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS tech_snapshots (
  code TEXT NOT NULL,                 -- westock 代码
  date TEXT NOT NULL,                 -- 指标日期 YYYY-MM-DD（technical 返回的日期）
  payload TEXT NOT NULL,              -- JSON: { tech, chip, summary }
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS news_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: { news }
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS consensus_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: { consensus, rating, score, summary }
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS reports_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: { reports }
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS fund_flow_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: { flow, summary }
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS block_margin_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: { block, margin, summary }
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_news_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: { news, announcements }（万得 MCP 文档）
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_consensus_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: WindConsensusData（万得 MCP 机构一致预期）
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_risk_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: { tables }（万得 MCP 风险指标表）
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_events_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: { tables }（万得 MCP 公司事件表）
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_moneyflow_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: WindMoneyFlowData（万得 MCP 资金面数据）
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_valuation_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: stock_get_company_valuation 返回
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_updates_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: stock_get_company_updates 返回
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_technical_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: stock_get_technical_analysis 返回
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS wind_profile_snapshots (
  code TEXT NOT NULL,
  date TEXT NOT NULL,                 -- 快照日期（抓取当日）
  payload TEXT NOT NULL,              -- JSON: stock_get_company_profile 返回
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (code, date)
);
`);

export interface HoldingRow {
  id: number;
  code: string;
  name: string;
  quantity: number;
  cost_price: number;
  open_date: string | null;
  realized_pnl: number;
  created_at: string;
  updated_at: string;
}

/** 初始持仓数据（用户提供的 7 只标的，代码已转 westock 格式） */
const SEED_HOLDINGS: Array<{
  code: string;
  name: string;
  quantity: number;
  cost_price: number;
  open_date: string;
}> = [
  { code: "sh600519", name: "贵州茅台", quantity: 700, cost_price: 1310.1932, open_date: "2026-04-29" },
  { code: "sh688111", name: "金山办公", quantity: 2400, cost_price: 239.3894, open_date: "2026-05-06" },
  { code: "sz300253", name: "卫宁健康", quantity: 45000, cost_price: 8.5105, open_date: "2026-05-26" },
  { code: "sz159530", name: "机器人ETF易方达", quantity: 50000, cost_price: 1.4278, open_date: "2026-05-28" },
  { code: "sz159636", name: "港股通科技30ETF工银", quantity: 100000, cost_price: 0.5401, open_date: "2026-05-07" },
  { code: "sz300058", name: "蓝色光标", quantity: 2500, cost_price: 17.6722, open_date: "2026-05-07" },
  { code: "sz159590", name: "软件ETF汇添富", quantity: 20000, cost_price: 0.9, open_date: "2026-08-31" },
];

export function seedIfEmpty() {
  const count = (db.prepare("SELECT COUNT(*) AS c FROM holdings").get() as { c: number }).c;
  if (count > 0) return;
  const insert = db.prepare(
    "INSERT INTO holdings (code, name, quantity, cost_price, open_date) VALUES (@code, @name, @quantity, @cost_price, @open_date)"
  );
  const tx = db.transaction((rows: typeof SEED_HOLDINGS) => {
    for (const r of rows) insert.run(r);
  });
  tx(SEED_HOLDINGS);
  console.log(`[db] seeded ${SEED_HOLDINGS.length} holdings`);
}

export const holdingRepo = {
  list(): HoldingRow[] {
    return db.prepare("SELECT * FROM holdings ORDER BY id").all() as HoldingRow[];
  },
  getByCode(code: string): HoldingRow | undefined {
    return db.prepare("SELECT * FROM holdings WHERE code = ?").get(code) as HoldingRow | undefined;
  },
  create(h: { code: string; name: string; quantity: number; cost_price: number; open_date?: string }): HoldingRow {
    db.prepare(
      "INSERT INTO holdings (code, name, quantity, cost_price, open_date) VALUES (?, ?, ?, ?, ?)"
    ).run(h.code, h.name, h.quantity, h.cost_price, h.open_date ?? null);
    return this.getByCode(h.code)!;
  },
  update(code: string, patch: { quantity?: number; cost_price?: number; realized_pnl?: number }): HoldingRow | undefined {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.quantity !== undefined) { fields.push("quantity = ?"); values.push(patch.quantity); }
    if (patch.cost_price !== undefined) { fields.push("cost_price = ?"); values.push(patch.cost_price); }
    if (patch.realized_pnl !== undefined) { fields.push("realized_pnl = ?"); values.push(patch.realized_pnl); }
    if (fields.length === 0) return this.getByCode(code);
    fields.push("updated_at = datetime('now', 'localtime')");
    db.prepare(`UPDATE holdings SET ${fields.join(", ")} WHERE code = ?`).run(...values, code);
    return this.getByCode(code);
  },
  remove(code: string): boolean {
    const r = db.prepare("DELETE FROM holdings WHERE code = ?").run(code);
    return r.changes > 0;
  },
};

export const quoteCacheRepo = {
  upsertMany(quotes: Array<{ code: string; name: string; price: number; prevClose: number; changePercent: number; time: string }>) {
    const stmt = db.prepare(`
      INSERT INTO quote_cache (code, name, price, prev_close, change_percent, quote_time, fetched_at)
      VALUES (@code, @name, @price, @prevClose, @changePercent, @time, datetime('now', 'localtime'))
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name, price = excluded.price, prev_close = excluded.prev_close,
        change_percent = excluded.change_percent, quote_time = excluded.quote_time,
        fetched_at = excluded.fetched_at
    `);
    const tx = db.transaction((rows: typeof quotes) => {
      for (const q of rows) stmt.run(q);
    });
    tx(quotes);
  },
  get(codes: string[]): Map<string, { code: string; name: string; price: number; prevClose: number; changePercent: number; time: string }> {
    const map = new Map();
    if (codes.length === 0) return map;
    const placeholders = codes.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM quote_cache WHERE code IN (${placeholders})`).all(...codes) as any[];
    for (const r of rows) {
      map.set(r.code, {
        code: r.code, name: r.name, price: r.price,
        prevClose: r.prev_close, changePercent: r.change_percent, time: r.quote_time,
      });
    }
    return map;
  },
};

// 旧库迁移：chat_messages 补 tools 列；仅忽略「列已存在」，其余错误（如库锁）照常抛出
try {
  db.exec("ALTER TABLE chat_messages ADD COLUMN tools TEXT DEFAULT NULL");
} catch (e: any) {
  if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
}

export const chatRepo = {
  add(sessionId: string, role: "user" | "assistant", content: string, tools?: string[]) {
    db.prepare("INSERT INTO chat_messages (session_id, role, content, tools) VALUES (?, ?, ?, ?)")
      .run(sessionId, role, content, tools && tools.length > 0 ? JSON.stringify(tools) : null);
  },
  history(sessionId: string, limit = 20): Array<{ role: string; content: string; tools?: string[] }> {
    const rows = db.prepare(
      "SELECT role, content, tools FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
    ).all(sessionId, limit) as Array<{ role: string; content: string; tools: string | null }>;
    return rows.reverse().map((r) => {
      let tools: string[] | undefined;
      if (r.tools) {
        try {
          const parsed = JSON.parse(r.tools);
          if (Array.isArray(parsed)) tools = parsed;
        } catch {
          /* 历史数据损坏时忽略 tools */
        }
      }
      return { role: r.role, content: r.content, tools };
    });
  },
};

/** 按（代码, 日期）合并写 JSON 快照的通用仓库工厂，各功能一张表 */
function makeSnapshotRepo(
  table: string,
  mergePayload?: (prev: any, next: any) => any
) {
  return {
    upsertMany(items: Array<{ code: string; date: string; payload: unknown }>) {
      const getStmt = db.prepare(`SELECT payload FROM ${table} WHERE code = ? AND date = ?`);
      const stmt = db.prepare(`
        INSERT INTO ${table} (code, date, payload) VALUES (@code, @date, @payload)
        ON CONFLICT(code, date) DO UPDATE SET
          payload = excluded.payload,
          created_at = excluded.created_at
      `);
      const tx = db.transaction((rows: typeof items) => {
        for (const r of rows) {
          let payload = r.payload;
          // 合并写：限流等导致的残缺抓取（null/空数组）保留旧快照对应字段，数据只增不减
          const existing = getStmt.get(r.code, r.date) as { payload: string } | undefined;
          if (existing) {
            try {
              const prev = JSON.parse(existing.payload);
              if (prev && typeof prev === "object" && payload && typeof payload === "object") {
                const merged: Record<string, unknown> = { ...prev, ...(payload as Record<string, unknown>) };
                for (const k of Object.keys(merged)) {
                  const v = (payload as Record<string, unknown>)[k];
                  const old = (prev as Record<string, unknown>)[k];
                  const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
                  const oldFilled = old !== null && old !== undefined && !(Array.isArray(old) && old.length === 0);
                  if (empty && oldFilled) merged[k] = old;
                }
                payload = mergePayload ? mergePayload(prev, merged) : merged;
              }
            } catch {
              /* 旧 payload 损坏时直接覆盖 */
            }
          }
          stmt.run({ code: r.code, date: r.date, payload: JSON.stringify(payload) });
        }
      });
      tx(items);
    },
    /** 取某日期全部代码的快照，返回 code → payload 映射 */
    getByDate(date: string): Map<string, any> {
      const rows = db.prepare(`SELECT code, payload FROM ${table} WHERE date = ?`).all(date) as Array<{
        code: string;
        payload: string;
      }>;
      const map = new Map<string, any>();
      for (const r of rows) {
        try {
          map.set(r.code, JSON.parse(r.payload));
        } catch {
          /* 跳过损坏行 */
        }
      }
      return map;
    },
    /** 已有快照的日期列表（降序） */
    listDates(): string[] {
      const rows = db.prepare(`SELECT DISTINCT date FROM ${table} ORDER BY date DESC`).all() as Array<{
        date: string;
      }>;
      return rows.map((r) => r.date);
    },
  };
}

// technical 按指标日期存，其余功能按抓取当日存
export type SnapshotRepo = ReturnType<typeof makeSnapshotRepo>;

export const techSnapshotRepo = makeSnapshotRepo("tech_snapshots");
export const newsSnapshotRepo = makeSnapshotRepo("news_snapshots");
export const consensusSnapshotRepo = makeSnapshotRepo("consensus_snapshots");
export const reportsSnapshotRepo = makeSnapshotRepo("reports_snapshots");
export const fundFlowSnapshotRepo = makeSnapshotRepo("fund_flow_snapshots");
export const blockMarginSnapshotRepo = makeSnapshotRepo("block_margin_snapshots");
export const windNewsSnapshotRepo = makeSnapshotRepo("wind_news_snapshots");
export const windConsensusSnapshotRepo = makeSnapshotRepo("wind_consensus_snapshots");
// tables 按分类合并：每次抓取补充/更新对应分类，缺失分类保留旧值（NL 工具返回有波动，避免互相覆盖）
export const windRiskSnapshotRepo = makeSnapshotRepo("wind_risk_snapshots", (prev, next) => {
  const prevTables = Array.isArray(prev.tables) ? prev.tables : [];
  const nextTables = Array.isArray(next.tables) ? next.tables : [];
  const merged = [...prevTables];
  for (const t of nextTables) {
    const idx = merged.findIndex((m) => m.category === t.category);
    if (idx >= 0) merged[idx] = t;
    else merged.push(t);
  }
  // 基于 next（通用合并结果）展开而非 prev，否则新增键（如 payload.error）会被丢弃
  return { ...next, tables: merged };
});
// 事件表同样按分类合并累积
export const windEventsSnapshotRepo = makeSnapshotRepo("wind_events_snapshots", (prev, next) => {
  const prevTables = Array.isArray(prev.tables) ? prev.tables : [];
  const nextTables = Array.isArray(next.tables) ? next.tables : [];
  const merged = [...prevTables];
  for (const t of nextTables) {
    const idx = merged.findIndex((m) => m.category === t.category);
    if (idx >= 0) merged[idx] = t;
    else merged.push(t);
  }
  // 基于 next（通用合并结果）展开而非 prev，否则新增键（如 payload.error）会被丢弃
  return { ...next, tables: merged };
});
export const windMoneyFlowSnapshotRepo = makeSnapshotRepo("wind_moneyflow_snapshots");
export const windValuationSnapshotRepo = makeSnapshotRepo("wind_valuation_snapshots");
export const windUpdatesSnapshotRepo = makeSnapshotRepo("wind_updates_snapshots");
export const windTechnicalSnapshotRepo = makeSnapshotRepo("wind_technical_snapshots", (prev, next) => {
  // 乖离率/心理线补充块来自另一次 NL 调用，残缺抓取（本次缺该块）保留当日旧值，数据只增不减
  const oldBlock = prev?.data?.["技术面数据"]?.["乖离率与心理线"];
  const zj = next?.data?.["技术面数据"];
  if (oldBlock && zj && typeof zj === "object" && !zj["乖离率与心理线"]) {
    zj["乖离率与心理线"] = oldBlock;
  }
  return next;
});
export const windProfileSnapshotRepo = makeSnapshotRepo("wind_profile_snapshots");
