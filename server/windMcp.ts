/**
 * 万得「金融文档检索」MCP 客户端（Node 版）。
 * 协议与用法参照根目录 wind_news_agent.py：JSON-RPC 2.0 over HTTP POST，
 * 响应为 SSE 流或普通 JSON，鉴权 Bearer Token。
 *
 * 服务端工具（tools/list 动态获取）：
 *   - get_financial_news(query, top_k)         财经新闻/市场评论
 *   - get_company_announcements(query, top_k)  上市公司官方公告
 * 文档条目字段：title / date / content / url / doc_type
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RateLimiter } from "./rateLimit.js";

export const WIND_MCP_ENDPOINT =
  process.env.WIND_MCP_ENDPOINT || "https://mcp.wind.com.cn/vserver_financial_docs/mcp/";

/** 股票研究服务（stock_get_company_earnings_estimate 等） */
export const WIND_STOCK_RESEARCH_ENDPOINT =
  process.env.WIND_STOCK_RESEARCH_ENDPOINT || "https://mcp.wind.com.cn/vserver_stock_research/mcp/";

/** 股票数据服务（get_risk_metrics 等） */
export const WIND_STOCK_DATA_ENDPOINT =
  process.env.WIND_STOCK_DATA_ENDPOINT || "https://mcp.wind.com.cn/vserver_stock_data/mcp/";

/** westock 代码（sh600519/sz300253/bj831399/hk00700）→ Wind 代码（600519.SH/300253.SZ/831399.BJ/00700.HK） */
export function toWindCode(code: string): string {
  const m = code.match(/^(sh|sz|bj)(\d{6})$/);
  if (m) return `${m[2]}.${m[1].toUpperCase()}`;
  const hk = code.match(/^hk(\d{1,5})$/);
  if (hk) return `${hk[1].padStart(5, "0")}.HK`;
  return code; // 其余（如美股）原样交由服务端识别
}

/** 按 优先级 读取万得 Key：环境变量 > ~/.wind-aifinmarket/config。 */
export function loadWindApiKey(): string {
  const env = (process.env.WIND_API_KEY ?? "").trim();
  if (env) return env;
  const config = path.join(os.homedir(), ".wind-aifinmarket", "config");
  try {
    if (fs.existsSync(config)) {
      for (const line of fs.readFileSync(config, "utf-8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("WIND_API_KEY")) {
          const v = t.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
          if (v && !v.startsWith("#")) return v;
        }
      }
    }
  } catch {
    /* 配置文件读取失败（权限/竞态删除）按未配置处理，避免 fs 异常沿调用链被误标为 configMissing */
  }
  return "";
}

/** MCP 文档条目（get_financial_news / get_company_announcements 返回） */
export interface WindDoc {
  title: string;
  date: string;
  content: string;
  url: string;
  doc_type: string;
}

export class WindMCPClient {
  // 万得 MCP 全局限流（跨服务/实例共享）：QPS ≤ 2，避免触发套餐「每秒请求频率超过限制」
  private static readonly limiter = new RateLimiter(2, 1000);
  private id = 0;

