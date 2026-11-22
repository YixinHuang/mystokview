import { execFile, execFileSync } from "child_process";
import { quoteCacheRepo } from "./db.js";
import { RateLimiter } from "./rateLimit.js";

// westock CLI 全局限流（跨所有子命令共享）：≤ 50 次/分钟（≈0.83 QPS），
// 避免触发 westock 客户端本地限频（LOCAL_RATE_LIMITED / 请求过于频繁 / 服务限频）
const westockLimiter = new RateLimiter(50, 60_000);

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

async function runWestock(args: string[], timeoutMs = 30000): Promise<string> {
  await westockLimiter.acquire();
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

/** westock news list 的单条新闻 */
export interface NewsItem {
  id: string;
  src: string; // 来源
  title: string;
  summary: string;
  time: string;
  url: string;
}

/** westock news detail 的正文：标题/时间/来源 + 白名单清理后的 HTML 段落 */
export interface NewsDetail {
  title: string;
  time: string;
  src: string;
  content: string;
}

export interface NewsResult {
  /** 每只代码对应一条最新新闻；无新闻或查询失败为 null */
  news: Map<string, NewsItem | null>;
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

/**
 * 解析按 `**代码**` 分节的输出（news list / report list 批量模式）：
 * 每节一张 markdown 表格；单代码时无分节，整段输出就是该代码的表格（由调用方区分）。
 */
function parseMarkedSections(output: string): Map<string, Record<string, string>[]> {
  const result = new Map<string, Record<string, string>[]>();
  const marks: Array<{ code: string; start: number }> = [];
  const re = /\*\*(\S+)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) marks.push({ code: m[1], start: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : output.length;
    result.set(marks[i].code, parseMarkdownTable(output.slice(marks[i].start, end)));
  }
  return result;
}

function toNewsItem(row: Record<string, string>): NewsItem | null {
  const title = (row.title ?? "").trim();
  if (!title) return null;
  return {
    id: (row.id ?? "").trim(),
    src: (row.src ?? "").trim(),
    title,
    summary: (row.summary ?? "").trim(),
    time: (row.time ?? "").trim(),
    url: (row.url ?? "").trim(),
  };
}

/** 查询单只标的的最新一条新闻（--type 2 仅新闻），失败或无结果返回 null */
async function fetchNewsOne(code: string, limit = 1): Promise<NewsItem | null> {
  try {
    const out = await runWestock(["news", "list", code, "--limit", String(limit), "--type", "2"], 15000);
    if (AUTH_RE.test(out)) return null;
    const rows = parseMarkdownTable(out);
    if (rows.length === 0) return null;
    return toNewsItem(rows[0]);
  } catch {
    return null;
  }
}

/** 详情正文清理：去掉 stock:// 内链、装饰 span 等标签，仅保留 p/strong/b/em/br 白名单，
 * 并剥离白名单标签的全部属性（防 onmouseover 等事件属性注入，正文经 dangerouslySetInnerHTML 渲染） */
export function sanitizeNewsHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<(?!\/?(p|strong|b|em|br)\b)[^>]+>/gi, "")
    .replace(/<\/?(p|strong|b|em|br)(?:\s[^>]*)?>/gi, (m, tag) => (m.startsWith("</") ? `</${tag}>` : `<${tag}>`));
}

/** 详情时间（ISO UTC）转本地 YYYY-MM-DD HH:mm:ss */
function fmtDetailTime(t: string): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 按 ID 查询新闻正文（westock news detail），未授权/失败返回 null */
export async function fetchNewsDetail(id: string): Promise<NewsDetail | null> {
  try {
    const out = await runWestock(["news", "detail", id], 20000);
    if (AUTH_RE.test(out)) return null;
    const lines = out.split("\n");
    let title = "";
    let time = "";
    let src = "";
    let rest: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!title) {
        const t = line.match(/^#\s+(.+)/);
        if (t) {
          title = t[1].trim();
          continue;
        }
      }
      const meta = line.match(/^日期:\s*(.*?)\s*\|\s*来源:\s*(.*)$/);
      if (meta) {
        time = fmtDetailTime(meta[1].trim());
        src = meta[2].trim();
        rest = lines.slice(i + 1);
        break;
      }
      rest.push(line);
    }
    const content = sanitizeNewsHtml(rest.join("\n").trim());
    if (!title && !content) return null;
    return { title: title || "新闻详情", time, src, content };
  } catch {
    return null;
  }
}

/** 批量查询每只持仓的最新一条新闻；先批量，缺失代码再逐个兜底 */
export async function fetchNews(codes: string[]): Promise<NewsResult> {
  const unique = [...new Set(codes)].filter(Boolean);
  const result = new Map<string, NewsItem | null>();
  if (unique.length === 0) {
    return { news: result, authRequired: false, authUrl: null, error: null };
  }

  // 1) 一次批量查询
  try {
    const out = await runWestock(
      ["news", "list", unique.join(","), "--limit", "1", "--type", "2"],
      20000
    );
    const authMatch = out.match(AUTH_RE);
    if (authMatch) return { news: result, authRequired: true, authUrl: authMatch[1], error: null };
    const sections = parseMarkedSections(out);
    if (sections.size > 0) {
      for (const [code, rows] of sections) {
        result.set(code, rows.length > 0 ? toNewsItem(rows[0]) : null);
      }
    } else if (unique.length === 1) {
      // 单代码输出无 **code** 分节
      const rows = parseMarkdownTable(out);
      result.set(unique[0], rows.length > 0 ? toNewsItem(rows[0]) : null);
    }
  } catch {
    /* 批量失败则走逐个兜底 */
  }

  // 2) 对仍未取到的代码并发逐个查询
  const missing = unique.filter((c) => !result.has(c));
  const CONCURRENCY = 4;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map((c) => fetchNewsOne(c)));
    batch.forEach((c, idx) => result.set(c, got[idx]));
  }
  return { news: result, authRequired: false, authUrl: null, error: null };
}

/** westock report list 的单条研报 */
export interface ReportItem {
  id: string;
  title: string;
  type_str: string; // 研报类型（中报点评等）
  tzpj: string;     // 投资评级（买入等）
  time: string;
}

