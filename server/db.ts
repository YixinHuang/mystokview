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
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
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

export const chatRepo = {
  add(sessionId: string, role: "user" | "assistant", content: string) {
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, role, content);
  },
  history(sessionId: string, limit = 20): Array<{ role: string; content: string }> {
    const rows = db.prepare(
      "SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
    ).all(sessionId, limit) as Array<{ role: string; content: string }>;
    return rows.reverse();
  },
};