  constructor(
    private endpoint: string = WIND_MCP_ENDPOINT,
    private apiKey: string = ""
  ) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
  }

  /** 发送一条 JSON-RPC 请求，解析 SSE 流或普通 JSON 并返回 result（出错抛异常）。 */
  /** 发送一条 JSON-RPC 请求，解析 SSE 流或普通 JSON 并返回 result（出错抛异常）。受全局 2 QPS 限流。 */
  private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    await WindMCPClient.limiter.acquire();
    this.id += 1;
    const resp = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    if (resp.status === 401) {
      throw new Error("万得 MCP 认证失败，请检查 WIND_API_KEY");
    }
    if (!resp.ok) {
      throw new Error(`万得 MCP 请求失败：HTTP ${resp.status}`);
    }

    const contentType = resp.headers.get("content-type") ?? "";
    const text = await resp.text();

    // 响应可能是 SSE（事件按空行分隔，事件内多行 data 需按规范用 \n 拼接），也可能是普通 JSON
    let payload: any = null;
    if (contentType.includes("text/event-stream")) {
      for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
        const dataLines = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          const parsed = JSON.parse(dataLines.join("\n"));
          // 只认响应事件（带 id 或含 result/error），跳过通知/日志类事件，避免 payload 停在通知对象上导致误导报错
          if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed || parsed.id !== undefined)) {
            payload = parsed;
          }
        } catch {
          continue; // 跳过无法解析的事件（如注释、心跳）
        }
      }
    } else {
      try {
        payload = JSON.parse(text);
      } catch {
        /* 保持 null */
      }
    }
    if (!payload) throw new Error(`万得 MCP 响应中未找到数据: ${text.slice(0, 200)}`);
    if (payload.error) throw new Error(`万得 MCP 错误: ${JSON.stringify(payload.error)}`);
    return payload.result;
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    return (await this.rpc("tools/list", {}))?.tools ?? [];
  }

  /** 调用服务端工具，把 content[0].text 里的 JSON 字符串解析成 dict。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    try {
      return JSON.parse(result?.content?.[0]?.text ?? "");
    } catch {
      // 服务端返回纯文本错误（如积分不足、限流提示）时原文抛出，让调用方可见；
      // result 为 null/结构异常时给出可读错误，避免 catch 内二次解引用 TypeError 掩盖原错误
      const text = String(result?.content?.[0]?.text ?? "").trim();
      throw new Error(text ? `万得工具返回错误：${text.slice(0, 200)}` : "万得工具返回了无法解析的内容");
    }
  }
}

function toWindDoc(row: Record<string, unknown>): WindDoc {
  return {
    title: String(row.title ?? "").trim(),
    date: String(row.date ?? "").trim(),
    content: String(row.content ?? "").trim(),
    url: String(row.url ?? "").trim(),
    doc_type: String(row.doc_type ?? "").trim(),
  };
}

/** callTool 已把 content[0].text 解析成对象，这里直接取 data.items */
function parseWindDocs(parsed: any): WindDoc[] {
  const items = parsed?.data?.items ?? [];
  return items.map(toWindDoc).filter((d: WindDoc) => d.title);
}

async function callDocs(client: WindMCPClient, tool: string, query: string, topK: number): Promise<{ docs: WindDoc[]; error: string | null }> {
  try {
    return { docs: parseWindDocs(await client.callTool(tool, { query, top_k: topK })), error: null };
  } catch (e: any) {
    console.warn(`[wind] ${tool}(${query}) 失败:`, e?.message ?? e);
    // 错误随结果透传（认证失败/积分不足/限频），不再吞成空数组导致「真无数据」不可区分
    return { docs: [], error: String(e?.message ?? e) };
  }
}

export interface WindHoldingResult {
  news: WindDoc[];
  announcements: WindDoc[];
  error: string | null; // 两工具均失败时为首个错误（如 401/积分不足），成功为 null
}

/** 逐持仓并发查万得财经新闻与官方公告（单持仓内两工具串行，持仓间并发） */
export async function fetchWindNews(
  client: WindMCPClient,
  holdings: Array<{ code: string; name: string }>,
  opts: { newsTopK?: number; annTopK?: number; concurrency?: number } = {}
): Promise<Map<string, WindHoldingResult>> {
  const newsTopK = opts.newsTopK ?? 5;
  const annTopK = opts.annTopK ?? 3;
  const concurrency = opts.concurrency ?? 2;
  const result = new Map<string, WindHoldingResult>();
  for (let i = 0; i < holdings.length; i += concurrency) {
    const batch = holdings.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (h) => {
        const newsRes = await callDocs(client, "get_financial_news", h.name, newsTopK);
        const annRes = await callDocs(client, "get_company_announcements", h.name, annTopK);
        result.set(h.code, { news: newsRes.docs, announcements: annRes.docs, error: newsRes.error ?? annRes.error });
      })
    );
  }
  return result;
}