export interface ReportsResult {
  /** 每只代码对应最多 limit 条最新研报 */
  reports: Map<string, ReportItem[]>;
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

function toReportItem(row: Record<string, string>): ReportItem | null {
  const title = (row.title ?? "").trim();
  const id = (row.id ?? "").trim();
  if (!title || !id) return null;
  return {
    id,
    title,
    type_str: (row.typeStr ?? "").trim(),
    tzpj: (row.tzpj ?? "").trim(),
    time: (row.time ?? "").trim(),
  };
}

function parseReportRows(text: string, limit: number): ReportItem[] {
  return parseMarkdownTable(text)
    .map(toReportItem)
    .filter((r): r is ReportItem => r !== null)
    .slice(0, limit);
}

/** 查询单只标的的最新研报列表，失败返回空数组 */
async function fetchReportsOne(code: string, limit: number): Promise<ReportItem[]> {
  try {
    const out = await runWestock(["report", "list", code, "--limit", String(limit)], 15000);
    if (AUTH_RE.test(out)) return [];
    return parseReportRows(out, limit);
  } catch {
    return [];
  }
}

/** 批量查询每只持仓的最新研报列表；先批量，缺失代码再逐个兜底 */
export async function fetchReports(codes: string[], limit = 3): Promise<ReportsResult> {
  const unique = [...new Set(codes)].filter(Boolean);
  const result = new Map<string, ReportItem[]>();
  if (unique.length === 0) {
    return { reports: result, authRequired: false, authUrl: null, error: null };
  }

  // 1) 一次批量查询（**代码** 分节；有分节即视为已覆盖，空列表也不兜底）
  let rateLimited = false;
  try {
    const out = await runWestock(["report", "list", unique.join(","), "--limit", String(limit)], 25000);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) return { reports: result, authRequired: true, authUrl: authMatch[1], error: null };
    if (out.includes("服务限频")) rateLimited = true;
    for (const [code, rows] of parseMarkedSections(out)) {
      result.set(
        code,
        rows
          .map(toReportItem)
          .filter((r): r is ReportItem => r !== null)
          .slice(0, limit)
      );
    }
  } catch {
    /* 批量失败则走逐个兜底 */
  }

  // 2) 对没有分节的代码并发逐个查询
  const missing = unique.filter((c) => !result.has(c));
  const CONCURRENCY = 4;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map((c) => fetchReportsOne(c, limit)));
    batch.forEach((c, idx) => result.set(c, got[idx]));
  }
  return {
    reports: result,
    authRequired: false,
    authUrl: null,
    error: rateLimited ? "westock 接口限频，部分研报可能缺失，请稍后刷新重试" : null,
  };
}

/** westock report detail 的研报正文（纯文本，保留换行缩进） */
export interface ReportDetail {
  title: string;
  date: string;
  publish_time: string;
  org: string;
  content: string;
}

/** 按 ID 查询研报正文（westock report detail），未授权/失败返回 null */
export async function fetchReportDetail(id: string): Promise<ReportDetail | null> {
  try {
    const out = await runWestock(["report", "detail", id], 20000);
    if (AUTH_RE.test(out)) return null;
    const lines = out.split("\n");
    let title = "";
    let date = "";
    let publishTime = "";
    let org = "";
    let rest: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!title) {
        const t = line.match(/^#\s+(.+)/);
        if (t) {
          title = t[1].trim();
          continue;
        }
      }
      const meta = line.match(/^日期:\s*(.*?)\s*\|\s*发布:\s*(.*?)\s*\|\s*机构:\s*(.*)$/);
      if (meta) {
        date = meta[1].trim();
        publishTime = meta[2].trim();
        org = meta[3].trim();
        rest = lines.slice(i + 1);
        break;
      }
      rest.push(line);
    }
    const content = rest.join("\n").trim();
    if (!title && !content) return null;
    return { title: title || "研报详情", date, publish_time: publishTime, org, content };
  } catch {
    return null;
  }
}

/** westock technical 最新一期的技术指标（缺失列如新上市股的 MA_250 为 null） */
export interface TechIndicators {
  date: string;
  close_price: number;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  ma250: number | null;
  dif: number | null;
  dea: number | null;
  macd: number | null;
  kdj_k: number | null;
  kdj_d: number | null;
  kdj_j: number | null;
  rsi6: number | null;
  rsi12: number | null;
  rsi24: number | null;
  boll_upper: number | null;
  boll_mid: number | null;
  boll_lower: number | null;
}

/** westock chip 筹码成本分析（仅 A 股，ETF 实测也支持） */
export interface ChipAnalysis {
  date: string;
  avg_cost: number;
  concentration70: number;
  concentration90: number;
  profit_rate: number;
}

/** 由技术指标 + 筹码数据推导的汇总评级 */
export interface TechSummary {
  rating: "bull" | "bear" | "neutral";
  signals: string[];
}

export interface TechnicalEntryData {
  tech: TechIndicators | null;
  chip: ChipAnalysis | null;
  summary: TechSummary | null;
}

export interface TechnicalResult {
  entries: Map<string, TechnicalEntryData>;
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

const num = (v: string | undefined): number =>
  Number.isFinite(parseFloat(v ?? "")) ? parseFloat(v ?? "") : NaN;

const numOrNull = (v: string | undefined): number | null => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : null;
};

function toTechIndicators(code: string, row: Record<string, string>): TechIndicators | null {
  // 缺失列（如新上市股的 MA_250）解析为 null——NaN 经 JSON.stringify 会变成 null，前端需判空
  const t = {
    date: (row.date ?? "").trim(),
    close_price: num(row.closePrice),
    ma5: numOrNull(row.MA_5),
    ma10: numOrNull(row.MA_10),
    ma20: numOrNull(row.MA_20),
    ma60: numOrNull(row.MA_60),
    ma120: numOrNull(row.MA_120),
    ma250: numOrNull(row.MA_250),
    dif: numOrNull(row.DIF),
    dea: numOrNull(row.DEA),
    macd: numOrNull(row.MACD),
    kdj_k: numOrNull(row.KDJ_K),
    kdj_d: numOrNull(row.KDJ_D),
    kdj_j: numOrNull(row.KDJ_J),
    rsi6: numOrNull(row.RSI_6),
    rsi12: numOrNull(row.RSI_12),
    rsi24: numOrNull(row.RSI_24),
    boll_upper: numOrNull(row.BOLL_UPPER),
    boll_mid: numOrNull(row.BOLL_MID),
    boll_lower: numOrNull(row.BOLL_LOWER),
  };
  if (!t.date || !Number.isFinite(t.close_price)) return null;
  return t;
}

