# AGENTS.md

MyStokView（我的持仓）— A股/ETF 持仓管理 Web 应用：记录持仓、结合 westock 实时行情计算市值/浮动盈亏/权重，并内置可用自然语言查询和修改持仓的「持仓管家」AI 助手（`@tencent-ai/agent-sdk`）。

## 常用命令

```bash
npm run dev        # 开发：并发启动后端(tsx watch, :3001)与前端(vite, :5173，已代理 /api → 3001)
npm run build      # 构建前端到 dist/
npm start          # 生产：tsx 运行后端并托管 dist/，端口默认 3001（.env 的 PORT 可覆盖）
npm run setup      # 环境预检（等价 bash scripts/check-prereqs.sh）
npx tsc --noEmit   # 类型检查（无独立脚本；tsconfig 为 strict + noEmit）
bash scripts/make-release.sh   # 生成发行包 release/mystokview-<version>.tar.gz
```

无 lint、无测试框架；验证改动主要靠 `npx tsc --noEmit` 加手动跑 dev。

## 架构与分层

- `server/` — Express 4 + TypeScript（tsx 直接运行，ESM）
  - `index.ts`：全部 REST 路由（`/api/holdings`、`/api/quotes`、`/api/search`、`/api/auth/status`、`/api/news(/detail)`、`/api/wind-news`、`/api/wind-consensus`、`/api/wind-risk`、`/api/wind-events`、`/api/wind-moneyflow`、`/api/wind-valuation`、`/api/wind-updates`、`/api/wind-technical`、`/api/wind-profile`、`/api/technical`、`/api/consensus`、`/api/reports(/detail)`、`/api/fund-flow`、`/api/block-margin`、`/api/chat`）+ 盈亏/权重计算 + SSE 对话端点。研究/资金类路由均支持 `?date=YYYY-MM-DD` 读本地快照（不查 westock），不带参数时实时抓取并按（代码, 快照日期）持久化（technical 按指标日期，其余按抓取当日）；生产模式托管 `../dist`。六个 Wind 路由（wind-news / wind-consensus / wind-valuation / wind-profile / wind-risk / wind-events）遵循下文「主应用数据存储规则」章节的三规则；wind-moneyflow 保持当日优先逻辑：无参数加载时若当日快照已存在则直接读库（缺失持仓才补抓）。wind-news 的历史分支带 isHistorical 标志，前端展示历史数据提示
  - `db.ts`：better-sqlite3（`data/portfolio.db`，WAL 模式），holdings / quote_cache / chat_messages 三表 + 十四张快照表（tech / news / consensus / reports / fund_flow / block_margin / wind_news / wind_consensus / wind_risk / wind_events / wind_moneyflow / wind_valuation / wind_updates / wind_technical_snapshots，均 (code, date) 主键存 JSON payload，由 `makeSnapshotRepo` 工厂统一生成仓库；合并写——新 payload 的 null/空数组字段保留旧值，限流导致的残缺抓取不会覆盖完整快照；wind_risk 与 wind_events 传了自定义 merge，tables 按 category 合并累积）；空库自动写入 7 条种子持仓（`SEED_HOLDINGS`）
  - `windMcp.ts`：万得 MCP 的 Node 版客户端（JSON-RPC 2.0 over HTTP POST + SSE 解析 + Bearer 鉴权，移植自根目录 wind_news_agent.py）。三个服务：金融文档（`WIND_MCP_ENDPOINT`，get_financial_news / get_company_announcements）、股票研究（`WIND_STOCK_RESEARCH_ENDPOINT`，15 个工具：一致预期/资金面/估值/公司动态/技术分析/公司画像/财务分析/估值对比/行业研究/市场叙事/选股筛选等，通用抓取入口 `fetchWindToolData(holdings, tool)` + `windToolRoute` 路由工厂，新增页面只需注册一行）、股票数据（`WIND_STOCK_DATA_ENDPOINT`，get_risk_metrics 风险指标与 get_stock_events 公司事件——两者参数均为自然语言 question，响应是 columns/rows 动态表格，解析抽公共 `parseNLTable`/`callNLTable`，部分问法可能返回「没找到数据」需静默跳过，事件/风险按分类分次问再合并）；Key 读取顺序 环境变量 WIND_API_KEY > ~/.wind-aifinmarket/config；westock 代码转 Wind 代码用 `toWindCode`（sh688111 → 688111.SH）。全局限流：`server/rateLimit.ts` 的 RateLimiter（滑动窗口），windMcp.ts 的 `WindMCPClient.limiter`（2 QPS）与 market.ts 的 `westockLimiter`（50 次/分钟）分别约束两条调用链路，限流错误已基本消除，仍以纯文本错误兜底透传 per-holding error；技术指标缺失列（如新上市股的 MA_250）解析为 null 而非 NaN——JSON.stringify 会把 NaN 变成 null，前端格式化函数需判空
  - `market.ts`：`execFile("westock", ...)` 调 kline/technical/chip/consensus/rating/score/report/fund 系（flow/margin/north-holding/short/south-holding/block）等子命令取行情与研究数据、news list 取每只持仓的最新新闻，解析其 markdown 表格输出；批量查不全时按并发 4 逐个补查。westock 调用受 `westockLimiter` 全局限流（50 次/分钟）；历史遗留的限频文案（「服务限频」「LOCAL_RATE_LIMITED 请求过于频繁」等）仍作防御性识别。技术指标缺失列（如新上市股的 MA_250）解析为 null 而非 NaN——JSON.stringify 会把 NaN 变成 null，前端格式化函数需判空
  - `agent.ts`：Agent SDK `query()` 封装、系统提示词、SSE 事件流