/** stock_get_company_earnings_estimate 的机构一致预期 */
export interface WindConsensusData {
  wind_code: string;
  rating: string | null; // 一致评级
  rating_count: number | null; // 评级机构家数
  target_price: number | null; // 一致目标价
  current_price: number | null; // 当前价
  upside: number | null; // 上涨空间 %
  forecast: Record<string, string | number> | null; // 未来三个财年的一致预测（原始键值）
  details: Array<Record<string, unknown>> | null; // 最新评级及预测明细
}

function parseWindConsensus(parsed: any, windCode: string): WindConsensusData | null {
  if (!parsed || typeof parsed !== "object") return null;
  const ratingBlock = parsed["当前机构评级"] ?? {};
  const forecast = parsed["未来三个财年的一致预测"] ?? null;
  const details = Array.isArray(parsed["最新评级及预测明细"]) ? parsed["最新评级及预测明细"] : null;
  const rating = (ratingBlock["一致评级"] ?? "") || null;
  const target = numOrNullW(ratingBlock["一致目标价"]);
  if (!rating && target === null && !forecast && !details) return null;
  return {
    wind_code: windCode,
    rating,
    rating_count: numOrNullW(ratingBlock["评级机构家数"]),
    target_price: target,
    current_price: numOrNullW(ratingBlock["当前价"]),
    upside: numOrNullW(ratingBlock["上涨空间(%)"]),
    forecast: forecast && typeof forecast === "object" ? forecast : null,
    details,
  };
}

const numOrNullW = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

export interface WindHoldingConsensus {
  consensus: WindConsensusData | null;
  error: string | null; // 该持仓的抓取错误（如积分不足），null 表示正常
}

/** 逐持仓并发查机构一致预期（vserver_stock_research，1 次/持仓） */
export async function fetchWindConsensus(
  holdings: Array<{ code: string; name: string }>,
  opts: { concurrency?: number } = {}
): Promise<Map<string, WindHoldingConsensus>> {
  const apiKey = loadWindApiKey();
  if (!apiKey) throw new Error("未找到万得 API Key：请设置环境变量 WIND_API_KEY，或在 ~/.wind-aifinmarket/config 中配置");
  const client = new WindMCPClient(WIND_STOCK_RESEARCH_ENDPOINT, apiKey);
  const concurrency = opts.concurrency ?? 2;
  const result = new Map<string, WindHoldingConsensus>();
  for (let i = 0; i < holdings.length; i += concurrency) {
    const batch = holdings.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (h) => {
        const windCode = toWindCode(h.code);
        try {
          const parsed = await client.callTool("stock_get_company_earnings_estimate", { windCode });
          result.set(h.code, { consensus: parseWindConsensus(parsed, windCode), error: null });
        } catch (e: any) {
          console.warn(`[wind] earnings_estimate(${h.code}) 失败:`, e?.message ?? e);
          result.set(h.code, { consensus: null, error: String(e?.message ?? e) });
        }
      })
    );
  }
  return result;
}

