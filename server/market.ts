import { execFile, execFileSync } from "child_process";
import { quoteCacheRepo } from "./db.js";

export interface Quote {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  changePercent: number;
  time: string;
}

export interface MarketResult {
  quotes: Map<string, Quote>;
  /** true 表示行情来自缓存（westock 未授权或查询失败） */
  stale: boolean;
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
  /** true 表示部分或全部行情由 kline（日 K 最新一根的 last）兜底取得 */
  klineFallback?: boolean;
}

const AUTH_RE = /AUTH_REQUIRED:(\S+)/;
const round = (n: number, digits = 4) => {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
};

function runWestock(args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("westock", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // westock 即使部分失败也可能有 stdout，优先返回 stdout
        if (stdout) return resolve(stdout);
        return reject(new Error(stderr?.trim() || err.message));
      }
      resolve(stdout);
    });
  });
}

/** 解析 westock 的 markdown 表格输出 */
function parseMarkdownTable(output: string): Record<string, string>[] {
  const lines = output.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return [];
  const splitRow = (line: string) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const headers = splitRow(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    // 跳过分隔行 | --- | --- |
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => (row[h] = cells[idx] ?? ""));
    rows.push(row);
  }
  return rows;
}

function toQuote(row: Record<string, string>): Quote | null {
  const code = row.code;
  const price = parseFloat(row.price);
  if (!code || Number.isNaN(price)) return null;
  return {
    code,
    name: row.name || code,
    price,
    prevClose: parseFloat(row.prev_close) || price,
    changePercent: parseFloat(row.change_percent) || 0,
    time: row.time || "",
  };
}

