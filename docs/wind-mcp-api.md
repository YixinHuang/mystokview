# Wind MCP 通道接口文档

本文档整理 MyStokView 通过万得（Wind）MCP 通道调用的全部服务接口，包括：接口对应的应用主功能、服务地址、输入参数与输出结果的 字段级 说明。

代码位置：客户端实现 `server/windMcp.ts`，应用侧 REST 路由 `server/index.ts`，前端页面 `src/pages/Wind*Page.tsx`。

---

## 1. 通道概述

### 1.1 协议与鉴权

- 协议：JSON-RPC 2.0 over HTTP POST（`method: "tools/call"` / `"tools/list"`）
- 响应：`text/event-stream`（SSE，事件按空行分隔、多行 `data:` 拼接）或普通 JSON，由客户端自动判别
- 鉴权：`Authorization: Bearer <WIND_API_KEY>`
- Key 读取顺序：环境变量 `WIND_API_KEY` > `~/.wind-aifinmarket/config` 中的 `WIND_API_KEY=` 行
- 超时：单请求 60s（`AbortSignal.timeout(60_000)`）
- 全局限流：所有 Wind MCP 调用共享一个 2 QPS 滑动窗口限流器（`WindMCPClient.limiter`），避免触发套餐「每秒请求频率超过限制」
- 工具返回约定：`tools/call` 的 `result.content[0].text` 是 JSON 字符串，客户端解析为对象；若返回纯文本错误（积分不足、限频、「没找到数据」等）则原文抛出，由调用方按 per-holding error 透传

### 1.2 三个服务端点

| 服务 | 环境变量 | 默认地址 |
|---|---|---|
| 金融文档 | `WIND_MCP_ENDPOINT` | `https://mcp.wind.com.cn/vserver_financial_docs/mcp/` |
| 股票研究 | `WIND_STOCK_RESEARCH_ENDPOINT` | `https://mcp.wind.com.cn/vserver_stock_research/mcp/` |
| 股票数据 | `WIND_STOCK_DATA_ENDPOINT` | `https://mcp.wind.com.cn/vserver_stock_data/mcp/` |

### 1.3 证券代码转换（toWindCode）

应用内部统一使用 westock 格式代码，调 Wind 工具前转换为 Wind 格式：

| 输入（westock） | 输出（Wind） |
|---|---|
| `sh600519` / `sz300253` / `bj831399` | `600519.SH` / `300253.SZ` / `831399.BJ` |
| `hk00700` / `hk700` | `00700.HK`（补零到 5 位） |
| 其余（如美股） | 原样透传，由服务端识别 |

### 1.4 应用侧统一 REST 包络

所有 `/api/wind-*` 路由（`server/index.ts`）对前端返回统一包络，字段如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `items` | array | 逐持仓结果数组，元素结构随路由不同（见各接口章节） |
| `date` | string \| null | 本次视图的数据日期；实时抓取成功时为 `null`，读库时为快照日期 |
| `fromDb` | boolean | 数据是否来自本地 SQLite 快照（而非本次实时抓取） |
| `snapshotDate` | string | 实际展示的快照日期 |
| `isHistorical` | boolean | 展示的是否为历史日期数据（true 时前端显示橙色历史提示）。注：wind-moneyflow 无此字段 |
| `availableDates` | string[] | 该路由快照表已有的全部日期（降序），供前端日期选择器 |
| `configMissing` | boolean | 是否因缺少 WIND_API_KEY 而未发起抓取 |
| `refreshed` | `{code, noData}` | 仅「单股票单独刷新」（`?code=`）响应携带；`noData=true` 表示该股当日无数据 |
| `error` | string \| null | 顶层错误（Key 缺失、MCP 连接失败等）；per-holding 错误在 item 内 |

通用查询参数（所有 wind 路由支持）：

| 参数 | 说明 |
|---|---|
| `?date=YYYY-MM-DD` | 读指定日期的历史快照（不发起 MCP 调用） |
| `?code=sh600519` | 仅实时抓取这一只持仓（单独刷新），合并落库 |
| `?force=1` | 强制全量实时抓取当日数据并合并更新当日快照 |

数据存储：各路由结果按 `(code, date)` 主键存入对应快照表（`data/portfolio.db`），合并写（新 payload 的 null/空字段保留旧值）。

