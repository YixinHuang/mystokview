import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import {
  db,
  seedIfEmpty,
  holdingRepo,
  chatRepo,
  techSnapshotRepo,
  newsSnapshotRepo,
  consensusSnapshotRepo,
  reportsSnapshotRepo,
  fundFlowSnapshotRepo,
  blockMarginSnapshotRepo,
  windNewsSnapshotRepo,
  windConsensusSnapshotRepo,
  windRiskSnapshotRepo,
  windEventsSnapshotRepo,
  windMoneyFlowSnapshotRepo,
  windValuationSnapshotRepo,
  windUpdatesSnapshotRepo,
  windTechnicalSnapshotRepo,
  windProfileSnapshotRepo,
  type SnapshotRepo,
  type HoldingRow,
} from "./db.js";
import { fetchQuotes, checkAuth, isWestockInstalled, searchCode, fetchNews, fetchNewsDetail, fetchTechnical, fetchConsensus, fetchReports, fetchReportDetail, fetchFundFlow, fetchBlockMargin, type Quote } from "./market.js";
import { WindMCPClient, fetchWindNews, fetchWindConsensus, fetchWindRisk, fetchWindEvents, fetchWindMoneyFlow, fetchWindToolData, loadWindApiKey, WIND_MCP_ENDPOINT } from "./windMcp.js";
import { runHousekeeperTurn } from "./agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);

seedIfEmpty();

// 启动预检：检测行情源 westock 的安装与授权状态，给出明确引导
(async () => {
  if (!isWestockInstalled()) {
    console.warn("[market] 未检测到 westock 命令行工具，行情将使用本地缓存。");
    console.warn("         请运行 `npm run setup` 查看安装与授权指引。");
  } else {
    const auth = await checkAuth();
    if (!auth.authed) {
      console.warn("[market] westock 已安装但未授权，行情将使用本地缓存。");
      console.warn("         请在页面顶部 banner 打开授权链接完成扫码，或运行 `npm run setup`。");
    } else {
      console.log(`[market] westock 已就绪（${auth.version}），行情正常。`);
    }
  }
})().catch((e) => console.warn("[market] 行情源预检失败：", e?.message ?? e));

const app = express();
app.use(cors());
app.use(express.json());

const round2 = (n: number) => Math.round(n * 100) / 100;

// 历史快照通用：?date= 合法性校验与快照日期（抓取当日）
const SNAP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface HoldingComputed extends HoldingRow {
  price: number | null;
  prev_close: number | null;
  change_percent: number | null;
  quote_time: string | null;
  market_value: number | null;
  cost_amount: number;
  float_pnl: number | null;
  float_pnl_pct: number | null;
  weight: number | null;
}

async function buildHoldingsPayload() {
  const rows = holdingRepo.list();
  const codes = rows.map((r) => r.code);
  const market = await fetchQuotes(codes);

  const items: HoldingComputed[] = rows.map((r) => {
    const q: Quote | undefined = market.quotes.get(r.code);
    const costAmount = r.cost_price * r.quantity;
    const marketValue = q ? q.price * r.quantity : null;
    const floatPnl = q ? marketValue! - costAmount : null;
    return {
      ...r,
      price: q?.price ?? null,
      prev_close: q?.prevClose ?? null,
      change_percent: q?.changePercent ?? null,
      quote_time: q?.time ?? null,
      market_value: marketValue !== null ? round2(marketValue) : null,
      cost_amount: round2(costAmount),
      float_pnl: floatPnl !== null ? round2(floatPnl) : null,
      float_pnl_pct: q && costAmount > 0 ? round2((floatPnl! / costAmount) * 100) : null,
      weight: null,
    };
  });

  const totalMarketValue = items.reduce((s, i) => s + (i.market_value ?? 0), 0);
  const totalCost = items.reduce((s, i) => s + i.cost_amount, 0);
  const totalFloatPnl = items.reduce((s, i) => s + (i.float_pnl ?? 0), 0);
  const totalRealizedPnl = items.reduce((s, i) => s + i.realized_pnl, 0);
  for (const i of items) {
    i.weight = i.market_value !== null && totalMarketValue > 0
      ? round2((i.market_value / totalMarketValue) * 100)
      : null;
  }

  return {
    holdings: items,
    summary: {
      total_market_value: round2(totalMarketValue),
      total_cost: round2(totalCost),
      total_float_pnl: round2(totalFloatPnl),
      total_float_pnl_pct: totalCost > 0 ? round2((totalFloatPnl / totalCost) * 100) : 0,
      total_realized_pnl: round2(totalRealizedPnl),
      count: items.length,
    },
    market: {
      stale: market.stale,
      authRequired: market.authRequired,
      authUrl: market.authUrl,
      error: market.error,
    },
  };
}

// ---------- 持仓 API ----------

app.get("/api/holdings", async (_req, res) => {
  try {
    res.json(await buildHoldingsPayload());
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/holdings", async (req, res) => {
  try {
    const { code: rawCode, name: rawName, quantity, cost_price, open_date } = req.body ?? {};
    if (quantity === undefined || cost_price === undefined) {
      return res.status(400).json({ error: "quantity 和 cost_price 必填" });
    }
    // Number("abc") 为 NaN，直接入库会被 better-sqlite3 绑定 NULL 触发 NOT NULL 约束错误
    const qty = Number(quantity);
    const cost = Number(cost_price);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "quantity 必须为大于 0 的数字" });
    }
    if (!Number.isFinite(cost) || cost < 0) {
      return res.status(400).json({ error: "cost_price 必须为不小于 0 的数字" });
    }
    let code = String(rawCode ?? "").trim();
    let name = String(rawName ?? "").trim();
    if (!code && name) {
      const results = await searchCode(name);
      if (results.length === 0) return res.status(404).json({ error: `未搜索到「${name}」对应的证券代码` });
      code = results[0].code;
      name = results[0].name;
    }
    if (!code) return res.status(400).json({ error: "code 或 name 至少提供一个" });
    if (!name) {
      const results = await searchCode(code);
      name = results.find((r) => r.code === code)?.name || code;
    }
    if (holdingRepo.getByCode(code)) {
      return res.status(409).json({ error: `${code} 已在持仓中` });
    }
    const row = holdingRepo.create({
      code, name,
      quantity: qty,
      cost_price: cost,
      open_date: open_date ? String(open_date) : undefined,
    });
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.patch("/api/holdings/:code", (req, res) => {
  try {
    const { quantity, cost_price, realized_pnl } = req.body ?? {};
    const before = holdingRepo.getByCode(req.params.code);
    if (!before) return res.status(404).json({ error: "持仓不存在" });
    const patch: Record<string, number> = {};
    if (quantity !== undefined) {
      const n = Number(quantity);
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: "quantity 必须为大于 0 的数字" });
      patch.quantity = n;
    }
    if (cost_price !== undefined) {
      const n = Number(cost_price);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "cost_price 必须为不小于 0 的数字" });
      patch.cost_price = n;
    }
    if (realized_pnl !== undefined) {
      const n = Number(realized_pnl);
      if (!Number.isFinite(n)) return res.status(400).json({ error: "realized_pnl 必须为数字" });
      patch.realized_pnl = n;
    }
    const after = holdingRepo.update(req.params.code, patch);
    res.json({ before, after });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.delete("/api/holdings/:code", (req, res) => {
  const before = holdingRepo.getByCode(req.params.code);
  if (!before) return res.status(404).json({ error: "持仓不存在" });
  holdingRepo.remove(req.params.code);
  res.json({ success: true, deleted: before });
});