/** 检测 westock 命令是否可用（是否已安装） */
export function isWestockInstalled(): boolean {
  try {
    execFileSync("westock", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 查询 westock 授权状态 */
export async function checkAuth(): Promise<{ authed: boolean; version: string }> {  try {
    const out = await runWestock(["version", "--json"], 10000);
    const j = JSON.parse(out.trim());
    return { authed: Boolean(j.auth), version: String(j.version ?? "") };
  } catch {
    return { authed: false, version: "" };
  }
}

/** 把 kline 的一行记录转成 Quote：以 last 作为最新价，change_pct 反推昨收 */
function toQuoteFromKline(code: string, row: Record<string, string>): Quote | null {
  const price = parseFloat(row.last ?? row.close ?? "");
  if (!Number.isFinite(price)) return null;
  const pct = parseFloat(row.change_pct ?? row.change_percent ?? "");
  const changePercent = Number.isFinite(pct) ? pct : 0;
  const prevClose = Number.isFinite(pct) && pct > -100 ? price / (1 + pct / 100) : price;
  return {
    code: row.code || code,
    name: row.name || code,
    price,
    prevClose: round(prevClose),
    changePercent: round(changePercent),
    time: row.date || row.time || "",
  };
}

/** 查询单只标的的 K 线，取最新一根的 last 作为最新价 */
async function fetchKlineOne(code: string, period = "day", limit = 1): Promise<Quote | null> {
  try {
    const out = await runWestock(["kline", code, "--period", period, "--limit", String(limit)], 15000);
    if (AUTH_RE.test(out)) return null;
    const rows = parseMarkdownTable(out);
    if (rows.length === 0) return null;
    // kline 按时间升序返回，取最后一根即最新一条
    return toQuoteFromKline(code, rows[rows.length - 1]);
  } catch {
    return null;
  }
}

/**
 * 通过 westock 的 kline 子命令查询行情（westock kline sh600519 --period day --limit 1），
 * 取返回的最新一条记录中的 last 作为最新价，change_pct 反推昨收。
 * 用于 `quote` 子命令拿不到价格时的兜底。
 *
 * westock 支持逗号分隔的多代码批量查询（此时返回带 code 列）；
 * 批量结果不完整时，再对缺失代码逐个查询补全。
 */
export async function fetchKline(
  codes: string[],
  opts: { period?: string; limit?: number } = {}
): Promise<Map<string, Quote>> {
  const result = new Map<string, Quote>();
  const unique = [...new Set(codes)].filter(Boolean);
  if (unique.length === 0) return result;
  const period = opts.period ?? "day";
  const limit = opts.limit ?? 1;

  // 1) 一次批量查询
  try {
    const out = await runWestock(
      ["kline", unique.join(","), "--period", period, "--limit", String(limit)],
      20000
    );
    if (!AUTH_RE.test(out)) {
      for (const row of parseMarkdownTable(out)) {
        const code = (row.code || "").trim() || (unique.length === 1 ? unique[0] : "");
        if (!code) continue;
        const q = toQuoteFromKline(code, row);
        // 同一 code 后出现的行更新，即保留最新一根
        if (q) result.set(code, q);
      }
    }
  } catch {
    /* 批量失败则走逐个兜底 */
  }

  // 2) 对仍未取到的代码并发逐个查询
  const missing = unique.filter((c) => !result.has(c));
  const CONCURRENCY = 4;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map((c) => fetchKlineOne(c, period, limit)));
    batch.forEach((c, idx) => {
      const q = got[idx];
      if (q) result.set(c, q);
    });
  }
  return result;
}

/** 对 quote 未取到的代码用 kline 兜底补齐，并把补到的行情写入缓存；返回补到的数量 */
async function fillMissingByKline(codes: string[], quotes: Map<string, Quote>): Promise<number> {
  const missing = codes.filter((c) => !quotes.has(c));
  if (missing.length === 0) return 0;
  const kline = await fetchKline(missing);
  if (kline.size === 0) return 0;
  // kline 返回不含名称，保留缓存中已有的名称，避免覆盖成 code
  const cached = quoteCacheRepo.get([...kline.keys()]);
  for (const [code, q] of kline) {
    const old = cached.get(code);
    if (old?.name && old.name !== code) q.name = old.name;
    quotes.set(code, q);
  }
  quoteCacheRepo.upsertMany([...kline.values()]);
  console.warn(
    `[market] quote 未取到行情，已用 kline 兜底补齐 ${kline.size}/${missing.length} 只：${[...kline.keys()].join(", ")}`
  );
  return kline.size;
}

/** 批量查询行情；未授权/失败时回退到 SQLite 缓存价，仍缺失则用 kline 兜底 */
export async function fetchQuotes(codes: string[]): Promise<MarketResult> {
  const unique = [...new Set(codes)].filter(Boolean);
  if (unique.length === 0) {
    return { quotes: new Map(), stale: false, authRequired: false, authUrl: null, error: null };
  }
  try {
    const out = await runWestock(["quote", unique.join(",")]);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) {
      const quotes = quoteCacheRepo.get(unique);
      const cacheCount = quotes.size;
      const filled = await fillMissingByKline(unique, quotes);
      return {
        quotes,
        stale: cacheCount > 0,
        authRequired: true,
        authUrl: authMatch[1],
        error: quotes.size > 0 ? null : "行情未授权且无缓存",
        klineFallback: filled > 0,
      };
    }
    const rows = parseMarkdownTable(out);
    const quotes = new Map<string, Quote>();
    for (const r of rows) {
      const q = toQuote(r);
      if (q) quotes.set(q.code, q);
    }
    if (quotes.size === 0) {
      // quote 返回为空：先回退缓存，仍缺失再用 kline 兜底
      const cached = quoteCacheRepo.get(unique);
      const cacheCount = cached.size;
      const filled = await fillMissingByKline(unique, cached);
      return {
        quotes: cached,
        stale: cacheCount > 0,
        authRequired: false,
        authUrl: null,
        error: cached.size > 0 ? null : "行情查询返回为空",
        klineFallback: filled > 0,
      };
    }
    quoteCacheRepo.upsertMany([...quotes.values()]);
    // 部分代码未取到时用 kline 补齐
    const filled = await fillMissingByKline(unique, quotes);
    return {
      quotes,
      stale: false,
      authRequired: false,
      authUrl: null,
      error: null,
      klineFallback: filled > 0,
    };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const authMatch = msg.match(AUTH_RE);
    const quotes = quoteCacheRepo.get(unique);
    const cacheCount = quotes.size;
    const filled = await fillMissingByKline(unique, quotes);
    return {
      quotes,
      stale: cacheCount > 0,
      authRequired: Boolean(authMatch),
      authUrl: authMatch?.[1] ?? null,
      error: quotes.size > 0 ? null : msg,
      klineFallback: filled > 0,
    };
  }
}

function marketOf(code: string): string {
  if (code.startsWith("sh")) return "沪市";
  if (code.startsWith("sz")) return "深市";
  if (code.startsWith("bj")) return "北交所";
  if (code.startsWith("hk")) return "港股";
  if (code.startsWith("us")) return "美股";
  return "其他";
}

/** 按名称搜索证券代码（用于新增持仓时自动填入代码） */
export async function searchCode(keyword: string): Promise<Array<{ code: string; name: string; market: string }>> {
  // 同时搜股票和 ETF，一次调用按类型分组
  const out = await runWestock(["search", keyword, "--type", "stock,etf"], 15000);
  const rows = parseMarkdownTable(out);
  return rows
    .map((r) => ({
      code: r.code || r.symbol || "",
      name: r.name || "",
      market: marketOf(r.code || r.symbol || ""),
    }))
    .filter((r) => r.code && r.name)
    .slice(0, 10);
}