---

## 2. 工具与功能对照总表

| # | MCP 工具 | 服务 | 应用主功能 | 应用路由 | 前端页面 | 调用参数 | 频次 |
|---|---|---|---|---|---|---|---|
| 1 | `get_financial_news` | 金融文档 | Wind 新闻（财经新闻/市场评论） | `/api/wind-news` | WindNewsPage | `{query: 股票名称, top_k: 5}` | 1 次/持仓 |
| 2 | `get_company_announcements` | 金融文档 | Wind 新闻（官方公告） | `/api/wind-news` | WindNewsPage | `{query: 股票名称, top_k: 3}` | 1 次/持仓 |
| 3 | `stock_get_company_earnings_estimate` | 股票研究 | Wind 一致预期 | `/api/wind-consensus` | WindConsensusPage | `{windCode}` | 1 次/持仓 |
| 4 | `get_risk_metrics` | 股票数据 | Wind 风险指标 | `/api/wind-risk` | WindRiskPage | `{question: 自然语言}` | 3 次/持仓（按分类） |
| 5 | `get_stock_events` | 股票数据 | Wind 事件 | `/api/wind-events` | WindEventsPage | `{question: 自然语言}` | 4 次/持仓（按分类） |
| 6 | `stock_get_money_flow_analysis` | 股票研究 | Wind 资金流向 | `/api/wind-moneyflow` | WindMoneyFlowPage | `{windCode}` | 1 次/持仓 |
| 7 | `stock_get_company_valuation` | 股票研究 | Wind 估值 | `/api/wind-valuation` | WindValuationPage | `{windCode}` | 1 次/持仓 |
| 8 | `stock_get_company_updates` | 股票研究 | Wind 公司动态 | `/api/wind-updates` | WindUpdatesPage | `{windCode}` | 1 次/持仓 |
| 9 | `stock_get_technical_analysis` | 股票研究 | Wind 技术分析 | `/api/wind-technical` | WindTechnicalPage | `{windCode}` | 1 次/持仓 |
| 10 | `stock_get_company_profile` | 股票研究 | Wind 公司画像 | `/api/wind-profile` | WindProfilePage | `{windCode}` | 1 次/持仓 |

并发约定：持仓间并发度默认 2；风险/事件工具在单持仓内按分类串行调用。

---

## 3. 金融文档服务接口

### 3.1 get_financial_news（财经新闻/市场评论）

- **主功能**：Wind 新闻页的「财经新闻」流；按持仓股票名称检索相关新闻。
- **服务地址**：`https://mcp.wind.com.cn/vserver_financial_docs/mcp/`
- **输入参数**：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 检索词，应用传股票名称（如「贵州茅台」） |
| `top_k` | number | 是 | 返回条数，应用默认 5 |

- **输出结果**（`data.items` 数组，应用解析为 `WindDoc[]`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 新闻标题（应用过滤空标题条目） |
| `date` | string | 发布日期 |
| `content` | string | 正文全文（前端弹窗展示） |
| `url` | string | 原文链接 |
| `doc_type` | string | 文档类型 |

- **应用侧 items 元素**：`{code, name, news: WindDoc[], announcements: WindDoc[], error?}`

### 3.2 get_company_announcements（上市公司官方公告）

- **主功能**：Wind 新闻页的「官方公告」流。
- **服务地址**：同 3.1（金融文档服务）
- **输入参数**：`{query: 股票名称, top_k: 3}`（默认 3 条）
- **输出结果**：同 3.1（`WindDoc[]`，`doc_type` 标识公告类型）

---

## 4. 股票数据服务接口（自然语言动态表格）

这两个工具参数均为自然语言 `question`，响应是 `data.data[0]` 的 `{columns, rows}` 动态表格——列名由服务端按问法动态生成，应用解析为 `WindRiskTable / WindEventTable {category, columns: string[], rows: (string|number|null)[][]}`。部分问法可能返回纯文本「没找到数据」，客户端静默跳过该分类。

### 4.1 get_risk_metrics（风险指标）

- **主功能**：Wind 风险指标页；按三个分类各问一次再合并。
- **服务地址**：`https://mcp.wind.com.cn/vserver_stock_data/mcp/`
- **输入参数**：

