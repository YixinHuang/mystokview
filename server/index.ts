import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { db, seedIfEmpty, holdingRepo, chatRepo, type HoldingRow } from "./db.js";
import { fetchQuotes, checkAuth, isWestockInstalled, searchCode, type Quote } from "./market.js";
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
      quantity: Number(quantity),
      cost_price: Number(cost_price),
      open_date: open_date ? String(open_date) : undefined,
    });
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.patch("/api/holdings/:code", (req, res) => {
  const { quantity, cost_price, realized_pnl } = req.body ?? {};
  const before = holdingRepo.getByCode(req.params.code);
  if (!before) return res.status(404).json({ error: "持仓不存在" });
  const patch: Record<string, number> = {};
  if (quantity !== undefined) patch.quantity = Number(quantity);
  if (cost_price !== undefined) patch.cost_price = Number(cost_price);
  if (realized_pnl !== undefined) patch.realized_pnl = Number(realized_pnl);
  const after = holdingRepo.update(req.params.code, patch);
  res.json({ before, after });
});

app.delete("/api/holdings/:code", (req, res) => {
  const before = holdingRepo.getByCode(req.params.code);
  if (!before) return res.status(404).json({ error: "持仓不存在" });
  holdingRepo.remove(req.params.code);
  res.json({ success: true, deleted: before });
});

// ---------- 行情 API ----------

app.get("/api/quotes", async (req, res) => {
  const codes = String(req.query.codes ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const market = await fetchQuotes(codes);
  res.json({
    quotes: Object.fromEntries(market.quotes),
    stale: market.stale,
    authRequired: market.authRequired,
    authUrl: market.authUrl,
    error: market.error,
  });
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

// ---------- 持仓管家对话（SSE） ----------

app.post("/api/chat", async (req, res) => {
  const { sessionId = "default", message } = req.body ?? {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message 必填" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const history = chatRepo.history(sessionId);
  chatRepo.add(sessionId, "user", message);

  let assistantText = "";
  try {
    for await (const ev of runHousekeeperTurn(message, history)) {
      if (ev.type === "text" && ev.text) assistantText += ev.text + "\n";
      send(ev);
      if (ev.type === "done" || ev.type === "error") break;
    }
  } catch (e: any) {
    send({ type: "error", error: String(e?.message ?? e) });
  }
  if (assistantText.trim()) chatRepo.add(sessionId, "assistant", assistantText.trim());
  res.end();
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