function toChipAnalysis(row: Record<string, string>): ChipAnalysis | null {
  const c = {
    date: (row.date ?? "").trim(),
    avg_cost: num(row.chipAvgCost),
    concentration70: num(row.chipConcentration70),
    concentration90: num(row.chipConcentration90),
    profit_rate: num(row.chipProfitRate),
  };
  if (!c.date || !Number.isFinite(c.avg_cost)) return null;
  return c;
}

const fmt2 = (n: number | null) => (n === null || Number.isNaN(n) ? "--" : String(round(n, 2)));

/** 技术指标 + 筹码 → 汇总评级：≥2 分偏多、≤-2 分偏空，其余中性；并给出信号要点（缺失指标跳过对应信号） */
function deriveTechSummary(t: TechIndicators, c: ChipAnalysis | null): TechSummary {
  const signals: string[] = [];
  let score = 0;

  if (t.dif !== null && t.dea !== null) {
    if (t.dif > t.dea) {
      score += 1;
      signals.push(`MACD 多头（DIF ${fmt2(t.dif)} > DEA ${fmt2(t.dea)}）`);
    } else if (t.dif < t.dea) {
      score -= 1;
      signals.push(`MACD 空头（DIF ${fmt2(t.dif)} < DEA ${fmt2(t.dea)}）`);
    }
  }

  if (t.ma5 !== null && t.ma10 !== null && t.ma20 !== null) {
    if (t.close_price > t.ma5 && t.ma5 > t.ma10 && t.ma10 > t.ma20) {
      score += 1;
      signals.push("均线多头排列（价 > MA5 > MA10 > MA20）");
    } else if (t.close_price < t.ma5 && t.ma5 < t.ma10 && t.ma10 < t.ma20) {
      score -= 1;
      signals.push("均线空头排列（价 < MA5 < MA10 < MA20）");
    }
  }

  if (t.kdj_j !== null && t.kdj_k !== null && t.kdj_d !== null) {
    if (t.kdj_j >= 100) {
      score -= 1;
      signals.push(`KDJ 超买（J 值 ${fmt2(t.kdj_j)} ≥ 100），短期注意回调`);
    } else if (t.kdj_j <= 0) {
      score += 1;
      signals.push(`KDJ 超卖（J 值 ${fmt2(t.kdj_j)} ≤ 0），存在反弹机会`);
    } else if (t.kdj_k > t.kdj_d) {
      score += 1;
      signals.push(`KDJ 偏多（K ${fmt2(t.kdj_k)} > D ${fmt2(t.kdj_d)}）`);
    } else if (t.kdj_k < t.kdj_d) {
      score -= 1;
      signals.push(`KDJ 偏空（K ${fmt2(t.kdj_k)} < D ${fmt2(t.kdj_d)}）`);
    }
  }

  if (t.rsi6 !== null) {
    if (t.rsi6 >= 80) {
      score -= 1;
      signals.push(`RSI6 ${fmt2(t.rsi6)} 进入超买区`);
    } else if (t.rsi6 <= 20) {
      score += 1;
      signals.push(`RSI6 ${fmt2(t.rsi6)} 进入超卖区`);
    }
  }

  if (t.boll_upper !== null && t.boll_lower !== null && t.boll_mid !== null) {
    if (t.close_price >= t.boll_upper) {
      signals.push("收盘价触及布林上轨，短线过热");
    } else if (t.close_price <= t.boll_lower) {
      signals.push("收盘价触及布林下轨，短线超跌");
    } else if (t.close_price > t.boll_mid) {
      signals.push("收盘价运行于布林中轨上方");
    } else {
      signals.push("收盘价运行于布林中轨下方");
    }
  }

  if (c && Number.isFinite(c.profit_rate)) {
    if (c.profit_rate >= 70) {
      signals.push(`获利盘 ${fmt2(c.profit_rate)}% 偏高，注意回吐压力`);
    } else if (c.profit_rate <= 10) {
      signals.push(`获利盘仅 ${fmt2(c.profit_rate)}%，套牢盘为主、抛压相对有限`);
    }
    signals.push(
      `现价处于筹码平均成本${t.close_price >= c.avg_cost ? "上" : "下"}方（平均成本 ${fmt2(c.avg_cost)}，90% 集中度 ${fmt2(c.concentration90)}）`
    );
  }

  const rating = score >= 2 ? "bull" : score <= -2 ? "bear" : "neutral";
  return { rating, signals };
}

/**
 * 批量查询技术指标与筹码成本：
 * - technical 多代码时带 symbol 列、单代码无 code 列，每码取最新日期一行；
 * - chip 始终带 code 列，仅 A 股（ETF 实测可用），非 A 股代码可能无数据（chip 为 null）。
 */
export async function fetchTechnical(codes: string[]): Promise<TechnicalResult> {
  const unique = [...new Set(codes)].filter(Boolean);
  const entries = new Map<string, TechnicalEntryData>();
  if (unique.length === 0) {
    return { entries, authRequired: false, authUrl: null, error: null };
  }

  // 1) 批量查 technical
  const techRows = new Map<string, TechIndicators>();
  try {
    const out = await runWestock(["technical", unique.join(","), "--period", "day"], 25000);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) return { entries, authRequired: true, authUrl: authMatch[1], error: null };
    for (const row of parseMarkdownTable(out)) {
      const code = (row.symbol || row.code || "").trim() || (unique.length === 1 ? unique[0] : "");
      if (!code) continue;
      const t = toTechIndicators(code, row);
      // 同一 code 取日期最新的一行（YYYY-MM-DD 字典序即时间序）
      if (t && (!techRows.has(code) || t.date > techRows.get(code)!.date)) techRows.set(code, t);
    }
  } catch {
    /* 批量失败则走逐个兜底 */
  }

  // 2) technical 逐个兜底
  const techMissing = unique.filter((c) => !techRows.has(c));
  const CONCURRENCY = 4;
  for (let i = 0; i < techMissing.length; i += CONCURRENCY) {
    const batch = techMissing.slice(i, i + CONCURRENCY);
    const got = await Promise.all(
      batch.map(async (c) => {
        try {
          const out = await runWestock(["technical", c, "--period", "day"], 15000);
          if (AUTH_RE.test(out)) return null;
          const rows = parseMarkdownTable(out);
          const last = rows[rows.length - 1];
          return last ? toTechIndicators(c, last) : null;
        } catch {
          return null;
        }
      })
    );
    batch.forEach((c, idx) => {
      if (got[idx]) techRows.set(c, got[idx]!);
    });
  }

  // 3) 批量查 chip（仅 A 股，失败不影响技术指标部分）
  const chipRows = new Map<string, ChipAnalysis>();
  try {
    const out = await runWestock(["chip", unique.join(",")], 25000);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) return { entries, authRequired: true, authUrl: authMatch[1], error: null };
    for (const row of parseMarkdownTable(out)) {
      const code = (row.code || row.symbol || "").trim();
      if (!code) continue;
      const c = toChipAnalysis(row);
      if (c && (!chipRows.has(code) || c.date > chipRows.get(code)!.date)) chipRows.set(code, c);
    }
  } catch {
    /* chip 失败时保持空，前端相应隐藏筹码块 */
  }

  // 4) 组装：technical 缺失的代码 tech 为 null（前端显示无数据）
  for (const code of unique) {
    const tech = techRows.get(code) ?? null;
    const chip = chipRows.get(code) ?? null;
    entries.set(code, {
      tech,
      chip,
      summary: tech ? deriveTechSummary(tech, chip) : null,
    });
  }
  return { entries, authRequired: false, authUrl: null, error: null };
}