/** get_risk_metrics 的单张风险指标表（列名含窗口与单位，动态生成） */
export interface WindRiskTable {
  category: string; // 类别名（系统性风险/收益质量/波动与损失）
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface WindRiskData {
  wind_code: string;
  tables: WindRiskTable[];
}

// 三类风险指标的查询模板；列名由服务端按 NL 动态生成，前端通用表格渲染
const RISK_CATEGORIES = [
  { category: "系统性风险", metrics: "Beta和基准相关系数" },
  { category: "收益质量", metrics: "Jensen Alpha和夏普比率" },
  { category: "波动与损失", metrics: "年化波动率、VaR、最大回撤和区间下跌天数" },
];

// 四类公司事件的查询模板（get_stock_events）；宽泛问法会「没找到数据」，按分类分次问
const EVENT_CATEGORIES = [
  { category: "再融资与并购", metrics: "配股、增发与并购重组事件" },
  { category: "分红派息", metrics: "分红派息事件" },
  { category: "股本与股东", metrics: "限售解禁与大股东增减持事件" },
  { category: "治理与监管", metrics: "违规处罚与司法诉讼事件" },
];

/** 解析一张 NL 表格（取 data.data[0]，列名附带单位）；无数据返回 null */
function parseNLTable(parsed: any): { columns: string[]; rows: Array<Array<string | number | null>> } | null {
  const first = parsed?.data?.data?.[0];
  const rawColumns = first?.columns ?? [];
  const rows = first?.rows ?? [];
  if (rawColumns.length === 0 || rows.length === 0) return null;
  const columns = rawColumns.map((c: any) =>
    c?.unit ? `${c.name}(${c.unit})` : String(c?.name ?? "")
  );
  return {
    columns,
    rows: rows.map((row: any[]) =>
      row.map((v) => (v === null || v === undefined ? null : typeof v === "number" ? v : String(v)))
    ),
  };
}

/** 调一个 NL 表格工具；该查询无数据时服务端返回纯文本「没找到数据」，静默返回 null，其余错误上抛 */
async function callNLTable(
  client: WindMCPClient,
  tool: string,
  question: string
): Promise<{ columns: string[]; rows: Array<Array<string | number | null>> } | null> {
  try {
    return parseNLTable(await client.callTool(tool, { question }));
  } catch (e: any) {
    if (String(e?.message ?? "").includes("没找到数据")) return null;
    throw e;
  }
}

/** 解析一张风险指标表（取 data.data[0]，列名附带单位）；无数据返回 null */
function parseRiskTable(parsed: any, category: string): WindRiskTable | null {
  const table = parseNLTable(parsed);
  if (!table) return null;
  return { category, ...table };
}

async function callRiskTable(
  client: WindMCPClient,
  question: string,
  category: string
): Promise<WindRiskTable | null> {
  try {
    return parseRiskTable(await client.callTool("get_risk_metrics", { question }), category);
  } catch (e: any) {
    // 该分类无数据时服务端返回纯文本「没找到数据」，静默跳过；其余错误上抛
    if (String(e?.message ?? "").includes("没找到数据")) return null;
    throw e;
  }
}

export interface WindHoldingRisk {
  tables: WindRiskTable[];
  error: string | null; // 该持仓的抓取错误（如积分不足），null 表示正常
}

/** 逐持仓并发查三类风险指标（每持仓 3 次调用，分类内串行） */
export async function fetchWindRisk(
  holdings: Array<{ code: string; name: string }>,
  opts: { concurrency?: number } = {}
): Promise<Map<string, WindHoldingRisk>> {
  const apiKey = loadWindApiKey();
  if (!apiKey) throw new Error("未找到万得 API Key：请设置环境变量 WIND_API_KEY，或在 ~/.wind-aifinmarket/config 中配置");
  const client = new WindMCPClient(WIND_STOCK_DATA_ENDPOINT, apiKey);
  const concurrency = opts.concurrency ?? 2;
  const result = new Map<string, WindHoldingRisk>();
  for (let i = 0; i < holdings.length; i += concurrency) {
    const batch = holdings.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (h) => {
        const windCode = toWindCode(h.code);
        const tables: WindRiskTable[] = [];
        let error: string | null = null;
        for (const cat of RISK_CATEGORIES) {
          try {
            const t = await callRiskTable(
              client,
              `查询${h.name}（${windCode}）过去1年的${cat.metrics}`,
              cat.category
            );
            if (t) tables.push(t);
          } catch (e: any) {
            console.warn(`[wind] risk_metrics(${h.code}/${cat.category}) 失败:`, e?.message ?? e);
            error = error ?? String(e?.message ?? e);
          }
        }
        result.set(h.code, { tables, error });
      })
    );
  }
  return result;
}

