# MyStokView 全项目 Code Review 报告

- **审查日期**：2026-11-22
- **审查范围**：`server/`（index.ts / db.ts / market.ts / windMcp.ts / rateLimit.ts / agent.ts）、`src/`（17 个页面 + 8 个组件 + types/utils）、`scripts/`（3 个 shell 脚本）、`install.sh`、配置文件（package.json / tsconfig / vite.config / index.html / .env.example / .gitignore）、`wind_news_agent.py`（参考脚本）、仓库卫生
- **审查方法**：三路并行深读（后端 / 前端 / 脚本与配置），关键发现逐条对照源码人工核验；所有 P0/P1 与绝大多数 P2 均已人工确认
- **类型检查基线**：`npx tsc --noEmit` 通过

## 一、总体结论

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 | 2 | 敏感数据泄漏链、畸形请求可杀死进程 |
| P1 | 3 | PORT 约定未贯彻、前端 loading 卡死、发行包结构与说明不符 |
| P2 | 13 | 边界场景与 UX 缺陷（集中在 ?code=/refreshOne 链路与脚本） |
| P3 | 24 | 一致性/健壮性小问题 |

**最优先处理三件事**：① 处理 `data.tar` 泄漏链（见 P0-1）；② `/api/chat` 入参校验（P0-2）；③ 提交全部未跟踪的 Wind 功能源码（P2-13）。

---

## 二、任务中断遗留专项检查（重点）

针对「多轮中断式修改是否留下逻辑错误」的专项结论：

**结构性破损：无。**
- `npx tsc --noEmit` 通过——无重复声明、无变量删除后引用错位、无类型不匹配
- 逐路由核对：无 A 路由混用 B 仓库/字段；每个 `?code=` 分支显式 return，`?date=`/`force`/`code` 互不穿透（code 优先）
- `mergeSingleRefresh` 四处调用（consensus/risk/events/工厂）齐全且逻辑正确（先构造 upserts、读落库前状态、target 合并写、其余持仓当日缺失才从最近日期复制）

**但多轮改造留下了 5 个行为级问题**（集中在本次新增的 `?code=` / `refreshOne` 链路）：

| 级别 | 问题 |
|---|---|
| P1 | refresh 与 refreshOne 共用 seqRef 但各自只重置自己的 loading → 交叉触发时对方按钮永久卡死（见 P1-2） |
| P2 | configMissing 时 refreshOne 仍 setData → 整个列表被清成「暂无持仓」（见 P2-5） |
| P2 | noData 响应（实为最近日期历史视图）被前端当实时数据处理，日期标识全部失效（见 P2-6） |
| P3 | wind-news `?code=` 成功分支手写了一段与 `mergeSingleRefresh` 完全相同的合并逻辑（index.ts:679-692），属改造前遗留的重复代码 |
| P3 | `?code=` 成功响应字段语义不一致：wind-news 返回 `date: null, fromDb: false`，其余路由返回 `date: today, fromDb: true`（index.ts:700-701 vs 844-846） |

---

## 三、P0 发现

### P0-1 `data.tar` 个人持仓数据库泄漏链
- **位置**：项目根 `data.tar`（4.3MB）、`.gitignore`、`scripts/make-release.sh:18-22`、`install.sh:67-69`
- **问题**：`tar -tf` 确认 data.tar 内含 `data/portfolio.db` + `-wal` + `-shm`（个人持仓完整备份）。`.gitignore` 只有 `data/` 规则不匹配 `data.tar`（`git check-ignore` 无输出），一次 `git add .` 即提交个人数据；`make-release.sh` 的 `--exclude=data` 只匹配路径分量 `data`，**发行包会把 data.tar 原样打进 tar.gz**；`install.sh` 的 rsync EXCLUDES 同样不含 data.tar，安装时把个人数据库拷到目标服务器。三处构成完整泄漏链。
- **建议**：`.gitignore` 增加 `data.tar`（或 `*.tar`）；`make-release.sh` 追加 `--exclude=data.tar`；把 data.tar 移出仓库目录或删除（确认无需保留后）。