/** westock consensus 的一致预期（取最近年度预测，仅 A股/港股有数据） */
export interface ConsensusData {
  year: string;
  eps: number;
  pe: number | null;
  revenue_yoy: number | null;
  profit_yoy: number | null;
  target_price: number;
}

/** westock rating 的机构评级（仅港股/美股有数据） */
export interface RatingData {
  current_price: number;
  institutions: number;
  buy_cnt: number;
  hold_cnt: number;
  sell_cnt: number;
  total_cnt: number;
  target_avg: number | null;
}

/** 单项评分：数值 + 原始周/月/季变动文本 */
export interface ScoreDim {
  value: number;
  detail: string;
}

/** westock score 的股票评分五维（仅 A股） */
export interface ScoreInfo {
  cap: ScoreDim; // 市值
  comp: ScoreDim; // 综合
  funm: ScoreDim; // 基本面
  risk: ScoreDim; // 风险
  tec: ScoreDim; // 技术面
}

export interface ConsensusEntryData {
  price: number | null;
  consensus: ConsensusData | null;
  rating: RatingData | null;
  score: ScoreInfo | null;
  summary: TechSummary | null;
}

export interface ConsensusResult {
  entries: Map<string, ConsensusEntryData>;
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

/** 按 `#### 代码 名称` 分节切分输出（无分节 = 无数据，返回空表） */
function parseCodeSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  const re = /^####\s+(\S+)[ \t]*(.*)$/gm;
  const marks: Array<{ code: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) marks.push({ code: m[1], start: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : output.length;
    sections.set(marks[i].code, output.slice(marks[i].start, end));
  }
  return sections;
}

function parseConsensusSection(text: string): ConsensusData | null {
  const targetPrice = parseFloat(text.match(/目标价:\s*([\d.]+)/)?.[1] ?? "");
  if (!Number.isFinite(targetPrice)) return null;
  // 年份顺序不保证（ 升序/降序均可能出现），取最小年份 = 最近年度的一致预期
  let best: ConsensusData | null = null;
  for (const row of parseMarkdownTable(text)) {
    if (!row.year) continue;
    const eps = num(row.eps);
    if (!Number.isFinite(eps)) continue;
  const c: ConsensusData = {
    year: row.year,
    eps,
    pe: numOrNull(row.pe),
    revenue_yoy: numOrNull(row.revenueYoy),
    profit_yoy: numOrNull(row.netProfitYoy),
    target_price: targetPrice,
  };
    if (!best || parseInt(c.year, 10) < parseInt(best.year, 10)) best = c;
  }
  return best;
}

function parseRatingSection(text: string): RatingData | null {
  // 仅接受带 currentPrice 的完整行（A 股代码返回的表缺该列，视为无评级）
  for (const r of parseMarkdownTable(text)) {
    const cur = num(r.currentPrice);
    const cnt = num(r.ratingCnt);
    if (!Number.isFinite(cur) || !Number.isFinite(cnt) || cnt <= 0) continue;
    const avg = num(r.targetPriceAvg);
    return {
      current_price: cur,
      institutions: num(r.forecastInstitutions) || 0,
      buy_cnt: num(r.ratingBuyCnt) || 0,
      hold_cnt: num(r.ratingHoldCnt) || 0,
      sell_cnt: num(r.ratingSellCnt) || 0,
      total_cnt: Math.round(cnt),
      target_avg: Number.isFinite(avg) ? avg : null,
    };
  }
  return null;
}

function parseScoreCell(v: string | undefined): ScoreDim | null {
  const m = (v ?? "").trim().match(/^([\d.]+)\s*\((.*)\)$/);
  if (!m) return null;
  return { value: parseFloat(m[1]), detail: m[2] };
}

function parseScoreRow(row: Record<string, string>): ScoreInfo | null {
  const cap = parseScoreCell(row.capScore);
  const comp = parseScoreCell(row.compScore);
  const funm = parseScoreCell(row.funmScore);
  const risk = parseScoreCell(row.riskScore);
  const tec = parseScoreCell(row.tecScore);
  if (!cap || !comp || !funm || !risk || !tec) return null;
  return { cap, comp, funm, risk, tec };
}

/** 现价 + 一致预期/评级/评分 → 汇总评级（任一数据都缺时返回 null） */
function deriveConsensusSummary(
  price: number | null,
  consensus: ConsensusData | null,
  rating: RatingData | null,
  score: ScoreInfo | null
): TechSummary | null {
  const signals: string[] = [];
  let pts = 0;

  if (consensus) {
    signals.push(
      `${consensus.year}E 一致目标价 ${fmt2(consensus.target_price)}（EPS ${fmt2(consensus.eps)} · PE ${fmt2(consensus.pe)} · 净利增速 ${fmt2(consensus.profit_yoy)}%）`
    );
    if (price && price > 0) {
      const upside = ((consensus.target_price - price) / price) * 100;
      signals.push(`目标价较现价空间 ${upside >= 0 ? "+" : ""}${fmt2(upside)}%`);
      if (upside >= 15) pts += 1;
      else if (upside <= -5) pts -= 1;
    }
  }

  if (score) {
    signals.push(
      `综合评分 ${fmt2(score.comp.value)}（${score.comp.detail}）· 基本面 ${fmt2(score.funm.value)} · 技术面 ${fmt2(score.tec.value)}`
    );
    if (score.comp.value >= 70) pts += 1;
    else if (score.comp.value < 40) pts -= 1;
  }

  if (rating) {
    const buyRatio = rating.total_cnt > 0 ? rating.buy_cnt / rating.total_cnt : 0;
    signals.push(
      `机构评级：买入 ${rating.buy_cnt} / ${rating.total_cnt} 家${rating.target_avg ? ` · 目标均价 ${fmt2(rating.target_avg)}（现价 ${fmt2(rating.current_price)}）` : ""}`
    );
    if (buyRatio >= 0.6) pts += 1;
    else if (buyRatio <= 0.3) pts -= 1;
  }

  if (signals.length === 0) return null;
  const r = pts >= 2 ? "bull" : pts <= -2 ? "bear" : "neutral";
  return { rating: r, signals };
}

/**
 * 批量查询研究数据：一致预期（A股/港股）、机构评级（港股/美股）、股票评分（A股），
 * 并取 kline 最新价计算目标价空间。
 * consensus / rating 输出按 `#### 代码` 分节，score 为带 code 列的表格；
 * 无数据的代码（如 ETF、非覆盖市场）相应字段为 null。
 */
export async function fetchConsensus(codes: string[]): Promise<ConsensusResult> {
  const unique = [...new Set(codes)].filter(Boolean);
  const entries = new Map<string, ConsensusEntryData>();
  if (unique.length === 0) {
    return { entries, authRequired: false, authUrl: null, error: null };
  }

  // 1) kline 最新价（用于目标价空间；授权状态一并透出）
  const kline = await fetchKline(unique);
  if (kline.authRequired) {
    return { entries, authRequired: true, authUrl: kline.authUrl, error: null };
  }

  // 2) 一致预期（按 #### 代码 分节）
  const consensusMap = new Map<string, ConsensusData>();
  let rateLimited = false;
  try {
    const out = await runWestock(["consensus", unique.join(",")], 25000);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) return { entries, authRequired: true, authUrl: authMatch[1], error: null };
    if (out.includes("服务限频")) rateLimited = true;
    for (const [code, text] of parseCodeSections(out)) {
      const c = parseConsensusSection(text);
      if (c) consensusMap.set(code, c);
    }
  } catch {
    /* consensus 失败不影响其余数据 */
  }