export interface WindEventTable {
  category: string; // 事件类别（再融资与并购/分红派息/股本与股东/治理与监管）
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface WindEventsData {
  wind_code: string;
  tables: WindEventTable[];
}

/** 逐持仓并发查公司事件（get_stock_events，每持仓 4 次分类调用） */
export async function fetchWindEvents(
  holdings: Array<{ code: string; name: string }>,
  opts: { concurrency?: number } = {}
): Promise<Map<string, { tables: WindEventTable[]; error: string | null }>> {
  const apiKey = loadWindApiKey();
  if (!apiKey) throw new Error("未找到万得 API Key：请设置环境变量 WIND_API_KEY，或在 ~/.wind-aifinmarket/config 中配置");
  const client = new WindMCPClient(WIND_STOCK_DATA_ENDPOINT, apiKey);
  const concurrency = opts.concurrency ?? 2;
  const result = new Map<string, { tables: WindEventTable[]; error: string | null }>();
  for (let i = 0; i < holdings.length; i += concurrency) {
    const batch = holdings.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (h) => {
        const windCode = toWindCode(h.code);
        const tables: WindEventTable[] = [];
        let error: string | null = null;
        for (const cat of EVENT_CATEGORIES) {
          try {
            const t = await callNLTable(
              client,
              "get_stock_events",
              `查询${h.name}（${windCode}）近1年的${cat.metrics}`
            );
            if (t) tables.push({ category: cat.category, ...t });
          } catch (e: any) {
            console.warn(`[wind] stock_events(${h.code}/${cat.category}) 失败:`, e?.message ?? e);
            error = error ?? String(e?.message ?? e);
          }
        }
        result.set(h.code, { tables, error });
      })
    );
  }
  return result;
}

/** stock_get_money_flow_analysis 的资金面数据（原样分块 + 关键元信息） */
export interface WindMoneyFlowData {
  wind_code: string;
  trade_date: string; // 交易日期
  trade_time: string; // 交易时间
  // 资金面数据原样分块：主力资金/融资融券/陆股通/成交活跃度/基金机构持仓/十大流通股东变化
  // 每块形如 { 字段: string[], 最近5日: any[][], 近20日?: any[][] }；陆股通为扁平键值
  sections: Record<string, any>;
}

function parseWindMoneyFlow(parsed: any, windCode: string): WindMoneyFlowData | null {
  const zj = parsed?.["资金面数据"];
  if (!zj || typeof zj !== "object") return null;
  const metaKeys = ["tool", "入参", "交易日期", "交易时间", "证券代码", "证券简称"];
  const sections: Record<string, any> = {};
  for (const [k, v] of Object.entries(zj)) {
    if (metaKeys.includes(k)) continue;
    if (v && typeof v === "object") sections[k] = v;
  }
  if (Object.keys(sections).length === 0) return null;
  return {
    wind_code: windCode,
    trade_date: String(zj["交易日期"] ?? ""),
    trade_time: String(zj["交易时间"] ?? ""),
    sections,
  };
}

export interface WindHoldingMoneyFlow {
  moneyflow: WindMoneyFlowData | null;
  error: string | null; // 该持仓的抓取错误（如积分不足），null 表示正常
}

/** 逐持仓并发查资金面数据（vserver_stock_research 的 stock_get_money_flow_analysis，1 次/持仓） */
export async function fetchWindMoneyFlow(
  holdings: Array<{ code: string; name: string }>,
  opts: { concurrency?: number } = {}
): Promise<Map<string, WindHoldingMoneyFlow>> {
  const apiKey = loadWindApiKey();
  if (!apiKey) throw new Error("未找到万得 API Key：请设置环境变量 WIND_API_KEY，或在 ~/.wind-aifinmarket/config 中配置");
  const client = new WindMCPClient(WIND_STOCK_RESEARCH_ENDPOINT, apiKey);
  const concurrency = opts.concurrency ?? 2;
  const result = new Map<string, WindHoldingMoneyFlow>();
  for (let i = 0; i < holdings.length; i += concurrency) {
    const batch = holdings.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (h) => {
        const windCode = toWindCode(h.code);
        try {
          const parsed = await client.callTool("stock_get_money_flow_analysis", { windCode });
          result.set(h.code, { moneyflow: parseWindMoneyFlow(parsed, windCode), error: null });
        } catch (e: any) {
          console.warn(`[wind] money_flow(${h.code}) 失败:`, e?.message ?? e);
          result.set(h.code, { moneyflow: null, error: String(e?.message ?? e) });
        }
      })
    );
  }
  return result;
}