### P0-2 `/api/chat` 畸形 sessionId 可杀死进程
- **位置**：`server/index.ts:1429-1443`
- **证据**：`const { sessionId = "default", message } = req.body ?? {};` 只校验了 message；`{"sessionId":{"x":1}}` 会让 better-sqlite3 绑定对象抛同步 TypeError——此时 `res.writeHead` 已发出、handler 是 async（Express 4 不捕获 async 异常）→ unhandledRejection → Node 22 进程退出。
- **建议**：`typeof sessionId === "string"` 校验否则 400，并给该路由整体补 try/catch。注：应用仅面向本地可信环境，攻击面有限，但修复成本极低。

---

## 四、P1 发现

### P1-1 PORT 可覆盖约定未贯彻（两处硬编码 3001）
- `server/agent.ts:4`：`const API_BASE = "http://localhost:3001"` 注入管家系统提示词——`.env` 设 `PORT=3002` 后后端在 3002 监听，管家所有 curl 调用 connection refused。
- `vite.config.ts:11`：代理目标硬编码 `http://localhost:3001`——改 PORT 后 dev 代理静默失效。
- **建议**：两处改为按 `process.env.PORT ?? 3001` 动态拼接。

### P1-2 refresh / refreshOne 共用 seqRef 导致 loading 互斥卡死
- **位置**：`WindNewsPage.tsx:131,164`（同构：WindConsensusPage:193,224 / WindRiskPage:114,147 / WindEventsPage:118,151 / WindToolPage:100,133）
- **问题**：refresh 的 finally 条件 `seq === seqRef.current`，refreshOne 先 `++seqRef`。场景 A：日期回看的 refresh 在途时点「单独刷新」→ refresh finally 因 seq 失配跳过 → 顶部刷新按钮永久 loading；场景 B 反向同理，行内按钮永久 loading。只能刷新页面恢复。
- **建议**：finally 只判 `mounted.current`（seq 失配说明有更新请求接管，由后者收尾）；或 refreshOne 末尾同时 `setLoading(false)`、refresh 末尾同时清 singleLoading。

### P1-3 make-release.sh 归档结构与使用说明不符
- **位置**：`scripts/make-release.sh:22,28`
- **问题**：`tar -czf "$PKG" .` 归档内无顶层目录，而使用说明第 3 步要求 `cd mystokview-<version>`——照做必失败。
- **建议**：先在临时目录组装 `mystokview-<version>/` 再打包（或修改说明）。

---