  // 3) 机构评级（按 #### 代码 分节，仅港股/美股）
  const ratingMap = new Map<string, RatingData>();
  try {
    const out = await runWestock(["rating", unique.join(",")], 25000);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) return { entries, authRequired: true, authUrl: authMatch[1], error: null };
    for (const [code, text] of parseCodeSections(out)) {
      const r = parseRatingSection(text);
      if (r) ratingMap.set(code, r);
    }
  } catch {
    /* rating 失败不影响其余数据 */
  }

  // 4) 股票评分（带 code 列表格，仅 A股）
  const scoreMap = new Map<string, ScoreInfo>();
  try {
    const out = await runWestock(["score", unique.join(",")], 25000);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) return { entries, authRequired: true, authUrl: authMatch[1], error: null };
    for (const row of parseMarkdownTable(out)) {
      const code = (row.code || "").trim();
      if (!code) continue;
      const s = parseScoreRow(row);
      if (s) scoreMap.set(code, s);
    }
  } catch {
    /* score 失败不影响其余数据 */
  }

  // 5) 组装 + 汇总
  for (const code of unique) {
    const consensus = consensusMap.get(code) ?? null;
    const rating = ratingMap.get(code) ?? null;
    const score = scoreMap.get(code) ?? null;
    const price = kline.quotes.get(code)?.price ?? null;
    entries.set(code, {
      price,
      consensus,
      rating,
      score,
      summary: deriveConsensusSummary(price, consensus, rating, score),
    });
  }
  return {
    entries,
    authRequired: false,
    authUrl: null,
    error: rateLimited ? "westock 接口限频，部分研究数据可能缺失，请稍后刷新重试" : null,
  };
}

/** westock fund flow 的个股资金流向（金额单位：元） */
export interface FundFlowData {
  date: string;
  main_net: number;  // 主力净流入
  jumbo_net: number; // 超大单净流入
  block_net: number; // 大单净流入
  mid_net: number;   // 中单净流入
  small_net: number; // 小单净流入
  main_in: number;   // 主力流入
  main_out: number;  // 主力流出
  main_net_5d: number;
  main_net_10d: number;
  main_net_20d: number;
}

/** westock fund north-holding 的北向资金季度持仓（陆股通，仅 A 股；ETF 无数据） */
export interface NorthHoldingData {
  date: string;         // 快照日期
  disclose_end: string; // 披露截止日（季度末）
  holding_cap: number;  // 持股市值（元）
  holding_ratio: number; // 占流通比 %
  hold_shares: number;  // 持股数（股）
  cap_chg_q: number | null; // 市值环比变动
  cap_chg_y: number | null; // 市值同比变动
}

/** westock fund short 的卖空数据（港股/美股） */
export interface ShortData {
  date: string;
  close_price: number | null;
  short_shares: number; // 卖空股数
  short_amount: number; // 卖空金额（元）
  short_ratio: number | null; // 卖空占比 %
}

/** westock fund south-holding 的南下资金持仓快照（港股通，仅港股） */
export interface SouthHoldingData {
  date: string;
  hold_ratio: number; // 持股比例 %
  hold_shares: number; // 持股数（股）
  cap_chg_daily: number | null;    // 日市值变动（元）
  cap_chg_quarterly: number | null; // 季度市值变动（元）
}

export interface FundFlowEntryData {
  flow: FundFlowData | null;
  margin: MarginData | null;
  north: NorthHoldingData | null;
  short: ShortData | null;
  south: SouthHoldingData | null;
  summary: TechSummary | null;
}