| 参数 | 类型 | 说明 |
|---|---|---|
| `question` | string | `查询{股票名称}（{windCode}）过去1年的{指标}`，指标按分类：① `Beta和基准相关系数`（系统性风险）② `Jensen Alpha和夏普比率`（收益质量）③ `年化波动率、VaR、最大回撤和区间下跌天数`（波动与损失） |

- **输出结果**（每张表 `category` 为分类名）：

| 分类 | columns（动态生成，实测样例） |
|---|---|
| 系统性风险 | `Wind代码`、`证券简称`、`过去1年相对沪深300的BETA`、`过去1年相对沪深300的BETA.标的指数`、`过去1年相对沪深300的相关系数` |
| 收益质量 | `Wind代码`、`证券简称`、`过去1年JENSEN(%)`、`过去1年SHARPE` |
| 波动与损失 | `Wind代码`、`证券简称`、`过去1年下跌天数(天)`、`交易币种`、`过去1年年化波动率(%)`、`过去1年历史VAR(%)`、`过去1年最大回撤(%)` |

`rows` 为与 `columns` 等长的值数组（当前每类通常 1 行，即该持仓自身）。

### 4.2 get_stock_events（公司事件）

- **主功能**：Wind 事件页；按四个分类各问一次再合并（宽表横向滚动展示）。
- **服务地址**：同 4.1（股票数据服务）
- **输入参数**：

| 参数 | 类型 | 说明 |
|---|---|---|
| `question` | string | `查询{股票名称}（{windCode}）近1年的{指标}`，指标按分类：① `配股、增发与并购重组事件`（再融资与并购）② `分红派息事件`（分红派息）③ `限售解禁与大股东增减持事件`（股本与股东）④ `违规处罚与司法诉讼事件`（治理与监管） |

- **输出结果**：`{category, columns, rows}` 动态宽表。实测样例（分红派息类，18 列）：
  `Wind代码`、`证券简称`、`近1年内地股票分红税后每股派息(人民币元)`、`内地股票分红红股上市日`、`近1年内地股票分红转增比例`、`近1年内地股票分红税前每股派息(人民币元)`、`近1年内地股票分红股息率`、`近1年内地股票分红实施进度`、`近1年内地股票分红基准股本(万股)`、`内地股票分红实施公告日`、`内地股票分红除权除息日`、`内地股票分红股本基准日`、`内地股票分红派息日`、`近1年内地股票分红对象`、`首发上市日期`、`内地股票分红报告期`、`近1年内地股票分红送股比例`、`近1年内地股票分红方案说明`。
  股本与股东类样例列：`证券简称`、`报告期`、`增减持股东姓名`、`证监会行业名称`、`Wind中国行业名称`、`Wind代码`、`近一年增减持股东名称`、`近一年增减持数量(万股)`、`近一年增减持股东类型`、`近一年增减持方向`。

---

## 5. 股票研究服务接口

以下 6 个工具均位于 `https://mcp.wind.com.cn/vserver_stock_research/mcp/`，输入统一为 `{windCode}`（应用由 westock 代码转换），输出为服务端 JSON 对象。其中 4 个走通用路由工厂 `windToolRoute`（payload 原样存 `{data}`），前端按需渲染。

### 5.1 stock_get_company_earnings_estimate（一致预期）

- **主功能**：Wind 一致预期页（一致评级/目标价/未来三年盈利预测/评级明细）。
- **输入参数**：`{windCode: string}`，如 `600519.SH`。
- **输出结果**（应用解析为 `WindConsensusData`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `wind_code` | string | Wind 代码 |
| `rating` | string \| null | 一致评级（源字段「当前机构评级.一致评级」） |
| `rating_count` | number \| null | 评级机构家数 |
| `target_price` | number \| null | 一致目标价 |
| `current_price` | number \| null | 当前价 |
| `upside` | number \| null | 上涨空间 % |
| `forecast` | object \| null | 未来三个财年的一致预测，键为「{年份}年[预测]营业收入 / 归母净利润 [同比增长率(%)]」共 36 键（2025–2028 年） |
| `details` | array \| null | 最新评级及预测明细，每条 17 键：`日期`、`研究机构`、`研究员`、`评级`、`前次评级`、`{2026/2027/2028}年预测营业收入(变化方向)`、`{2026/2027/2028}年预测归母净利润(变化方向)` 等 |

