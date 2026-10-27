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

/** fetchKline 的返回：行情 + 授权状态 */
export interface KlineResult {
  quotes: Map<string, Quote>;
  authRequired: boolean;
  authUrl: string | null;
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

/** 检测 westock 命令是否可用（是否已安装） */
export function isWestockInstalled(): boolean {
  try {
    execFileSync("westock", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 查询 westock 授权状态（兼容不同版本：有的支持 version --json，有的只返回纯文本版本号） */
export async function checkAuth(): Promise<{ authed: boolean; version: string }> {
  // 先尝试取版本号（部分旧版本不支持 --json）
  let version = "";
  try {
    const v = await runWestock(["version"], 10000);
    version = v.match(/westock\s+([\d.]+)/)?.[1] ?? v.trim();
  } catch {
    /* ignore */
  }
  try {
    const out = await runWestock(["version", "--json"], 10000);
    const j = JSON.parse(out.trim());
    if (j && typeof j.auth !== "undefined") {
      return { authed: Boolean(j.auth), version: String(j.version ?? version) };
    }
  } catch {
    /* 不支持 --json，继续用探针判断 */
  }
  // 兼容兜底：用一次最小行情查询探针判断授权
  try {
    const probe = await runWestock(["kline", "sh600519", "--period", "day", "--limit", "1"], 15000);
    if (AUTH_RE.test(probe)) return { authed: false, version };
    if (probe.includes("|")) return { authed: true, version };
  } catch {
    /* ignore */
  }
  return { authed: false, version };
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
 *
 * westock 支持逗号分隔的多代码批量查询（此时返回带 code 列）；
 * 批量结果不完整时，再对缺失代码逐个查询补全。
 */
export async function fetchKline(
  codes: string[],
  opts: { period?: string; limit?: number } = {}
): Promise<KlineResult> {
  const result = new Map<string, Quote>();
  const unique = [...new Set(codes)].filter(Boolean);
  if (unique.length === 0) return { quotes: result, authRequired: false, authUrl: null };
  const period = opts.period ?? "day";
  const limit = opts.limit ?? 1;

  // 1) 一次批量查询
  try {
    const out = await runWestock(
      ["kline", unique.join(","), "--period", period, "--limit", String(limit)],
      20000
    );
    const authMatch = out.match(AUTH_RE);
    if (authMatch) return { quotes: result, authRequired: true, authUrl: authMatch[1] };
    for (const row of parseMarkdownTable(out)) {
      const code = (row.code || "").trim() || (unique.length === 1 ? unique[0] : "");
      if (!code) continue;
      const q = toQuoteFromKline(code, row);
      // 同一 code 后出现的行更新，即保留最新一根
      if (q) result.set(code, q);
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
  return { quotes: result, authRequired: false, authUrl: null };
}

/** 批量查询行情；主查询走 kline，未授权/失败时回退本地缓存价 */
export async function fetchQuotes(codes: string[]): Promise<MarketResult> {
  const unique = [...new Set(codes)].filter(Boolean);
  if (unique.length === 0) {
    return { quotes: new Map(), stale: false, authRequired: false, authUrl: null, error: null };
  }
  const { quotes, authRequired, authUrl } = await fetchKline(unique);
  if (authRequired) {
    const cached = quoteCacheRepo.get(unique);
    return {
      quotes: cached,
      stale: cached.size > 0,
      authRequired: true,
      authUrl,
      error: null,
    };
  }
  if (quotes.size === 0) {
    // kline 无结果：回退本地缓存
    const cached = quoteCacheRepo.get(unique);
    return {
      quotes: cached,
      stale: cached.size > 0,
      authRequired: false,
      authUrl: null,
      error: cached.size > 0 ? null : "行情查询返回为空",
    };
  }
  quoteCacheRepo.upsertMany([...quotes.values()]);
  return { quotes, stale: false, authRequired: false, authUrl: null, error: null };
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