export interface FundFlowResult {
  entries: Map<string, FundFlowEntryData>;
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

function toFundFlow(row: Record<string, string>): FundFlowData | null {
  const f = {
    date: (row.EndDate ?? "").trim(),
    main_net: num(row.MainNetFlow),
    jumbo_net: num(row.JumboNetFlow),
    block_net: num(row.BlockNetFlow),
    mid_net: num(row.MidNetFlow),
    small_net: num(row.SmallNetFlow),
    main_in: num(row.MainInFlow),
    main_out: num(row.MainOutFlow),
    main_net_5d: num(row.MainNetFlow5D),
    main_net_10d: num(row.MainNetFlow10D),
    main_net_20d: num(row.MainNetFlow20D),
  };
  if (!f.date || !Number.isFinite(f.main_net)) return null;
  return f;
}

const yi = (v: number) => `${round(v / 1e8, 2)} 亿`;

/** 资金流向汇总：当日主力净流入为正偏多、为负偏空，并给出超大/大单拆分与区间趋势 */
function deriveFundFlowSummary(f: FundFlowData): TechSummary {
  const dir = (v: number) => (v >= 0 ? "流入" : "流出");
  const signals: string[] = [
    `当日主力净${dir(f.main_net)} ${yi(Math.abs(f.main_net))}（超大单 ${yi(f.jumbo_net)} / 大单 ${yi(f.block_net)}）`,
    `主力流入 ${yi(f.main_in)} · 主力流出 ${yi(f.main_out)}`,
    `5 日主力净${dir(f.main_net_5d)} ${yi(Math.abs(f.main_net_5d))} · 10 日净${dir(f.main_net_10d)} ${yi(Math.abs(f.main_net_10d))} · 20 日净${dir(f.main_net_20d)} ${yi(Math.abs(f.main_net_20d))}`,
  ];
  const rating = f.main_net > 0 ? "bull" : f.main_net < 0 ? "bear" : "neutral";
  return { rating, signals };
}

/**
 * 批量查询个股资金流向（fund flow，A股/港股，ETF 实测可用）。
 * 输出为带 code 列的单张表格（批量另有 symbol 列），每码取最新 EndDate 一行。
 */
export async function fetchFundFlow(codes: string[]): Promise<FundFlowResult> {
  // fund 系列子命令并发收敛（westock 客户端有本地限流，margin 逐码查询放得更缓）
  const FUND_CONCURRENCY = 4;
  const MARGIN_CONCURRENCY = 2;
  const unique = [...new Set(codes)].filter(Boolean);
  const rowsByCode = new Map<string, FundFlowData>();
  if (unique.length === 0) {
    return { entries: new Map(), authRequired: false, authUrl: null, error: null };
  }

  const collect = (out: string) => {
    for (const row of parseMarkdownTable(out)) {
      const code = (row.code || row.symbol || "").trim();
      if (!code) continue;
      const f = toFundFlow(row);
      if (f && (!rowsByCode.has(code) || f.date > rowsByCode.get(code)!.date)) rowsByCode.set(code, f);
    }
  };

  // 1) 一次批量查询
  let rateLimited = false;
  try {
    const out = await runWestock(["fund", "flow", unique.join(",")], 25000);
    const authMatch = out.match(AUTH_RE);
    if (authMatch) {
      return { entries: new Map(), authRequired: true, authUrl: authMatch[1], error: null };
    }
    if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
    collect(out);
  } catch {
    /* 批量失败则走逐个兜底 */
  }

  // 2) 缺失代码并发逐个查询
  const missing = unique.filter((c) => !rowsByCode.has(c));
  for (let i = 0; i < missing.length; i += FUND_CONCURRENCY) {
    const batch = missing.slice(i, i + FUND_CONCURRENCY);
    await Promise.all(
      batch.map(async (c) => {
        try {
          const out = await runWestock(["fund", "flow", c], 15000);
          if (!AUTH_RE.test(out)) collect(out);
        } catch {
          /* 单码失败跳过 */
        }
      })
    );
  }

  // 3) 逐代码并发查融资融券（仅 A 股个股；批量列不全，统一走单代码格式）
  let authUrl: string | null = null;
  const marginByCode = new Map<string, MarginData>();
  for (let i = 0; i < unique.length; i += MARGIN_CONCURRENCY) {
    const batch = unique.slice(i, i + MARGIN_CONCURRENCY);
    await Promise.all(
      batch.map(async (c) => {
        try {
          const out = await runWestock(["fund", "margin", c], 15000);
          const authMatch = out.match(AUTH_RE);
          if (authMatch) {
            authUrl ??= authMatch[1];
            return;
          }
          if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
          const m = parseMarginOutput(out);
          if (m) marginByCode.set(c, m);
        } catch {
          /* 单码失败跳过 */
        }
      })
    );
  }

  // 4) 按市场补充：A 股查北向持仓，港股查卖空 + 南下持仓（ETF 北向无数据则自然为空）
  const aShareCodes = unique.filter((c) => /^(sh|sz|bj)/.test(c));
  const hkCodes = unique.filter((c) => /^hk/.test(c));
  const northByCode = new Map<string, NorthHoldingData>();
  const shortByCode = new Map<string, ShortData>();
  const southByCode = new Map<string, SouthHoldingData>();

  if (aShareCodes.length > 0) {
    try {
      const out = await runWestock(["fund", "north-holding", aShareCodes.join(",")], 25000);
      const authMatch = out.match(AUTH_RE);
      if (authMatch) authUrl ??= authMatch[1];
      else {
        if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
        collectNorthHolding(out, "", northByCode);
      }
    } catch {
      /* 批量失败走逐码兜底 */
    }
    const northMissing = aShareCodes.filter((c) => !northByCode.has(c));
    for (let i = 0; i < northMissing.length; i += MARGIN_CONCURRENCY) {
      const batch = northMissing.slice(i, i + MARGIN_CONCURRENCY);
      await Promise.all(
        batch.map(async (c) => {
          try {
            const out = await runWestock(["fund", "north-holding", c], 15000);
            const authMatch = out.match(AUTH_RE);
            if (authMatch) {
              authUrl ??= authMatch[1];
              return;
            }
            if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
            collectNorthHolding(out, c, northByCode);
          } catch {
            /* 单码失败跳过 */
          }
        })
      );
    }
  }

  if (hkCodes.length > 0) {
    try {
      const out = await runWestock(["fund", "short", hkCodes.join(",")], 25000);
      const authMatch = out.match(AUTH_RE);
      if (authMatch) authUrl ??= authMatch[1];
      else {
        if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
        collectShort(out, shortByCode);
      }
    } catch {
      /* 批量失败走逐码兜底 */
    }
    const shortMissing = hkCodes.filter((c) => !shortByCode.has(c));
    for (let i = 0; i < shortMissing.length; i += MARGIN_CONCURRENCY) {
      const batch = shortMissing.slice(i, i + MARGIN_CONCURRENCY);
      await Promise.all(
        batch.map(async (c) => {
          try {
            const out = await runWestock(["fund", "short", c], 15000);
            const authMatch = out.match(AUTH_RE);
            if (authMatch) {
              authUrl ??= authMatch[1];
              return;
            }
            if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
            collectShort(out, shortByCode);
          } catch {
            /* 单码失败跳过 */
          }
        })
      );
    }

    try {
      const out = await runWestock(["fund", "south-holding", hkCodes.join(",")], 25000);
      const authMatch = out.match(AUTH_RE);
      if (authMatch) authUrl ??= authMatch[1];
      else {
        if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
        collectSouthHolding(out, "", southByCode);
      }
    } catch {
      /* 批量失败走逐码兜底 */
    }
    const southMissing = hkCodes.filter((c) => !southByCode.has(c));
    for (let i = 0; i < southMissing.length; i += MARGIN_CONCURRENCY) {
      const batch = southMissing.slice(i, i + MARGIN_CONCURRENCY);
      await Promise.all(
        batch.map(async (c) => {
          try {
            const out = await runWestock(["fund", "south-holding", c], 15000);
            const authMatch = out.match(AUTH_RE);
            if (authMatch) {
              authUrl ??= authMatch[1];
              return;
            }
            if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
            collectSouthHolding(out, c, southByCode);
          } catch {
            /* 单码失败跳过 */
          }
        })
      );
    }
  }

  const entries = new Map<string, FundFlowEntryData>();
  for (const code of unique) {
    const flow = rowsByCode.get(code) ?? null;
    entries.set(code, {
      flow,
      margin: marginByCode.get(code) ?? null,
      north: northByCode.get(code) ?? null,
      short: shortByCode.get(code) ?? null,
      south: southByCode.get(code) ?? null,
      summary: flow ? deriveFundFlowSummary(flow) : null,
    });
  }
  return {
    entries,
    authRequired: authUrl !== null,
    authUrl,
    error: rateLimited ? "westock 接口限频，部分数据可能缺失，请稍后刷新重试" : null,
  };
}

/** 北向持仓收集：批量输出带 code 列，单代码无 code 列（用 fallbackCode 兜底）；"-" 空值行跳过 */
function collectNorthHolding(out: string, fallbackCode: string, map: Map<string, NorthHoldingData>) {
  const date = out.match(/北向季度持仓（([\d-]+)）/)?.[1] ?? "";
  for (const row of parseMarkdownTable(out)) {
    const code = (row.code || "").trim() || fallbackCode;
    if (!code || row.quarter !== "最新季度") continue;
    const cap = num(row.holdingCap);
    if (!Number.isFinite(cap)) continue;
    map.set(code, {
      date,
      disclose_end: (row.discloseEnd ?? "").trim(),
      holding_cap: cap,
      holding_ratio: numOrNull(row.holdingRatio) ?? 0,
      hold_shares: num(row.holdShares),
      cap_chg_q: numOrNull(row.capChgQ),
      cap_chg_y: numOrNull(row.capChgY),
    });
  }
}

/** 卖空数据收集：单/批量输出均带 code 列 */
function collectShort(out: string, map: Map<string, ShortData>) {
  for (const row of parseMarkdownTable(out)) {
    const code = (row.code || row.symbol || "").trim();
    if (!code) continue;
    const shares = num(row.ShortShares);
    if (!Number.isFinite(shares)) continue;
    map.set(code, {
      date: (row.date ?? "").trim(),
      close_price: numOrNull(row.ClosePrice),
      short_shares: shares,
      short_amount: num(row.ShortAmount),
      short_ratio: numOrNull(row.ShortRatio),
    });
  }
}

/** 南下持仓收集：输出快照表带 code 列（忽略季度明细表） */
function collectSouthHolding(out: string, fallbackCode: string, map: Map<string, SouthHoldingData>) {
  const date = out.match(/南下持仓（([\d-]+)）/)?.[1] ?? "";
  for (const row of parseMarkdownTable(out)) {
    const code = (row.code || "").trim() || fallbackCode;
    if (!code) continue;
    const ratio = num(row.holdRatio);
    if (!Number.isFinite(ratio)) continue; // 无数据行
    if (!("capChgDaily" in row)) continue; // 季度明细表无日变动列，跳过
    map.set(code, {
      date,
      hold_ratio: ratio,
      hold_shares: num(row.holdShares),
      cap_chg_daily: numOrNull(row.capChgDaily),
      cap_chg_quarterly: numOrNull(row.capChgQuarterly),
    });
  }
}

/** westock fund block 的单笔大宗交易 */
export interface BlockTrade {
  date: string;
  price: number;    // 成交价
  value: number;    // 成交额（元）
  discount: number; // 折溢价率（%，0 为平价）
  type: string;     // 交易类型（协议交易等）
  buyer: string;    // 买方营业部
  seller: string;   // 卖方营业部
}

export interface BlockTradeData {
  date: string;
  close_price: number | null;
  change_pct: number | null;
  trades: BlockTrade[];
}

/** westock fund margin 的融资融券数据（金额单位：元） */
export interface MarginData {
  date: string;
  finance_value: number;       // 融资余额
  security_value: number;      // 融券余额
  finance_buy: number;         // 当日融资买入额
  finance_refund: number | null; // 当日融资偿还额
  trading_value: number | null;  // 两融余额
  finance_value_dod: number | null; // 融资余额日环比 %
  security_value_dod: number | null; // 融券余额日环比 %
}

export interface BlockMarginEntryData {
  block: BlockTradeData | null;
  margin: MarginData | null;
  summary: TechSummary | null;
}

export interface BlockMarginResult {
  entries: Map<string, BlockMarginEntryData>;
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

/**
 * 解析 fund block 输出，兼容两种格式：
 * - 单日：`📊 大宗交易（date）` + 汇总表（含 closePrice）+ 明细表；
 * - 区间：`📊 <code> 大宗交易区间汇总` + 带 date 列的扁平明细表。
 * 区间表头存在但 0 笔时返回空 trades（表示确无成交，而非无数据）。
 */
function parseBlockOutput(out: string, fallbackDate = ""): BlockTradeData | null {
  const rows = parseMarkdownTable(out);
  const headerDate = out.match(/大宗交易（([\d-]+)）/)?.[1] ?? "";
  const summary = rows.find((r) => r.code && r.closePrice !== undefined);
  const trades = rows
    .filter((r) => r.TurnoverValue !== undefined)
    .map((r) => ({
      date: (r.date ?? headerDate ?? "").trim(),
      price: num(r.TurnoverPrice),
      value: num(r.TurnoverValue),
      discount: num(r.CloseDiscountRate),
      type: (r.TradingType ?? "").trim(),
      buyer: (r.BuySalesDepartment ?? "").trim(),
      seller: (r.SellSalesDepartment ?? "").trim(),
    }))
    .filter((t) => Number.isFinite(t.value));
  const isRangeHeader = /大宗交易区间汇总/.test(out);
  if (trades.length === 0 && !summary && !isRangeHeader) return null;
  const close = summary ? num(summary.closePrice) : NaN;
  const pct = summary ? num(summary.changePct) : NaN;
  return {
    date: trades.map((t) => t.date).sort().at(-1) || headerDate || fallbackDate,
    close_price: Number.isFinite(close) ? close : null,
    change_pct: Number.isFinite(pct) ? pct : null,
    trades,
  };
}

function parseMarginOutput(out: string): MarginData | null {
  const row = parseMarkdownTable(out).find((r) => r.code);
  if (!row) return null;
  const fv = num(row.FinanceValue);
  if (!Number.isFinite(fv)) return null;
  const sec = num(row.SecurityValue);
  const refund = num(row.FinanceRefundValue);
  const tv = num(row.TradingValue);
  const fdod = num(row.FinanceValueDOD);
  const sdod = num(row.SecurityValueDOD);
  return {
    date: (row.date ?? "").trim(),
    finance_value: fv,
    security_value: Number.isFinite(sec) ? sec : 0,
    finance_buy: Number.isFinite(num(row.FinanceBuyValue)) ? num(row.FinanceBuyValue) : 0,
    finance_refund: Number.isFinite(refund) ? refund : null,
    trading_value: Number.isFinite(tv) ? tv : null,
    finance_value_dod: Number.isFinite(fdod) ? fdod : null,
    security_value_dod: Number.isFinite(sdod) ? sdod : null,
  };
}

/** 元 → 万/亿可读金额（信号文案用） */
const fmtCnAmount = (v: number) =>
  Math.abs(v) >= 1e8 ? `${round(v / 1e8, 2)} 亿` : `${round(v / 1e4, 2)} 万`;

/** 大宗交易 + 融资融券 → 汇总：以融资余额日环比为主，折价大宗成交作减分 */
function deriveBlockMarginSummary(block: BlockTradeData | null, margin: MarginData | null): TechSummary | null {
  const signals: string[] = [];
  let pts = 0;

  if (block) {
    const total = block.trades.reduce((s, t) => s + t.value, 0);
    signals.push(
      block.trades.length > 0
        ? `近 7 日成交 ${block.trades.length} 笔大宗交易，合计 ${fmtCnAmount(total)}`
        : `近 7 日无大宗交易`
    );
    if (block.trades.length > 0) {
      const avgDiscount =
        block.trades.reduce((s, t) => s + (Number.isFinite(t.discount) ? t.discount : 0), 0) /
        block.trades.length;
      signals.push(`成交折溢价率均值 ${round(avgDiscount, 2)}%${avgDiscount <= -3 ? "（大幅折价）" : avgDiscount > 0 ? "（溢价成交）" : "（平价成交）"}`);
      if (avgDiscount <= -3) pts -= 1;
      else if (avgDiscount > 0) pts += 1;
    }
  }

  if (margin) {
    signals.push(
      `融资余额 ${fmtCnAmount(margin.finance_value)}${margin.finance_value_dod !== null ? `（日环比 ${margin.finance_value_dod >= 0 ? "+" : ""}${round(margin.finance_value_dod, 2)}%）` : ""}`
    );
    signals.push(
      `融券余额 ${fmtCnAmount(margin.security_value)} · 当日融资买入 ${fmtCnAmount(margin.finance_buy)}${margin.finance_refund !== null ? ` / 偿还 ${fmtCnAmount(margin.finance_refund)}` : ""}`
    );
    if (margin.finance_value_dod !== null && margin.finance_value_dod !== 0) {
      pts += margin.finance_value_dod > 0 ? 1 : -1;
    }
  }

  if (signals.length === 0) return null;
  const rating = pts > 0 ? "bull" : pts < 0 ? "bear" : "neutral";
  return { rating, signals };
}

/**
 * 逐代码并发查询大宗交易（fund block，近 7 天区间）与融资融券（fund margin，最新披露日），
 * 均仅支持 A 股个股。两者批量输出的列集与归属不一致，故统一走单代码格式解析（信息最全）。
 */
export async function fetchBlockMargin(codes: string[]): Promise<BlockMarginResult> {
  const unique = [...new Set(codes)].filter(Boolean);
  const entries = new Map<string, BlockMarginEntryData>();
  if (unique.length === 0) {
    return { entries, authRequired: false, authUrl: null, error: null };
  }

  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const endDate = fmtDate(new Date());
  const startDate = fmtDate(new Date(Date.now() - 7 * 24 * 3600 * 1000));

  let authUrl: string | null = null;
  let rateLimited = false;
  const runOne = async (args: string[]): Promise<string | null> => {
    try {
      const out = await runWestock(args, 15000);
      const authMatch = out.match(AUTH_RE);
      if (authMatch) {
        authUrl ??= authMatch[1];
        return null;
      }
      return out;
    } catch {
      return null;
    }
  };

  // westock 客户端有本地限流（LOCAL_RATE_LIMITED / 请求过于频繁 / 服务限频），并发收敛到 2
  const CONCURRENCY = 2;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const got = await Promise.all(
      batch.flatMap((c) => [
        runOne(["fund", "block", c, "--start", startDate, "--end", endDate]).then((out) => ({ code: c, cmd: "block" as const, out })),
        runOne(["fund", "margin", c]).then((out) => ({ code: c, cmd: "margin" as const, out })),
      ])
    );
    for (const { code, cmd, out } of got) {
      if (out === null) continue; // 未授权或失败
      if (/服务限频|请求过于频繁|RATE_LIMITED/i.test(out)) rateLimited = true;
      const entry: BlockMarginEntryData = entries.get(code) ?? { block: null, margin: null, summary: null };
      if (cmd === "block") entry.block = parseBlockOutput(out, endDate);
      else entry.margin = parseMarginOutput(out);
      entry.summary = deriveBlockMarginSummary(entry.block, entry.margin);
      entries.set(code, entry);
    }
  }

  return {
    entries,
    authRequired: authUrl !== null,
    authUrl,
    error: rateLimited ? "westock 接口限频，部分数据可能缺失，请稍后刷新重试" : null,
  };
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