## 五、P2 发现

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| P2-1 | server/index.ts:664-676, 695-707 | wind-news 两个 `?code=` 分支响应缺 `isHistorical`（类型必填）；noData 分支返回过去日期的 snapshotDate 却无历史标志，前端不显示「正在展示 X 的历史数据」 | 两分支补 `isHistorical`（noData 时 `latest !== today`，成功时 false） |
| P2-2 | server/index.ts:828-829, 969-970, 1100-1101, 1327-1328 | 各 `?code=` 分支只判数据非空，`entries.get(code).error`（积分不足/限频/网络错误）从不读取不透传 → MCP 报错时响应 `error: null` + noData:true，前端只能笼统提示「未查询到当日数据」；全刷路径落库 payload 也不含 error，前端 `entry.error` 渲染位恒空 | payload 为空时把 `e.error` 透传到响应 error，并考虑一并落库 |
| P2-3 | server/market.ts:298-302 + src/pages/NewsPage.tsx:188 | 新闻正文 XSS 面：`sanitizeNewsHtml` 只删非白名单标签，白名单标签（p/strong/b/em/br）上的属性原样保留（`<p onmouseover=...>` 存活），NewsPage 用 `dangerouslySetInnerHTML` 渲染 westock 从外部网页抓的正文 | 白名单标签同时剥离全部属性；或前端降级为纯文本渲染（ReportsPage 即纯文本） |
| P2-4 | server/index.ts:200-211 | `/api/quotes` 是唯一无 try/catch 的 async 路由；quoteCacheRepo（better-sqlite3）抛错即 unhandledRejection → 进程退出 | 补 try/catch 返回 500 |
| P2-5 | WindNewsPage.tsx:143-149（同构 4 页）+ server/index.ts:643-651 | configMissing 响应 `items: []` 且 fromDb:false，refreshOne 无条件 `setData(j)` 把整个列表清成「暂无持仓」，还误更新「上次刷新」时间 | configMissing 分支只弹提示，不 setData |
| P2-6 | WindNewsPage.tsx:150-157 等 5 页 + server/index.ts:664-676, 844-854 | noData 路径：响应实为最近日期历史视图，前端却显示「上次刷新 {此刻}」，且橙红历史提示/Card 日期（依赖 fromDb=true）全部失效 → 用户把旧数据当当日数据 | 前端 noData 时改用 `isHistorical && snapshotDate` 判定展示历史提示；或后端 noData 响应置 fromDb:true 并带 date |
| P2-7 | TechnicalPage.tsx:89-108（同构：Consensus/News/Reports/FundFlow/BlockTrade 页） | refresh 无 seqRef 守卫：首屏慢实时请求（30s+）会覆盖用户随后选择的历史快照视图 | 照 WindMoneyFlowPage 补 seqRef |
| P2-8 | WindValuationPage.tsx:145-152 | config 未 useMemo（其余三个工具页都 memo 了）→ App 任意菜单切换（页面常驻仅 display 切换）都重建 config → refresh 重建 → useEffect 重跑 → 每次切菜单重复请求 /api/wind-valuation；库为空时反复触发慢 MCP 全量抓取 | 同样用 useMemo 包裹 |
| P2-9 | src/components/HoldingsTable.tsx:50-54 | EditableNumber 用 `Number(text)` 校验，`Number("") === 0`：空输入回车把持仓数量/成本价静默存成 0；负数也未拦截 | 拒绝空串并校验范围（quantity>0、cost_price>=0） |
| P2-10 | install.sh:67-69 | EXCLUDES 变量内含字面单引号（`--exclude='*.log'`），`rsync -a $EXCLUDES` 无引号展开时引号不被剥离，实际模式为 `'*.log'`（带引号）永不匹配；且排除表也不含 data.tar | 变量内去掉引号或改用数组；补 data.tar |
| P2-11 | scripts/backup.sh:22-25 | 直接 tar 正在运行中的 SQLite 三件套（db+wal+shm），拷贝期间有写入可能得到不一致快照 | 改用 `sqlite3 data/portfolio.db ".backup ..."` 或先停服务 |
| P2-12 | .gitignore / git 索引 | `.DS_Store` 与 `.workbuddy/memory/2026-10-24.md` 已被 git 跟踪（AI 个人记忆文件入库）；`src/.DS_Store` 未跟踪也未忽略 | `.gitignore` 加 `.DS_Store`、`.workbuddy/`；`git rm --cached` 移除 |
| P2-13 | git 未跟踪文件 | 整套 Wind 功能源码未提交：server/windMcp.ts、server/rateLimit.ts、12 个 Wind*Page.tsx、WindToolPage/JsonView/MarginSection/snapshot、scripts/backup.sh、AGENTS.md、wind_news_agent.py——误删即丢失 | 尽快提交；`wind-mcp-doc/`（含 44KB zip）不入库则加入 .gitignore |

---

## 六、P3 发现

### 后端（12 条）