export interface WindToolHoldingResult {
  data: any; // 工具返回的 JSON（形状因工具而异，前端通用渲染）
  error: string | null; // 该持仓的抓取错误（如积分不足），null 表示正常
}

/** 逐持仓并发调用任一返回 JSON 的 stock_research 工具（1 次/持仓），data 为解析后的原始对象 */
export async function fetchWindToolData(
  holdings: Array<{ code: string; name: string }>,
  tool: string,
  opts: { concurrency?: number } = {}
): Promise<Map<string, WindToolHoldingResult>> {
  const apiKey = loadWindApiKey();
  if (!apiKey) throw new Error("未找到万得 API Key：请设置环境变量 WIND_API_KEY，或在 ~/.wind-aifinmarket/config 中配置");
  const client = new WindMCPClient(WIND_STOCK_RESEARCH_ENDPOINT, apiKey);
  const concurrency = opts.concurrency ?? 2;
  const result = new Map<string, WindToolHoldingResult>();
  for (let i = 0; i < holdings.length; i += concurrency) {
    const batch = holdings.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (h) => {
        const windCode = toWindCode(h.code);
        try {
          const parsed = await client.callTool(tool, { windCode });
          result.set(h.code, { data: parsed ?? null, error: null });
        } catch (e: any) {
          console.warn(`[wind] ${tool}(${h.code}) 失败:`, e?.message ?? e);
          result.set(h.code, { data: null, error: String(e?.message ?? e) });
        }
      })
    );
  }
  return result;
}

/** 乖离率与心理线补充块，与技术面分块同构（{ 字段, 最近5日 }），前端共用转置表渲染 */
function biasPsyBlock(
  table: { columns: string[]; rows: Array<Array<string | number | null>> },
  date: string
): Record<string, any> | null {
  const metrics = ["5日BIAS乖离率", "36日BIAS乖离率", "12日PSY心理线"];
  const row = table.rows[0];
  // 列名按前缀匹配（parseNLTable 可能附加单位后缀），排除「.周期数/.周期」子列
  const values = metrics.map((k) => {
    const i = table.columns.findIndex((c) => c.startsWith(k) && !c.includes("."));
    return i >= 0 ? row[i] : null;
  });
  if (values.every((v) => v === null)) return null;
  return { 字段: ["日期", ...metrics], 最近5日: [[date, ...values]] };
}

/** 逐持仓并发查乖离率与心理线（vserver_stock_data 的 get_stock_technicals NL 工具，1 次/持仓）。
 * stock_get_technical_analysis 不含这些指标，作为技术面补充块合并进快照；单持仓失败/无数据返回 null 不影响其余。 */
export async function fetchWindBiasPsy(
  holdings: Array<{ code: string; name: string }>,
  date: string,
  opts: { concurrency?: number } = {}
): Promise<Map<string, Record<string, any> | null>> {
  const apiKey = loadWindApiKey();
  if (!apiKey) throw new Error("未找到万得 API Key：请设置环境变量 WIND_API_KEY，或在 ~/.wind-aifinmarket/config 中配置");
  const client = new WindMCPClient(WIND_STOCK_DATA_ENDPOINT, apiKey);
  const concurrency = opts.concurrency ?? 2;
  const result = new Map<string, Record<string, any> | null>();
  for (let i = 0; i < holdings.length; i += concurrency) {
    const batch = holdings.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (h) => {
        const windCode = toWindCode(h.code);
        try {
          const table = await callNLTable(
            client,
            "get_stock_technicals",
            `查询${h.name}（${windCode}）的5日乖离率BIAS、36日乖离率和12周期心理线指标PSY`
          );
          result.set(h.code, table ? biasPsyBlock(table, date) : null);
        } catch (e: any) {
          console.warn(`[wind] technicals(${h.code}) 失败:`, e?.message ?? e);
          result.set(h.code, null);
        }
      })
    );
  }
  return result;
}