// ---------- 行情 API ----------

app.get("/api/quotes", async (req, res) => {
  try {
    const codes = String(req.query.codes ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const market = await fetchQuotes(codes);
    res.json({
      quotes: Object.fromEntries(market.quotes),
      stale: market.stale,
      authRequired: market.authRequired,
      authUrl: market.authUrl,
      error: market.error,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  try {
    res.json(await searchCode(q));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/api/auth/status", async (_req, res) => {
  const auth = await checkAuth();
  res.json(auth);
});

// ---------- 新闻 API ----------

// 每只持仓的最新一条新闻（westock news list，--type 2 仅新闻）；带 ?date= 时读本地快照
app.get("/api/news", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = newsSnapshotRepo.getByDate(queryDate);
      return res.json({
        items: rows.map((r) => ({ code: r.code, name: r.name, news: snaps.get(r.code)?.news ?? null })),
        date: queryDate,
        fromDb: true,
        availableDates: newsSnapshotRepo.listDates(),
        authRequired: false,
        authUrl: null,
        error: null,
      });
    }
    const { news, authRequired, authUrl, error } = await fetchNews(rows.map((r) => r.code));
    const items = rows.map((r) => ({ code: r.code, name: r.name, news: news.get(r.code) ?? null }));
    const snapshots = items
      .filter((i) => i.news)
      .map((i) => ({ code: i.code, date: todayStr(), payload: { news: i.news } }));
    if (snapshots.length > 0) newsSnapshotRepo.upsertMany(snapshots);
    res.json({
      items,
      date: null,
      fromDb: false,
      availableDates: newsSnapshotRepo.listDates(),
      authRequired,
      authUrl,
      error,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 新闻详情（westock news detail），前端弹窗展示
app.get("/api/news/detail", async (req, res) => {
  const id = String(req.query.id ?? "").trim();
  if (!/^[A-Za-z0-9]+$/.test(id)) {
    return res.status(400).json({ error: "无效的新闻 ID" });
  }
  try {
    const detail = await fetchNewsDetail(id);
    if (!detail) {
      return res.status(404).json({ error: "未能获取新闻详情，请稍后重试或检查 westock 授权状态" });
    }
    res.json(detail);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 技术分析：每只持仓的最新技术指标（westock technical）+ 筹码成本（westock chip）+ 汇总评级。
// 带 date 参数时从 SQLite 读该日历史快照（不查 westock）；不带时实时抓取并持久化。
app.get("/api/technical", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const queryDate = String(req.query.date ?? "").trim();
    const countByRating = (items: Array<{ summary: { rating: string } | null }>) => ({
      bull: items.filter((i) => i.summary?.rating === "bull").length,
      neutral: items.filter((i) => i.summary?.rating === "neutral").length,
      bear: items.filter((i) => i.summary?.rating === "bear").length,
      total: items.length,
    });

    // 历史快照模式
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = techSnapshotRepo.getByDate(queryDate);
      const items = rows.map((r) => {
        const p = snaps.get(r.code);
        return { code: r.code, name: r.name, tech: p?.tech ?? null, chip: p?.chip ?? null, summary: p?.summary ?? null };
      });
      return res.json({
        items,
        summary: countByRating(items),
        date: queryDate,
        fromDb: true,
        availableDates: techSnapshotRepo.listDates(),
        authRequired: false,
        authUrl: null,
        error: null,
      });
    }

    // 实时模式：抓取后按（代码, 指标日期）持久化
    const { entries, authRequired, authUrl, error } = await fetchTechnical(rows.map((r) => r.code));
    const items = rows.map((r) => {
      const e = entries.get(r.code);
      return { code: r.code, name: r.name, tech: e?.tech ?? null, chip: e?.chip ?? null, summary: e?.summary ?? null };
    });
    const snapshots = items
      .filter((i) => i.tech)
      .map((i) => ({ code: i.code, date: i.tech!.date, payload: { tech: i.tech, chip: i.chip, summary: i.summary } }));
    if (snapshots.length > 0) techSnapshotRepo.upsertMany(snapshots);
    res.json({
      items,
      summary: countByRating(items),
      date: null,
      fromDb: false,
      availableDates: techSnapshotRepo.listDates(),
      authRequired,
      authUrl,
      error,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 一致预期：每只持仓的最新一致预期（westock consensus）+ 机构评级（westock rating）+ 股票评分（westock score）+ 汇总评级
app.get("/api/consensus", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = consensusSnapshotRepo.getByDate(queryDate);
      const items = rows.map((r) => {
        const p = snaps.get(r.code);
        return {
          code: r.code,
          name: r.name,
          price: p?.price ?? null,
          consensus: p?.consensus ?? null,
          rating: p?.rating ?? null,
          score: p?.score ?? null,
          summary: p?.summary ?? null,
        };
      });
      return res.json({
        items,
        summary: {
          bull: items.filter((i) => i.summary?.rating === "bull").length,
          neutral: items.filter((i) => i.summary?.rating === "neutral").length,
          bear: items.filter((i) => i.summary?.rating === "bear").length,
          total: items.length,
        },
        date: queryDate,
        fromDb: true,
        availableDates: consensusSnapshotRepo.listDates(),
        authRequired: false,
        authUrl: null,
        error: null,
      });
    }
    const { entries, authRequired, authUrl, error } = await fetchConsensus(rows.map((r) => r.code));
    const items = rows.map((r) => {
      const e = entries.get(r.code);
      return {
        code: r.code,
        name: r.name,
        price: e?.price ?? null,
        consensus: e?.consensus ?? null,
        rating: e?.rating ?? null,
        score: e?.score ?? null,
        summary: e?.summary ?? null,
      };
    });
    const snapshots = items
      .filter((i) => i.consensus || i.rating || i.score)
      .map((i) => ({
        code: i.code,
        date: todayStr(),
        payload: { consensus: i.consensus, rating: i.rating, score: i.score, summary: i.summary },
      }));
    if (snapshots.length > 0) consensusSnapshotRepo.upsertMany(snapshots);
    res.json({
      items,
      summary: {
        bull: items.filter((i) => i.summary?.rating === "bull").length,
        neutral: items.filter((i) => i.summary?.rating === "neutral").length,
        bear: items.filter((i) => i.summary?.rating === "bear").length,
        total: items.length,
      },
      date: null,
      fromDb: false,
      availableDates: consensusSnapshotRepo.listDates(),
      authRequired,
      authUrl,
      error,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 我的研报：每只持仓的最新研报列表（westock report list，每只默认最多 3 条）；带 ?date= 时读本地快照
app.get("/api/reports", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = reportsSnapshotRepo.getByDate(queryDate);
      return res.json({
        items: rows.map((r) => ({ code: r.code, name: r.name, reports: snaps.get(r.code)?.reports ?? [] })),
        date: queryDate,
        fromDb: true,
        availableDates: reportsSnapshotRepo.listDates(),
        authRequired: false,
        authUrl: null,
        error: null,
      });
    }
    const { reports, authRequired, authUrl, error } = await fetchReports(rows.map((r) => r.code));
    const items = rows.map((r) => ({ code: r.code, name: r.name, reports: reports.get(r.code) ?? [] }));
    const snapshots = items
      .filter((i) => i.reports.length > 0)
      .map((i) => ({ code: i.code, date: todayStr(), payload: { reports: i.reports } }));
    if (snapshots.length > 0) reportsSnapshotRepo.upsertMany(snapshots);
    res.json({
      items,
      date: null,
      fromDb: false,
      availableDates: reportsSnapshotRepo.listDates(),
      authRequired,
      authUrl,
      error,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 研报详情（westock report detail），前端弹窗展示
app.get("/api/reports/detail", async (req, res) => {
  const id = String(req.query.id ?? "").trim();
  if (!/^[A-Za-z0-9]+$/.test(id)) {
    return res.status(400).json({ error: "无效的研报 ID" });
  }
  try {
    const detail = await fetchReportDetail(id);
    if (!detail) {
      return res.status(404).json({ error: "未能获取研报详情，请稍后重试或检查 westock 授权状态" });
    }
    res.json(detail);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 资金流向：每只持仓的资金流向（fund flow）+ 融资融券（fund margin，A 股）+ 北向持仓（fund north-holding，A 股）
// + 卖空（fund short，港股）+ 南下持仓（fund south-holding，港股）；带 ?date= 时读本地快照
app.get("/api/fund-flow", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = fundFlowSnapshotRepo.getByDate(queryDate);
      const items = rows.map((r) => {
        const p = snaps.get(r.code);
        return {
          code: r.code,
          name: r.name,
          flow: p?.flow ?? null,
          margin: p?.margin ?? null,
          north: p?.north ?? null,
          short: p?.short ?? null,
          south: p?.south ?? null,
          summary: p?.summary ?? null,
        };
      });
      return res.json({
        items,
        summary: {
          inflow: items.filter((i) => i.flow && i.flow.main_net > 0).length,
          outflow: items.filter((i) => i.flow && i.flow.main_net < 0).length,
          total: items.length,
        },
        date: queryDate,
        fromDb: true,
        availableDates: fundFlowSnapshotRepo.listDates(),
        authRequired: false,
        authUrl: null,
        error: null,
      });
    }
    const { entries, authRequired, authUrl, error } = await fetchFundFlow(rows.map((r) => r.code));
    const items = rows.map((r) => {
      const e = entries.get(r.code);
      return {
        code: r.code,
        name: r.name,
        flow: e?.flow ?? null,
        margin: e?.margin ?? null,
        north: e?.north ?? null,
        short: e?.short ?? null,
        south: e?.south ?? null,
        summary: e?.summary ?? null,
      };
    });
    const snapshots = items
      .filter((i) => i.flow || i.margin || i.north || i.short || i.south)
      .map((i) => ({
        code: i.code,
        date: todayStr(),
        payload: {
          flow: i.flow,
          margin: i.margin,
          north: i.north,
          short: i.short,
          south: i.south,
          summary: i.summary,
        },
      }));
    if (snapshots.length > 0) fundFlowSnapshotRepo.upsertMany(snapshots);
    res.json({
      items,
      summary: {
        inflow: items.filter((i) => i.flow && i.flow.main_net > 0).length,
        outflow: items.filter((i) => i.flow && i.flow.main_net < 0).length,
        total: items.length,
      },
      date: null,
      fromDb: false,
      availableDates: fundFlowSnapshotRepo.listDates(),
      authRequired,
      authUrl,
      error,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 大宗交易与融资融券：每只持仓的最新大宗交易（westock fund block）+ 融资融券（westock fund margin）+ 汇总
app.get("/api/block-margin", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const queryDate = String(req.query.date ?? "").trim();
    const countByRating = (items: Array<{ summary: { rating: string } | null }>) => ({
      bull: items.filter((i) => i.summary?.rating === "bull").length,
      neutral: items.filter((i) => i.summary?.rating === "neutral").length,
      bear: items.filter((i) => i.summary?.rating === "bear").length,
      total: items.length,
    });
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = blockMarginSnapshotRepo.getByDate(queryDate);
      const items = rows.map((r) => {
        const p = snaps.get(r.code);
        return { code: r.code, name: r.name, block: p?.block ?? null, margin: p?.margin ?? null, summary: p?.summary ?? null };
      });
      return res.json({
        items,
        summary: countByRating(items),
        date: queryDate,
        fromDb: true,
        availableDates: blockMarginSnapshotRepo.listDates(),
        authRequired: false,
        authUrl: null,
        error: null,
      });
    }
    const { entries, authRequired, authUrl, error } = await fetchBlockMargin(rows.map((r) => r.code));
    const items = rows.map((r) => {
      const e = entries.get(r.code);
      return { code: r.code, name: r.name, block: e?.block ?? null, margin: e?.margin ?? null, summary: e?.summary ?? null };
    });
    const snapshots = items
      .filter((i) => i.block || i.margin)
      .map((i) => ({
        code: i.code,
        date: todayStr(),
        payload: { block: i.block, margin: i.margin, summary: i.summary },
      }));
    if (snapshots.length > 0) blockMarginSnapshotRepo.upsertMany(snapshots);
    res.json({
      items,
      summary: countByRating(items),
      date: null,
      fromDb: false,
      availableDates: blockMarginSnapshotRepo.listDates(),
      authRequired,
      authUrl,
      error,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Wind 新闻：万得 MCP（get_financial_news + get_company_announcements）。
// 加载时优先读当日快照（缺失持仓才补抓）；force=1 强制全量实时抓取并更新当日快照；?date= 读历史
app.get("/api/wind-news", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const today = todayStr();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = windNewsSnapshotRepo.getByDate(queryDate);
      return res.json({
        items: rows.map((r) => {
          const p = snaps.get(r.code);
          return { code: r.code, name: r.name, news: p?.news ?? [], announcements: p?.announcements ?? [] };
        }),
        date: queryDate,
        fromDb: true,
        snapshotDate: queryDate,
        isHistorical: true,
        availableDates: windNewsSnapshotRepo.listDates(),
        configMissing: false,
        error: null,
      });
    }

    // —— 单独刷新（?code=）：仅实时抓取一只股票，当日记录优先、其余持仓从最近日期记录补齐后合并落库 ——
    const singleCode = String(req.query.code ?? "").trim();
    if (singleCode) {
      const target = rows.find((r) => r.code === singleCode);
      if (!target) return res.status(404).json({ error: "持仓中不存在该证券" });
      const apiKey = loadWindApiKey();
      if (!apiKey) {
        return res.json({
          items: [],
          date: null,
          fromDb: false,
          snapshotDate: null,
          isHistorical: false,
          availableDates: windNewsSnapshotRepo.listDates(),
          configMissing: true,
          refreshed: null,
          error: "未找到万得 API Key：请设置环境变量 WIND_API_KEY，或在 ~/.wind-aifinmarket/config 中配置",
        });
      }
      const client = new WindMCPClient(WIND_MCP_ENDPOINT, apiKey);
      // 连接探测：与全刷路径一致，MCP 连不上时明确报错而非误报「无数据」
      try {
        await client.listTools();
      } catch (e: any) {
        // 返回最近日期快照视图而非空 items，否则前端 refreshOne 的 setData 会清空整个列表
        const dates = windNewsSnapshotRepo.listDates();
        const latest = dates[0] ?? null;
        const snaps = latest ? windNewsSnapshotRepo.getByDate(latest) : new Map<string, any>();
        return res.json({
          items: rows.map((r) => {
            const p = snaps.get(r.code);
            return { code: r.code, name: r.name, news: p?.news ?? [], announcements: p?.announcements ?? [] };
          }),
          date: latest,
          fromDb: dates.length > 0,
          snapshotDate: latest,
          isHistorical: dates.length > 0 && latest !== today,
          availableDates: dates,
          configMissing: false,
          refreshed: { code: target.code, noData: true },
          error: `万得 MCP 连接失败：${e?.message ?? e}`,
        });
      }
      const entries = await fetchWindNews(client, [{ code: target.code, name: target.name }]);
      const fresh = entries.get(target.code);
      const freshNews = fresh?.news ?? [];
      const freshAnn = fresh?.announcements ?? [];

      // 无当日数据：不落库，返回最近日期快照视图（fromDb/isHistorical 按实际标注，前端据此显示历史提示）
      if (freshNews.length === 0 && freshAnn.length === 0) {
        const dates = windNewsSnapshotRepo.listDates();
        const latest = dates[0] ?? null;
        const snaps = latest ? windNewsSnapshotRepo.getByDate(latest) : new Map<string, any>();
        return res.json({
          items: rows.map((r) => {
            const p = snaps.get(r.code);
            return { code: r.code, name: r.name, news: p?.news ?? [], announcements: p?.announcements ?? [] };
          }),
          date: latest,
          fromDb: dates.length > 0,
          snapshotDate: latest,
          isHistorical: dates.length > 0 && latest !== today,
          availableDates: dates,
          configMissing: false,
          refreshed: { code: target.code, noData: true },
          error: null,
        });
      }

      // 合并落库：该股票写入刚抓取的数据，当日已有记录的其他股票保持不变，无当日记录的从最近日期补底
      mergeSingleRefresh(windNewsSnapshotRepo, target.code, today, { news: freshNews, announcements: freshAnn });

      const snaps = windNewsSnapshotRepo.getByDate(today);
      return res.json({
        items: rows.map((r) => {
          const p = snaps.get(r.code);
          return { code: r.code, name: r.name, news: p?.news ?? [], announcements: p?.announcements ?? [] };
        }),
        date: today,
        fromDb: true,
        snapshotDate: today,
        isHistorical: false,
        availableDates: windNewsSnapshotRepo.listDates(),
        configMissing: false,
        refreshed: { code: target.code, noData: false },
        error: null,
      });
    }

    const force = req.query.force === "1";

    if (!force) {
      // 规则 1：读取最近日期的已有数据直接返回（页面加载的常规路径，不发起 MCP 调用）
      const dates = windNewsSnapshotRepo.listDates();
      if (dates.length > 0) {
        const latest = dates[0];
        const snaps = windNewsSnapshotRepo.getByDate(latest);
        return res.json({
          items: rows.map((r) => {
            const p = snaps.get(r.code);
            return { code: r.code, name: r.name, news: p?.news ?? [], announcements: p?.announcements ?? [] };
          }),
          date: latest,
          fromDb: true,
          snapshotDate: latest,
          isHistorical: latest !== today,
          availableDates: dates,
          configMissing: false,
          error: null,
        });
      }
    }

    // 规则 2/3：库里无数据（或强制刷新）→ 实时抓取当日数据并落库（有当日行则合并更新，无则新建）
    let configMissing = false;
    let topError: string | null = null;
    const apiKey = loadWindApiKey();
    if (!apiKey) {
      configMissing = true;
      topError = "未找到万得 API Key：请设置环境变量 WIND_API_KEY，或在 ~/.wind-aifinmarket/config 中配置";
    }
    if (!configMissing) {
      const client = new WindMCPClient(WIND_MCP_ENDPOINT, apiKey);
      try {
        const tools = await client.listTools();
        console.log(`[wind] MCP 工具: ${tools.map((t) => t.name).join(", ")}`);
      } catch (e: any) {
        topError = `万得 MCP 连接失败：${e?.message ?? e}`;
      }
      if (!topError) {
        try {
          const entries = await fetchWindNews(
            client,
            rows.map((r) => ({ code: r.code, name: r.name }))
          );
          const snapshots = rows
            .map((r) => {
              const e = entries.get(r.code);
              return { code: r.code, date: today, payload: { news: e?.news ?? [], announcements: e?.announcements ?? [] } };
            })
            .filter((s) => s.payload.news.length > 0 || s.payload.announcements.length > 0);
          if (snapshots.length > 0) windNewsSnapshotRepo.upsertMany(snapshots);
        } catch (e: any) {
          topError = String(e?.message ?? e);
        }
      }
    }

    const snaps = configMissing ? new Map<string, any>() : windNewsSnapshotRepo.getByDate(today);
    const items = rows.map((r) => {
      const p = snaps.get(r.code);
      return { code: r.code, name: r.name, news: p?.news ?? [], announcements: p?.announcements ?? [] };
    });
    res.json({
      items,
      date: null,
      fromDb: false,
      snapshotDate: today,
      isHistorical: false,
      availableDates: windNewsSnapshotRepo.listDates(),
      configMissing,
      error: topError,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Wind 一致预期：万得 MCP stock_get_company_earnings_estimate（机构一致预期/评级/盈利预测）。
// 加载时优先读当日快照（缺失持仓才补抓）；force=1 强制全量实时抓取并更新当日快照；?date= 读历史
app.get("/api/wind-consensus", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const today = todayStr();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = windConsensusSnapshotRepo.getByDate(queryDate);
      return res.json({
        items: rows.map((r) => {
          const p = snaps.get(r.code);
          return {
            code: r.code,
            name: r.name,
            consensus: p?.consensus ?? null,
            error: p?.error ?? null,
          };
        }),
        date: queryDate,
        fromDb: true,
        snapshotDate: queryDate,
        isHistorical: true,
        availableDates: windConsensusSnapshotRepo.listDates(),
        configMissing: false,
        error: null,
      });
    }

    // —— 单独刷新（?code=）：仅实时抓取一只股票，当日记录优先、其余持仓从最近日期记录补底合并落库 ——
    const singleCode = String(req.query.code ?? "").trim();
    if (singleCode) {
      const target = rows.find((r) => r.code === singleCode);
      if (!target) return res.status(404).json({ error: "持仓中不存在该证券" });
      let payload: unknown = null;
      let fetchError: string | null = null;
      let perError: string | null = null;
      let configMissing = false;
      try {
        const entries = await fetchWindConsensus([{ code: target.code, name: target.name }]);
        const e = entries.get(target.code);
        payload = e?.consensus ? { consensus: e.consensus, error: e.error ?? "" } : null;
        // 无数据时透传 per-holding 错误（积分不足/限频等），供前端具体提示
        perError = payload ? null : e?.error ?? null;
      } catch (e: any) {
        // fetchWindConsensus 仅在 Key 缺失时抛出
        configMissing = true;
        fetchError = String(e?.message ?? e);
      }
      // 有数据则合并落库（当日记录优先、其余持仓从最近日期记录补底）；无数据不落库
      if (payload) mergeSingleRefresh(windConsensusSnapshotRepo, target.code, today, payload);
      // 响应视图：落库成功为当日合并视图；无数据则维持最近日期视图并提示。
      // noData 且库中有历史时返回的就是最近日期快照视图，按实际标注 fromDb/isHistorical，前端才能显示历史提示而不误标「上次刷新」
      const dates = windConsensusSnapshotRepo.listDates();
      const viewDate = payload ? today : dates[0] ?? today;
      const snaps = windConsensusSnapshotRepo.getByDate(viewDate);
      const items = rows.map((r) => {
        const p = snaps.get(r.code);
        return { code: r.code, name: r.name, consensus: p?.consensus ?? null, error: p?.error ?? null };
      });
      return res.json({
        items,
        date: payload ? today : dates.length > 0 ? viewDate : null,
        fromDb: payload !== null || dates.length > 0,
        snapshotDate: viewDate,
        isHistorical: payload === null && viewDate !== today,
        availableDates: dates,
        configMissing,
        refreshed: { code: target.code, noData: payload === null },
        error: payload !== null ? null : fetchError ?? perError,
      });
    }

    const force = req.query.force === "1";

    if (!force) {
      // 规则 1：读取最近日期的已有数据直接返回（页面加载的常规路径，不发起 MCP 调用）
      const dates = windConsensusSnapshotRepo.listDates();
      if (dates.length > 0) {
        const latest = dates[0];
        const snaps = windConsensusSnapshotRepo.getByDate(latest);
        return res.json({
          items: rows.map((r) => {
            const p = snaps.get(r.code);
            return {
              code: r.code,
              name: r.name,
              consensus: p?.consensus ?? null,
              error: p?.error ?? null,
            };
          }),
          date: latest,
          fromDb: true,
          snapshotDate: latest,
          isHistorical: latest !== today,
          availableDates: dates,
          configMissing: false,
          error: null,
        });
      }
    }

    // 规则 2/3：库里无数据（或强制刷新）→ 实时抓取当日数据并落库（有当日行则合并更新，无则新建）
    let configMissing = false;
    let topError: string | null = null;
    try {
      const entries = await fetchWindConsensus(
        rows.map((r) => ({ code: r.code, name: r.name }))
      );
      // payload 附带 per-holding 错误（空串表示无错误，可覆盖旧错误）；抓取失败仅存错误不清数据（合并写保留旧 consensus）
      const snapshots = rows
        .map((r) => {
          const e = entries.get(r.code);
          return { code: r.code, date: today, payload: { consensus: e?.consensus ?? null, error: e?.error ?? "" } };
        })
        .filter((s) => s.payload.consensus || s.payload.error);
      if (snapshots.length > 0) {
        windConsensusSnapshotRepo.upsertMany(snapshots);
      }
    } catch (e: any) {
      // fetchWindConsensus 仅在 Key 缺失时抛出
      configMissing = true;
      topError = String(e?.message ?? e);
    }

    const snaps = windConsensusSnapshotRepo.getByDate(today);
    const items = rows.map((r) => {
      const p = snaps.get(r.code);
      return {
        code: r.code,
        name: r.name,
        consensus: p?.consensus ?? null,
        error: p?.error ?? null,
      };
    });
    res.json({
      items,
      date: null,
      fromDb: false,
      snapshotDate: today,
      isHistorical: false,
      availableDates: windConsensusSnapshotRepo.listDates(),
      configMissing,
      error: topError,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Wind 风险指标：万得 MCP get_risk_metrics（系统性风险/收益质量/波动与损失三类）。
// 加载时优先读当日快照（缺失持仓才补抓）；force=1 强制全量实时抓取并更新当日快照；?date= 读历史
app.get("/api/wind-risk", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const today = todayStr();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = windRiskSnapshotRepo.getByDate(queryDate);
      return res.json({
        items: rows.map((r) => {
          const p = snaps.get(r.code);
          return { code: r.code, name: r.name, tables: p?.tables ?? [], error: p?.error ?? null };
        }),
        date: queryDate,
        fromDb: true,
        snapshotDate: queryDate,
        isHistorical: true,
        availableDates: windRiskSnapshotRepo.listDates(),
        configMissing: false,
        error: null,
      });
    }

    // —— 单独刷新（?code=）：仅实时抓取一只股票，当日记录优先、其余持仓从最近日期记录补底合并落库 ——
    const singleCode = String(req.query.code ?? "").trim();
    if (singleCode) {
      const target = rows.find((r) => r.code === singleCode);
      if (!target) return res.status(404).json({ error: "持仓中不存在该证券" });
      let payload: unknown = null;
      let fetchError: string | null = null;
      let perError: string | null = null;
      let configMissing = false;
      try {
        const entries = await fetchWindRisk([{ code: target.code, name: target.name }]);
        const e = entries.get(target.code);
        payload = e?.tables?.length ? { tables: e.tables, error: e.error ?? "" } : null;
        // 无数据时透传 per-holding 错误（积分不足/限频等），供前端具体提示
        perError = payload ? null : e?.error ?? null;
      } catch (e: any) {
        // fetchWindRisk 仅在 Key 缺失时抛出
        configMissing = true;
        fetchError = String(e?.message ?? e);
      }
      // 有数据则合并落库（当日记录优先、其余持仓从最近日期记录补底）；无数据不落库
      if (payload) mergeSingleRefresh(windRiskSnapshotRepo, target.code, today, payload);
      // 响应视图：落库成功为当日合并视图；无数据则维持最近日期视图并提示。
      // noData 且库中有历史时返回的就是最近日期快照视图，按实际标注 fromDb/isHistorical，前端才能显示历史提示而不误标「上次刷新」
      const dates = windRiskSnapshotRepo.listDates();
      const viewDate = payload ? today : dates[0] ?? today;
      const snaps = windRiskSnapshotRepo.getByDate(viewDate);
      const items = rows.map((r) => {
        const p = snaps.get(r.code);
        return { code: r.code, name: r.name, tables: p?.tables ?? [], error: p?.error ?? null };
      });
      return res.json({
        items,
        date: payload ? today : dates.length > 0 ? viewDate : null,
        fromDb: payload !== null || dates.length > 0,
        snapshotDate: viewDate,
        isHistorical: payload === null && viewDate !== today,
        availableDates: dates,
        configMissing,
        refreshed: { code: target.code, noData: payload === null },
        error: payload !== null ? null : fetchError ?? perError,
      });
    }

    const force = req.query.force === "1";

    if (!force) {
      // 规则 1：读取最近日期的已有数据直接返回（页面加载的常规路径，不发起 MCP 调用）
      const dates = windRiskSnapshotRepo.listDates();
      if (dates.length > 0) {
        const latest = dates[0];
        const snaps = windRiskSnapshotRepo.getByDate(latest);
        return res.json({
          items: rows.map((r) => {
            const p = snaps.get(r.code);
            return { code: r.code, name: r.name, tables: p?.tables ?? [], error: p?.error ?? null };
          }),
          date: latest,
          fromDb: true,
          snapshotDate: latest,
          isHistorical: latest !== today,
          availableDates: dates,
          configMissing: false,
          error: null,
        });
      }
    }

    // 规则 2/3：库里无数据（或强制刷新）→ 实时抓取当日数据并落库（有当日行则合并更新，无则新建）
    let configMissing = false;
    let topError: string | null = null;
    try {
      const entries = await fetchWindRisk(
        rows.map((r) => ({ code: r.code, name: r.name }))
      );
      // payload 附带 per-holding 错误（空串表示无错误，可覆盖旧错误）；抓取失败仅存错误不清数据（合并写保留旧 tables）
      const snapshots = rows
        .map((r) => {
          const e = entries.get(r.code);
          return { code: r.code, date: today, payload: { tables: e?.tables ?? [], error: e?.error ?? "" } };
        })
        .filter((s) => s.payload.tables.length > 0 || s.payload.error);
      if (snapshots.length > 0) {
        windRiskSnapshotRepo.upsertMany(snapshots);
      }
    } catch (e: any) {
      // fetchWindRisk 仅在 Key 缺失时抛出
      configMissing = true;
      topError = String(e?.message ?? e);
    }

    const snaps = windRiskSnapshotRepo.getByDate(today);
    const items = rows.map((r) => {
      const p = snaps.get(r.code);
      return { code: r.code, name: r.name, tables: p?.tables ?? [], error: p?.error ?? null };
    });
    res.json({
      items,
      date: null,
      fromDb: false,
      snapshotDate: today,
      isHistorical: false,
      availableDates: windRiskSnapshotRepo.listDates(),
      configMissing,
      error: topError,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Wind 事件：万得 MCP get_stock_events（再融资与并购/分红派息/股本与股东/治理与监管四类）。
// 加载时优先读当日快照（缺失持仓才补抓）；force=1 强制全量实时抓取并更新当日快照；?date= 读历史
app.get("/api/wind-events", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const today = todayStr();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = windEventsSnapshotRepo.getByDate(queryDate);
      return res.json({
        items: rows.map((r) => {
          const p = snaps.get(r.code);
          return { code: r.code, name: r.name, tables: p?.tables ?? [], error: p?.error ?? null };
        }),
        date: queryDate,
        fromDb: true,
        snapshotDate: queryDate,
        isHistorical: true,
        availableDates: windEventsSnapshotRepo.listDates(),
        configMissing: false,
        error: null,
      });
    }

    // —— 单独刷新（?code=）：仅实时抓取一只股票，当日记录优先、其余持仓从最近日期记录补底合并落库 ——
    const singleCode = String(req.query.code ?? "").trim();
    if (singleCode) {
      const target = rows.find((r) => r.code === singleCode);
      if (!target) return res.status(404).json({ error: "持仓中不存在该证券" });
      let payload: unknown = null;
      let fetchError: string | null = null;
      let perError: string | null = null;
      let configMissing = false;
      try {
        const entries = await fetchWindEvents([{ code: target.code, name: target.name }]);
        const e = entries.get(target.code);
        payload = e?.tables?.length ? { tables: e.tables, error: e.error ?? "" } : null;
        // 无数据时透传 per-holding 错误（积分不足/限频等），供前端具体提示
        perError = payload ? null : e?.error ?? null;
      } catch (e: any) {
        // fetchWindEvents 仅在 Key 缺失时抛出
        configMissing = true;
        fetchError = String(e?.message ?? e);
      }
      // 有数据则合并落库（当日记录优先、其余持仓从最近日期记录补底）；无数据不落库
      if (payload) mergeSingleRefresh(windEventsSnapshotRepo, target.code, today, payload);
      // 响应视图：落库成功为当日合并视图；无数据则维持最近日期视图并提示。
      // noData 且库中有历史时返回的就是最近日期快照视图，按实际标注 fromDb/isHistorical，前端才能显示历史提示而不误标「上次刷新」
      const dates = windEventsSnapshotRepo.listDates();
      const viewDate = payload ? today : dates[0] ?? today;
      const snaps = windEventsSnapshotRepo.getByDate(viewDate);
      const items = rows.map((r) => {
        const p = snaps.get(r.code);
        return { code: r.code, name: r.name, tables: p?.tables ?? [], error: p?.error ?? null };
      });
      return res.json({
        items,
        date: payload ? today : dates.length > 0 ? viewDate : null,
        fromDb: payload !== null || dates.length > 0,
        snapshotDate: viewDate,
        isHistorical: payload === null && viewDate !== today,
        availableDates: dates,
        configMissing,
        refreshed: { code: target.code, noData: payload === null },
        error: payload !== null ? null : fetchError ?? perError,
      });
    }

    const force = req.query.force === "1";

    if (!force) {
      // 规则 1：读取最近日期的已有数据直接返回（页面加载的常规路径，不发起 MCP 调用）
      const dates = windEventsSnapshotRepo.listDates();
      if (dates.length > 0) {
        const latest = dates[0];
        const snaps = windEventsSnapshotRepo.getByDate(latest);
        return res.json({
          items: rows.map((r) => {
            const p = snaps.get(r.code);
            return { code: r.code, name: r.name, tables: p?.tables ?? [], error: p?.error ?? null };
          }),
          date: latest,
          fromDb: true,
          snapshotDate: latest,
          isHistorical: latest !== today,
          availableDates: dates,
          configMissing: false,
          error: null,
        });
      }
    }

    // 规则 2/3：库里无数据（或强制刷新）→ 实时抓取当日数据并落库（有当日行则合并更新，无则新建）
    let configMissing = false;
    let topError: string | null = null;
    try {
      const entries = await fetchWindEvents(
        rows.map((r) => ({ code: r.code, name: r.name }))
      );
      // payload 附带 per-holding 错误（空串表示无错误，可覆盖旧错误）；抓取失败仅存错误不清数据（合并写保留旧 tables）
      const snapshots = rows
        .map((r) => {
          const e = entries.get(r.code);
          return { code: r.code, date: today, payload: { tables: e?.tables ?? [], error: e?.error ?? "" } };
        })
        .filter((s) => s.payload.tables.length > 0 || s.payload.error);
      if (snapshots.length > 0) {
        windEventsSnapshotRepo.upsertMany(snapshots);
      }
    } catch (e: any) {
      // fetchWindEvents 仅在 Key 缺失时抛出
      configMissing = true;
      topError = String(e?.message ?? e);
    }

    const snaps = windEventsSnapshotRepo.getByDate(today);
    const items = rows.map((r) => {
      const p = snaps.get(r.code);
      return { code: r.code, name: r.name, tables: p?.tables ?? [], error: p?.error ?? null };
    });
    res.json({
      items,
      date: null,
      fromDb: false,
      snapshotDate: today,
      isHistorical: false,
      availableDates: windEventsSnapshotRepo.listDates(),
      configMissing,
      error: topError,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Wind 资金流向：万得 MCP stock_get_money_flow_analysis（主力资金/融资融券/陆股通/成交活跃度等）。
// 加载时优先读当日快照（缺失持仓才补抓）；force=1 强制全量实时抓取并更新当日快照；?date= 读历史
app.get("/api/wind-moneyflow", async (req, res) => {
  try {
    const rows = holdingRepo.list();
    const today = todayStr();
    const queryDate = String(req.query.date ?? "").trim();
    if (SNAP_DATE_RE.test(queryDate)) {
      const snaps = windMoneyFlowSnapshotRepo.getByDate(queryDate);
      return res.json({
        items: rows.map((r) => {
          const p = snaps.get(r.code);
          return { code: r.code, name: r.name, moneyflow: p?.moneyflow ?? null, error: p?.error ?? null };
        }),
        date: queryDate,
        fromDb: true,
        snapshotDate: queryDate,
        availableDates: windMoneyFlowSnapshotRepo.listDates(),
        configMissing: false,
        error: null,
      });
    }

    const force = req.query.force === "1";
    let snaps = windMoneyFlowSnapshotRepo.getByDate(today);
    const missing = rows.filter((r) => !snaps.has(r.code));
    let fromDb = false;
    let configMissing = false;
    let topError: string | null = null;

    if (!force && missing.length === 0) {
      // 当日数据已存在，直接读库（页面加载的常规路径）
      fromDb = true;
    } else {
      const targets = force ? rows : missing;
      try {
        const entries = await fetchWindMoneyFlow(
          targets.map((r) => ({ code: r.code, name: r.name }))
        );
        // 负缓存：确认无数据（无错误）的持仓也落当日空标记行，下次页面加载不再反复补抓；
        // per-holding 错误（限频等）不落库，下次加载仍会重试
        const snapshots = targets
          .map((r) => {
            const e = entries.get(r.code);
            return { code: r.code, date: today, payload: { moneyflow: e?.moneyflow ?? null, error: e?.error ?? "" } };
          })
          .filter((s) => s.payload.moneyflow || !s.payload.error);
        if (snapshots.length > 0) {
          windMoneyFlowSnapshotRepo.upsertMany(snapshots);
        }
      } catch (e: any) {
        // fetchWindMoneyFlow 仅在 Key 缺失时抛出
        configMissing = true;
        topError = String(e?.message ?? e);
      }
      snaps = windMoneyFlowSnapshotRepo.getByDate(today); // 重读合并后的当日快照
    }

    const items = rows.map((r) => {
      const p = snaps.get(r.code);
      return { code: r.code, name: r.name, moneyflow: p?.moneyflow ?? null, error: p?.error ?? null };
    });
    res.json({
      items,
      date: fromDb ? today : null,
      fromDb,
      snapshotDate: today,
      availableDates: windMoneyFlowSnapshotRepo.listDates(),
      configMissing,
      error: topError,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Wind 通用工具路由工厂：最近日期优先快照（有数据不发起 MCP 调用）+ force=1 强制当日实时重抓 + ?date= 历史
/** 单股票「单独刷新」的合并落库：当日记录优先、其余持仓从最近日期记录补底。
 * 该股票写入刚抓取的 payload；其他持仓若当日已有记录则保持不变，否则从最近日期记录复制补齐。 */
function mergeSingleRefresh(repo: SnapshotRepo, code: string, today: string, payload: unknown) {
  const upserts: Array<{ code: string; date: string; payload: unknown }> = [
    { code, date: today, payload },
  ];
  const todaySnaps = repo.getByDate(today);
  const latest = repo.listDates()[0];
  const latestSnaps = latest ? repo.getByDate(latest) : new Map<string, any>();
  for (const r of holdingRepo.list()) {
    if (r.code === code) continue;
    if (todaySnaps.has(r.code)) continue;
    const fromLatest = latestSnaps.get(r.code);
    if (fromLatest) upserts.push({ code: r.code, date: today, payload: fromLatest });
  }
  repo.upsertMany(upserts);
}

function windToolRoute(path: string, repo: SnapshotRepo, tool: string) {
  app.get(path, async (req, res) => {
    try {
      const rows = holdingRepo.list();
      const today = todayStr();
      const queryDate = String(req.query.date ?? "").trim();

      // 历史回看：?date=YYYY-MM-DD
      if (SNAP_DATE_RE.test(queryDate)) {
        const snaps = repo.getByDate(queryDate);
        return res.json({
          items: rows.map((r) => {
            const p = snaps.get(r.code);
            return { code: r.code, name: r.name, data: p?.data ?? null, error: p?.error ?? null };
          }),
          date: queryDate,
          fromDb: true,
          snapshotDate: queryDate,
          isHistorical: true,
          availableDates: repo.listDates(),
          configMissing: false,
          error: null,
        });
      }

      // —— 单独刷新（?code=）：仅实时抓取一只股票，当日记录优先、其余持仓从最近日期记录补底合并落库 ——
      const singleCode = String(req.query.code ?? "").trim();
      if (singleCode) {
        const target = rows.find((r) => r.code === singleCode);
        if (!target) return res.status(404).json({ error: "持仓中不存在该证券" });
        let payload: unknown = null;
        let fetchError: string | null = null;
        let perError: string | null = null;
        let configMissing = false;
        try {
          const entries = await fetchWindToolData([{ code: target.code, name: target.name }], tool);
          const e = entries.get(target.code);
          payload = e?.data != null ? { data: e.data, error: e.error ?? "" } : null;
          // 无数据时透传 per-holding 错误（积分不足/限频等），供前端具体提示
          perError = payload ? null : e?.error ?? null;
        } catch (e: any) {
          // fetchWindToolData 仅在 Key 缺失时抛出
          configMissing = true;
          fetchError = String(e?.message ?? e);
        }
        // 有数据则合并落库；无数据不落库，维持最近日期视图并提示。
        // noData 且库中有历史时返回的就是最近日期快照视图，按实际标注 fromDb/isHistorical，前端才能显示历史提示而不误标「上次刷新」
        if (payload) mergeSingleRefresh(repo, target.code, today, payload);
        const dates = repo.listDates();
        const viewDate = payload ? today : dates[0] ?? today;
        const snaps = repo.getByDate(viewDate);
        const items = rows.map((r) => {
          const p = snaps.get(r.code);
          return { code: r.code, name: r.name, data: p?.data ?? null, error: p?.error ?? null };
        });
        return res.json({
          items,
          date: payload ? today : dates.length > 0 ? viewDate : null,
          fromDb: payload !== null || dates.length > 0,
          snapshotDate: viewDate,
          isHistorical: payload === null && viewDate !== today,
          availableDates: dates,
          configMissing,
          refreshed: { code: target.code, noData: payload === null },
          error: payload !== null ? null : fetchError ?? perError,
        });
      }

      const force = req.query.force === "1";

      // 规则 1：最近日期优先读库（页面加载的常规路径，不发起 MCP 调用）
      const dates = repo.listDates();
      if (!force && dates.length > 0) {
        const latest = dates[0];
        const snaps = repo.getByDate(latest);
        return res.json({
          items: rows.map((r) => {
            const p = snaps.get(r.code);
            return { code: r.code, name: r.name, data: p?.data ?? null, error: p?.error ?? null };
          }),
          date: latest,
          fromDb: true,
          snapshotDate: latest,
          isHistorical: latest !== today,
          availableDates: dates,
          configMissing: false,
          error: null,
        });
      }

      // 规则 2：库里无任何数据 → 实时抓取当日数据并落库
      let configMissing = false;
      let topError: string | null = null;
      try {
        const entries = await fetchWindToolData(
          rows.map((r) => ({ code: r.code, name: r.name })),
          tool
        );
        // payload 附带 per-holding 错误（空串表示无错误，可覆盖旧错误）；抓取失败仅存错误不清数据（合并写保留旧 data）
        const snapshots = rows
          .map((r) => {
            const e = entries.get(r.code);
            return { code: r.code, date: today, payload: { data: e?.data ?? null, error: e?.error ?? "" } };
          })
          .filter((s) => s.payload.data != null || s.payload.error);
        if (snapshots.length > 0) {
          repo.upsertMany(snapshots);
        }
      } catch (e: any) {
        // fetchWindToolData 仅在 Key 缺失时抛出
        configMissing = true;
        topError = String(e?.message ?? e);
      }

      const snaps = repo.getByDate(today);
      const items = rows.map((r) => {
        const p = snaps.get(r.code);
        return { code: r.code, name: r.name, data: p?.data ?? null, error: p?.error ?? null };
      });
      res.json({
        items,
        date: null,
        fromDb: false,
        snapshotDate: today,
        isHistorical: false,
        availableDates: repo.listDates(),
        configMissing,
        error: topError,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
}

windToolRoute("/api/wind-valuation", windValuationSnapshotRepo, "stock_get_company_valuation");
windToolRoute("/api/wind-updates", windUpdatesSnapshotRepo, "stock_get_company_updates");
windToolRoute("/api/wind-technical", windTechnicalSnapshotRepo, "stock_get_technical_analysis");
windToolRoute("/api/wind-profile", windProfileSnapshotRepo, "stock_get_company_profile");

// ---------- 持仓管家对话（SSE） ----------

app.post("/api/chat", async (req, res) => {
  const { sessionId = "default", message } = req.body ?? {};
  // sessionId 非字符串时 better-sqlite3 绑定会抛同步异常，async 路由不被
  // Express 4 捕获 → unhandledRejection 直接杀死进程，必须先校验
  if (typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId 必须为字符串" });
  }
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message 必填" });
  }
  const sid = sessionId.trim().slice(0, 200) || "default";

  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const history = chatRepo.history(sid);
    chatRepo.add(sid, "user", message);

  let assistantText = "";
  const toolNames: string[] = [];
  try {
    for await (const ev of runHousekeeperTurn(message, history)) {
      if (ev.type === "text" && ev.text) assistantText += ev.text + "\n";
      if (ev.type === "tool" && ev.toolName) toolNames.push(ev.toolName);
      send(ev);
      if (ev.type === "done" || ev.type === "error") break;
    }
  } catch (e: any) {
    send({ type: "error", error: String(e?.message ?? e) });
  }
  if (assistantText.trim() || toolNames.length > 0) {
    chatRepo.add(sid, "assistant", assistantText.trim(), toolNames);
  }
  res.end();
  } catch (e: any) {
    // SSE 响应头已发出时只能断流收尾；否则回 500
    if (res.headersSent) {
      res.end();
    } else {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  }
});

app.get("/api/chat/history", (req, res) => {
  const sessionId = String(req.query.sessionId ?? "default");
  res.json(chatRepo.history(sessionId, 50));
});

// 生产模式：托管前端构建产物
const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir));
app.get("*", (_req, res, next) => {
  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`[server] MyStokView API listening on http://localhost:${PORT}`);
});
