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
}

const AUTH_RE = /AUTH_REQUIRED:(\S+)/;

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

/** 批量查询行情；未授权/失败时回退到 SQLite 缓存价 */
export async function fetchQuotes(codes: string[]): Promise<MarketResult> {
  const unique = [...new Set(codes)].filter(Boolean);
  if (unique.length === 0) {
    return { quotes: new Map(), stale: false, authRequired: false, authUrl: null, error: null };
  }
  try {
    const out = await runWestock(["quote", unique.join(",")]);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) {
      const cached = quoteCacheRepo.get(unique);
      return {
        quotes: cached, stale: true,
        authRequired: true, authUrl: authMatch[1],
        error: null,
      };
    }
    const rows = parseMarkdownTable(out);
    const quotes = new Map<string, Quote>();
    for (const r of rows) {
      const q = toQuote(r);
      if (q) quotes.set(q.code, q);
    }
    if (quotes.size === 0) {
      const cached = quoteCacheRepo.get(unique);
      return {
        quotes: cached, stale: cached.size > 0,
        authRequired: false, authUrl: null,
        error: "行情查询返回为空",
      };
    }
    quoteCacheRepo.upsertMany([...quotes.values()]);
    return { quotes, stale: false, authRequired: false, authUrl: null, error: null };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const authMatch = msg.match(AUTH_RE);
    const cached = quoteCacheRepo.get(unique);
    return {
      quotes: cached, stale: cached.size > 0,
      authRequired: Boolean(authMatch), authUrl: authMatch?.[1] ?? null,
      error: msg,
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