- `src/` — React 18 + TDesign 前端
  - `pages/`：HoldingsPage（持仓页，每 60 秒静默自刷新，可开关）、NewsPage（我的新闻 + 弹窗看详情）、WindNewsPage（Wind 新闻，万得 MCP 财经新闻 + 官方公告）、TechnicalPage（技术分析，technical 指标 + chip 筹码 + 汇总评级）、ConsensusPage（一致预期，westock consensus/rating/score + 汇总评级）、WindConsensusPage（Wind一致预期，万得 MCP stock_get_company_earnings_estimate：一致评级/目标价/盈利预测表/评级明细）、WindRiskPage（Wind风险指标，万得 MCP get_risk_metrics 三类动态表格）、WindEventsPage（Wind事件，万得 MCP get_stock_events 四类事件表，宽表横向滚动）、WindMoneyFlowPage（Wind资金流向，万得 MCP stock_get_money_flow_analysis：主力资金/融资融券/陆股通/成交活跃度等分块）、WindValuationPage（Wind估值，专用紧凑布局：当前估值 stat 卡 + 趋势/相对估值转置表 + 可比公司两栏网格，经 renderData 钩子自定义渲染）/WindUpdatesPage（Wind公司动态，新闻式分组展现 + 点击条目弹窗看全文，经 WindToolPage 的 renderData 钩子自定义渲染）、WindProfilePage（Wind公司画像，四类折叠面板 + JsonView）/WindTechnicalPage（Wind技术分析，专用紧凑布局：区间涨跌幅/关键价位 stat 卡 + 三大组转置表两列排布，经 renderData 钩子自定义渲染），三个页面共用 components/WindToolPage 骨架（renderData 钩子可自定义行内渲染，默认 components/JsonView 递归渲染；弹窗为页面自身的 state，不经 WindToolPage），路由由 windToolRoute 工厂注册（快照 payload 原样存 { data }）、ReportsPage（我的研报 + 弹窗看正文）、FundFlowPage（资金流向：fund flow + margin/north-holding（A 股）+ short/south-holding（港股），共用 components/MarginSection）、BlockTradePage（大宗交易，fund block 近 7 日明细 + fund margin 两融）、ChatPage（AI 管家，消费 SSE）。除持仓页和管家外，各页面实时结果均持久化到各自的快照表，并支持 DatePicker 按日期回看 SQLite 历史快照（共享 components/snapshot 的选择器与日期标签）
  - `components/`：OverviewCards / HoldingsTable / AddHoldingDialog / AuthBanner / MarginSection（融资融券数据行，资金流向与大宗交易页共用）/ snapshot（SnapshotDatePicker + SnapshotDateTags，各页面共用的历史快照日期选择 UI）
  - `types.ts` 与后端 API payload 字段一一对应
- 前端一律请求相对路径 `/api/*`（dev 走 Vite 代理，prod 同源由 Express 托管），不要在前端硬编码 `localhost:3001`

## 主应用数据存储规则