| 位置 | 问题 |
|---|---|
| server/windMcp.ts:103-125 | SSE 解析取「最后一个可解析事件」不校验是否本请求的 JSON-RPC 响应：响应后若还有通知事件，`payload.result` 为 undefined → 误导性「无法解析的内容」错误。建议只接受带 id/result/error 的事件 |
| server/index.ts:653-654 | wind-news `?code=` 分支缺全刷路径的 `listTools()` 连接探测（745-747 行有）→ MCP 连不上时与「真没数据」无法区分 |
| server/index.ts:679-692 | `?code=` 成功分支手写与 `mergeSingleRefresh` 相同的合并逻辑（改造遗留重复代码），建议改调助手 |
| server/index.ts:700-701 vs 844-854 | `?code=` 成功响应语义不一致（wind-news `date:null,fromDb:false` vs 其余 `date:today,fromDb:true`），导致各页单刷后「上次刷新」行为不统一 |
| server/market.ts:1452-1454, 1352, 1369-1370 | `num()`（缺列返回 NaN）结果直接入 BlockTrade.price/discount、NorthHolding.hold_shares、Short.short_amount，靠 `JSON.stringify(NaN)→null` 兜底，与 TS 类型 number 不符，前端直接算术得 NaN。建议统一 numOrNull |
| server/market.ts:763-765 | fetchTechnical 中 chip 批量 AUTH_REQUIRED 时直接 return 空 entries，丢弃已抓到的全部 techRows |
| server/index.ts:745-746 | `listTools()` 返回体缺 tools 时 `(undefined).map` 抛 TypeError，错误文案误导排查。建议 `?? []` |
| server/index.ts:147-172, 183-186 | POST/PATCH 持仓对 `Number()` 结果不做有限性校验：`quantity:"abc"` → NaN → 绑 NULL → NOT NULL 抛错；无正数校验 |
| server/index.ts:1221-1231 | wind-moneyflow 对永远抓不到数据的持仓（ETF 等）当日永远「缺失」→ 每次页面加载都重新补抓不收敛。建议空标记/负缓存 |
| server/rateLimit.ts:12-22 | 满窗时固定 25ms 忙轮询，等待时长本可精确计算（sleep 到最早 stamp 滑出窗口） |
| server/market.ts:26 | `klineFallback` 是死字段：主链路已改 kline 直查，恒为 false。建议删除 |
| server/windMcp.ts:40-49 | `loadWindApiKey` 的 fs 异常（权限/竞态删除）沿 fetch 抛出，被各路由 catch 误标 configMissing。建议函数内 try/catch 返回空串 |

### 前端（6 条）

| 位置 | 问题 |
|---|---|
| src/types.ts:232,262,287,312,331 | `refreshed` 声明为必填但后端非 `?code=` 响应不含该字段（实际 undefined）；WindNewsPayload 的 `isHistorical` 在 wind-news noData/configMissing 响应中同样缺失。建议改可选属性 `refreshed?: …; isHistorical?: boolean` |
| src/pages/ChatPage.tsx:54-89 | SSE 消费无 AbortController/超时：后端挂起时 streaming 永久 true 输入框锁死；:22-28 历史记录不恢复 tools 字段（重进后工具调用标签丢失） |
| src/pages/AddHoldingDialog.tsx:26-44, 23,31 | 防抖搜索无响应序号守卫（慢旧请求覆盖新关键词）；costPrice 允许 0；debounce 定时器卸载时未 clearTimeout |
| src/pages/TechnicalPage.tsx:96 | 把顶层 j.error 当致命错误 throw，与 ConsensusPage「警告后仍渲染部分数据」语义不一致，部分持仓失败时丢弃整个可用响应 |
| src/components/JsonView.tsx:80-107 | ObjArrayTable 无行数上限、JsonNode 递归无深度上限：超大对象数组（如十大流通股东）一次性渲染数千 DOM。建议超阈值截断提示 |
| src/pages/WindConsensusPage.tsx:72-74 | 目标价调整判断 `Number(prevTarget) !== Number(target)`：任一为非数字字符串时 NaN!==NaN 恒真，可能对「--」误标「上调」。建议先 Number.isFinite |