### 5.2 stock_get_money_flow_analysis（资金流向）

- **主功能**：Wind 资金流向页（主力资金/融资融券/陆股通/成交活跃度等分块）。
- **输入参数**：`{windCode}`。
- **输出结果**（应用解析为 `WindMoneyFlowData`，取源对象「资金面数据」，剥离元信息键 `tool/入参/交易日期/交易时间/证券代码/证券简称` 后其余对象块进 `sections`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `wind_code` | string | Wind 代码 |
| `trade_date` | string | 交易日期 |
| `trade_time` | string | 交易时间 |
| `sections` | object | 各数据块，键为块名 |

`sections` 各块结构：

| 块 | 结构 |
|---|---|
| `成交活跃度` | `字段: string[5]`、`最近5日: any[5][5]`（行式，row[j] 对应 字段[j]）、`近20日: {20日均成交额(亿元), 20日最大成交额(亿元), 20日均换手率(%)}` |
| `主力资金` | `字段: string[3]`、`最近5日: any[5][3]`、`近20日: {累计主力净流入额(亿元), 主力净流入天数, 平均主力净流入占比(%)}` |
| `融资融券` | `字段: string[4]`、`最近5日: any[5][4]`、`近20日: {融资余额变化额(亿元), 融资余额变化率(%), 融资净买入额(亿元), 融资净买入天数, 融资净偿还天数}` |
| `陆股通` | 扁平键值：`日期`、`区间净买入量(万股)`、`市值变化(亿元)`、`持股数量(万股)`、`持股占比(%)` |
| `基金机构持仓` | `报告期`、`字段: string[4]`、`最近5日: any[10][4]` |
| `十大流通股东变化` | `字段: string[5]`、`最近5日: any[4][5]` |

注：该路由为「当日优先」逻辑（无参数加载时当日快照已存在则直接读库，缺失持仓才补抓），不适用最近日期优先三规则。

### 5.3 stock_get_company_valuation（估值）

- **主功能**：Wind 估值页（当前估值 stat 卡 + 趋势/相对估值转置表 + 可比公司两栏）。
- **输入参数**：`{windCode}`。
- **输出结果**（payload 原样存 `{data}`，顶层键）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `tool` | string | 工具名（如「估值研究」） |
| `windCode` | string | Wind 代码 |
| `注释` | string | 统计口径说明：PE 为 PE(TTM)，PB 为 PB(LF/MRQ)，PS 为 PS(TTM)，PCF 为 PCF(TTM)，股息率为股息率(TTM) |
| `自身当前估值` | object | `PE / PB / PS / PCF / 企业倍数 / 股息率`，均为 number |
| `自身估值趋势分析` | object | 6 指标（PE/PB/PS/PCF/企业倍数/股息率），每指标 9 键：`当前值`、`所处3年分位点(%)`、`3年80%分位值`、`3年20%分位值`、`所处3年中位数`、`所处5年分位点(%)`、`5年80%分位值`、`5年20%分位值`、`所处5年中位数` |
| `可比公司` | object | `可比公司列表: [{windCode, 证券简称}]` |
| `可比公司相对估值分析` | object | 11 指标（`总收入同比增长率(%)`、`2026年预测总收入同比增长率(%)`、`净利润同比增长率(%)`、`2026年预测净利润同比增长率(%)`、`PE`、`2026年预测PE`、`PB`、`PS`、`EV/Sales`、`EV/EBITDA`、`ROE(%)`），每指标 5 键：`平均值`、`中位数`、`分位数(%)`、`均值偏离率`、`中位数偏离率` |

### 5.4 stock_get_company_updates（公司动态）

- **主功能**：Wind 公司动态页（新闻式分组 + 点击弹窗看全文）。
- **输入参数**：`{windCode}`。
- **输出结果**（顶层五组数组）：

| 键 | 元素字段 |
|---|---|
| `recentEvent` | `abstract`（摘要）、`content`（全文） |
| `announcement` | `title`、`abstract`、`announcementDate` |
| `news` | `title`、`abstract`、`source`、`time` |
| `report` | `viewpoint`（观点）、`content` |
| `meeting` | `abstract`、`content` |

### 5.5 stock_get_technical_analysis（技术分析）