以下 6 个 Wind MCP 页面统一遵循「最近日期优先」三规则（快照表均为 (code, date) 主键、写入走合并写）：

**适用功能与路由**：Wind一致预期（/api/wind-consensus）、Wind估值（/api/wind-valuation）、Wind公司画像（/api/wind-profile）、Wind风险指标（/api/wind-risk）、Wind事件（/api/wind-events）、Wind新闻（/api/wind-news）

1. **点击功能按钮 → 最近日期优先读库**：页面加载（无参数请求）时读取库里最近日期的快照直接展示——即使那是昨天/上周的数据也照常展示，副标题橙色提示「正在展示 {日期} 的历史数据，如需最新数据请点击『刷新XX』」（XX 为各页面刷新按钮文案：刷新资讯/刷新预期/刷新估值/刷新画像/刷新指标/刷新事件），全程不发起 MCP 调用
2. **库里无任何数据 → 实时抓取当日并存库**（isHistorical: false 正常展示）
3. **刷新按钮 → ?force=1 强制实时抓当日**：全量重抓并合并更新当日快照（无当日记录则新建），同时清空日期选择回到当日视图

注意：七个 Wind 快照路由（wind-news / wind-consensus / wind-risk / wind-events + windToolRoute 工厂四路由）均支持 `?code=` 单股票单独刷新——仅实时抓取这一只，有数据则 `mergeSingleRefresh` 合并落库（当日记录优先、其余持仓从最近日期记录补底），无数据不落库并返回 refreshed.noData=true（前端提示「未查询到该股票的当日数据」）；noData 响应本身即最近日期快照视图，按实际标注 fromDb/isHistorical，前端据此显示历史提示而不误标「上次刷新」；configMissing 响应不含列表数据，前端保留当前视图仅提示；抓取成功后前端自动清除日期选择切到当日合并视图；响应含 refreshed 字段（其余分支不返回该字段）；历史数据提示中的「刷新XX」对应各页面刷新按钮文案。Wind资金流向 等当日优先页面不适用本规则。

## 关键约束与坑

- **ESM + `.js` 后缀**：`"type": "module"`；server 内相对导入必须写 `./db.js` 这种带 `.js` 的形式（即便源文件是 `.ts`）
- **westock 不是 npm 依赖**：宿主机外部 CLI，需单独安装并扫码授权。未授权时其输出含 `AUTH_REQUIRED:<url>`，应用回退 quote_cache 本地缓存（`stale: true`）——绝不能把缓存行情当实时数据展示或告知用户
- **证券代码格式**：westock 格式（`sh600519` / `sz300253` / `hk00700`），数据库与 API 全程使用该格式
- **API 字段 snake_case**：`cost_price`、`market_value`、`float_pnl` 等贯穿前后端，`src/types.ts` 需同步维护
- **CodeBuddy CLI 端口冲突**：CLI 默认监听 58145，与 WorkBuddy 桌面端冲突；`agent.ts` 每次对话动态分配空闲端口，勿改成固定端口
- **AI 管家权限边界**：以 `bypassPermissions` 运行，但工具仅限 Bash + Read，通过 curl 调自身 API（`http://localhost:3001`）形成闭环；改系统提示词时保持这一边界
- **涨红跌绿**（A股惯例）：`globals.css` 的 `.up/.down/.flat` 配合 `utils.ts` 的 `pnlClass()`；金额保留两位小数（`round2` / `fmtMoney`），盈亏带正负号与百分比
- **`/api/*` 无鉴权**：仅面向本地/内网可信环境，勿在公网暴露
- **`data/portfolio.db` 含个人持仓数据**：已被 `.gitignore` 忽略，绝不提交，也不要把其中真实数据写进日志或回复

## 语言与风格

- 全项目简体中文：UI 文案、注释、错误信息、AI 回复均是
- 注释密度低，只在解释非显而易见的约束时写（如端口冲突、授权回退）

## 改动前先读

- `README.md`：westock 安装与扫码授权、CodeBuddy 登录（`npx codebuddy login` 或 `.env` 配 `CODEBUDDY_API_KEY`）、发行版部署与 FAQ
- `.env.example`：`PORT`、`CODEBUDDY_API_KEY`、`WIND_API_KEY`（Wind 新闻用，缺失时回退 ~/.wind-aifinmarket/config）、`WIND_MCP_ENDPOINT`（可选）