### 脚本与配置（6 条）

| 位置 | 问题 |
|---|---|
| package.json | 生产 `npm start` 用 tsx 但 tsx 在 devDependencies，`npm install --omit=dev` 部署会启动失败；无 engines 字段约束 Node>=18 |
| .env.example | 缺 server 实际读取的 `WIND_STOCK_RESEARCH_ENDPOINT`、`WIND_STOCK_DATA_ENDPOINT` 两个条目 |
| scripts/check-prereqs.sh:31,71 | 无 `cd "$(dirname "$0")/.."`：从非项目根运行会误报（另两个脚本都有） |
| scripts/check-prereqs.sh:21 | MAJOR 非数字时 `[ "$MAJOR" -lt 18 ] 2>/dev/null` 测试失败被吞，走 else 误报「版本满足要求」 |
| vite.config.ts:8 | `host: true` 使 dev server 监听 0.0.0.0，而 `/api/*` 无鉴权，dev 同样暴露公网 |
| wind_news_agent.py:44 | `line.split("=", 1)[1]`：config 出现无 `=` 的行会 IndexError（全文件无硬编码密钥/敏感日志，可放心保留） |

---

## 七、已检查无问题项（覆盖面）

- **本次批量编辑结构核验**：六个 Wind 路由的 repo/payload 字段逐一核对无混用；全部 `?code=` 分支的落库条件、noData 判定、404 分支一致；`fetchWindConsensus/Risk/Events/ToolData/MoneyFlow` 确认仅 Key 缺失时抛出（路由 catch-as-configMissing 假设成立）；限流器 check+push 无 await（单线程原子无超发），WindMCP 静态共享 2QPS / westock 50/min 符合约定
- **db.ts**：合并写 null/空数组保留旧值、wind_risk/wind_events 按 category 合并、事务包裹、损坏行容错
- **westock 授权回退**：AUTH_REQUIRED 各路径均识别，quote_cache `stale:true` 不冒充实时的约定未被破坏
- **约定一致性**：ESM `.js` 后缀、westock 代码格式、API snake_case、涨红跌绿 pnlClass、金额两位小数、相对路径 `/api/*`（前端无硬编码 3001）全部贯彻
- **前端健壮性**：格式化函数对 null 指标（含 MA_250）判空完备；各页 fetch 均有 mounted 守卫；WindMoneyFlowPage 有完整 seq 守卫；ChatPage SSE 分帧与后端格式匹配；snapshot.tsx 边界（非法值/空列表/反选）处理正确；HoldingsPage 60s 轮询有 clearInterval；AuthBanner 区分缓存与实时
- **脚本**：make-release.sh / backup.sh 的 `set -euo pipefail` 与路径解析健壮；check-prereqs 的 westock 授权降级链路合理；tsconfig strict+bundler 配置正常；index.html 正确；.gitignore 已覆盖 node_modules/dist/data/release/.env/*.log

---

## 八、修复优先级建议

1. **立即**（数据安全）：`.gitignore` 加 `data.tar`、make-release.sh/install.sh 补排除、移出或删除 data.tar → 消除 P0-1 泄漏链
2. **立即**（稳定性）：`/api/chat` sessionId 校验 + try/catch（P0-2，约 5 行改动）
3. **本周**（功能正确性）：refreshOne 三连修复——configMissing 不 setData（P2-5）、noData 历史提示（P2-6）、loading finally 解耦（P1-2，5 个文件同构一次改完）
4. **本周**（约定一致性）：agent.ts + vite.config.ts 按 PORT 动态拼接（P1-1）；提交全部未跟踪源码（P2-13）
5. **择期**：wind-news `?code=` 改用 mergeSingleRefresh 并统一响应语义（P3）、XSS 消毒加固（P2-3）、发行包结构调整（P1-3）