- **主功能**：Wind 技术分析页（区间涨跌幅/关键价位 stat + 趋势/动能/波动与通道转置表）。
- **输入参数**：`{windCode}`。
- **输出结果**（顶层键 `技术面数据`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `tool` / `入参.windCode` | string | 工具名 / 入参代码 |
| `复权方式` | string | 如「前复权」 |
| `交易日期` / `交易时间` | string | 数据日期 / 时间 |
| `证券代码` / `证券简称` | string | Wind 代码 / 名称 |
| `趋势分析` | object | `价格表现`、`均线系统`、`MACD`、`OBV` 四块 + `区间涨跌幅` |
| `动能指标` | object | `RSI`、`KDJ`、`CCI` 三块 |
| `波动与通道` | object | `BOLL`、`ATR` 两块 |
| `关键价位` | object | `近20日最高价(元)`、`近20日最低价(元)`、`近60日最高价(元)`、`近60日最低价(元)`、`近250日最高价(元)`、`近250日最低价(元)`、`近250日最大回撤(%)` |

各指标块统一结构：`字段: string[]`（`字段[0]` 恒为「日期」）、`最近5日: any[][]`（行式存储，5 行，`row[j]` 与 `字段[j]` 一一对应，`row[0]` 为日期）、可选 `技术特征: object`（如均线系统的「均线多头排列」、MACD 的「红柱持续天数/状态/零轴位置」等，布尔值前端转是/否）。`区间涨跌幅` 为扁平键值：`5日/20日/60日/120日/250日涨跌幅(%)`、`年初至今涨跌幅(%)`。

### 5.6 stock_get_company_profile（公司画像）

- **主功能**：Wind 公司画像页（四大类折叠面板 + JsonView）。
- **输入参数**：`{windCode}`。
- **输出结果**（顶层 `查询日期` + 四大类）：

| 键 | 内容概要 |
|---|---|
| `查询日期` | string |
| `公司身份与业务定位` | 公司名称信息（证券代码/中英文名称/简称）、基础业务说明（公司简介/经营范围/主要产品及业务）、企业属性（所有制性质/规模/成立日期/注册资本/法定代表人/上市日期/董事长/总经理/员工总数）、区位信息（省份/城市）、资本市场属性（发行证券一览/上市地点/总股本/流通股/限售股）、证券与上市身份标签（是否VIE结构/同公司A股/可转债/美股/港股Wind代码）、行业多口径分类（Wind/申万/国民经济/中上协行业）、产业链与竞争位置（可比公司列表、竞争位置量化指标：数据来源/货币/单位/明细列名/明细数据）、轻量财务质量快照（报告期/营业总收入/同比增长率等） |
| `主营业务与经营状况` | 深度嵌套的研究文档（原样 JsonView 渲染） |
| `控制权与治理安排` | 同上 |
| `融资投向与项目进展` | 同上 |

---

## 6. 错误处理约定

| 场景 | 应用行为 |
|---|---|
| 缺少 WIND_API_KEY | `configMissing: true`，`error` 给出配置指引，不发起 MCP 调用 |
| MCP 连接失败（`tools/list` 探测） | 顶层 `error` 为「万得 MCP 连接失败：…」；wind-news 单刷路径返回最近日期快照视图 |
| 认证失败（HTTP 401） | 抛「万得 MCP 认证失败，请检查 WIND_API_KEY」 |
| 积分不足/限频等纯文本错误 | `callTool` 原文抛出，按 per-holding `error` 透传（不落库/不覆盖旧快照） |
| 某问法「没找到数据」 | 风险/事件工具静默跳过该分类；其余工具该持仓无数据 |
| 技术指标缺失列（如新上市股 MA_250） | 解析为 `null`（非 NaN），前端格式化判空显示 `--` |

## 7. 相关环境变量

| 变量 | 说明 |
|---|---|
| `WIND_API_KEY` | 万得 API Key（缺失时回退 `~/.wind-aifinmarket/config`） |
| `WIND_MCP_ENDPOINT` | 金融文档服务地址（可选，默认见 1.2） |
| `WIND_STOCK_RESEARCH_ENDPOINT` | 股票研究服务地址（可选） |
| `WIND_STOCK_DATA_ENDPOINT` | 股票数据服务地址（可选） |