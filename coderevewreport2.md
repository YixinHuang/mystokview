# MyStokView 全项目 Code Review 报告（第二轮）

- **审查日期**：2026-11-23
- **审查范围**：与第一轮（coderevewreport.md）相同——server/ 6 文件、src/ 全部页面与组件、scripts/ 3 脚本、install.sh、配置文件、wind_news_agent.py、仓库卫生
- **审查方法**：三路并行深读（后端 / 前端 / 脚本与配置），以 `git diff 37879c6..HEAD` 定位近期改动并作为最高风险区重点审查；关键发现逐条人工核验
- **基线**：两轮审查之间项目经历了 16 项修复（P0×2、P1×3、P2×11）与 24 项 P3 修复，均已提交（`6e7881c`、`45baf34`）
- **类型检查基线**：`npx tsc --noEmit` 通过

## 一、总体结论

| 级别 | 数量 | 说明 |
|---|---|---|
| P1 | 2 | **均为上一轮修复引入的回归** |
| P2 | 5 | force 日期残留（6 处一组）、单刷错误透传缺口、chat 断开处理、发行包夹带、macOS 安装流程 |
| P3 | 23 | 一致性/健壮性小问题 |

**本轮最重要的价值**：两个 P1 都是上一轮修复时引入的回归——
1. wind-news 单刷「MCP 连接失败」分支返回空列表，前端整个列表被清空（引入自 P3-2 连接探测修复）
2. TechnicalPage 丢失 `!r.ok` 守卫，后端 500 会导致整页白屏崩溃（引入自 P3-16 错误改警告修复）

这说明对修复本身做复审是必要的。第一轮修复中**未引入回归的部分均确认完好**（见第五节）。

## 二、P1 发现（2 条，均为上轮修复引入的回归，已人工核验）

### P1-1 wind-news 单刷「MCP 连接失败」分支清空前端列表
- **位置**：server/index.ts:683-697 + src/pages/WindNewsPage.tsx:150-160
- **问题**：连接探测失败分支返回 `items: []` + `refreshed: {noData: true}`。前端 refreshOne 对 noData 走 `setData(j)` → 持仓列表被替换成「暂无持仓，请先在『我的持仓』页新增」；且 WindNewsPage 是 5 个 Wind 页中唯一 noData 提示**不拼 `j.error`** 的，toast 只显示「未查询到该股票的当日数据」，连接失败的真实原因被吞掉
- **建议**：该分支照抄下方 noData 分支返回最近日期快照视图（而非空 items）；WindNewsPage 的 noData 提示对齐其余 4 页拼上 `j.error`

### P1-2 TechnicalPage 丢失 `!r.ok` 守卫，500 时整页白屏
- **位置**：src/pages/TechnicalPage.tsx:95-99
- **问题**：P3-16 把 `if (j.error) throw` 改为警告渲染时，该页原有的隐式 500 防线随之消失（后端 500 返回 `{error}`，`j.error` 走警告分支后 `setData({error})`），渲染在 `data.summary.total` 抛 TypeError，且全应用无 ErrorBoundary。其余 8 个数据页均有 `if (!r.ok) throw`，仅此页缺失
- **建议**：`j.error` 判断前补 `if (!r.ok) throw new Error(j.error ?? "请求失败");`

## 三、P2 发现（5 条）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| P2-1 | src/components/WindToolPage.tsx:75-84 等前 6 处 force 路由（WindToolPage/WindNews/WindConsensus/WindRisk/WindEvents/WindMoneyFlow） | **force 刷新不清空日期选择**（违反数据存储规则 3）：`const d = force ? null : dateRef.current` 只决定 URL，`dateRef/selectedDate` 未复位——选中历史日期后点「刷新XX」拿到当日数据，副标题却仍显示「正在查看 X 的历史快照」 | 各页 refresh(true) 成功 setData 前清空 `dateRef/selectedDate`（refreshOne 已有正确写法） |
| P2-2 | server/windMcp.ts:169-176 + index.ts:704 | **callDocs 吞掉全部工具错误**（401/积分不足/限频）：`catch → return []`，`WindHoldingResult` 无 error 字段——wind-news 单刷认证失败与真无数据不可区分，且 wind-news 的 payload 也不带 error 落库（与 consensus/risk/events 不一致） | 给 WindHoldingResult 加 error 透传，payload 与响应按其余四路由的模式带上错误 |
| P2-3 | server/index.ts:1499-1519 | **/api/chat SSE 无客户端断开处理**：客户端中途断开后仍跑完最多 15 轮 CodeBuddy + curl 调用（资源浪费）；`res.write` 无 error 兜底 | `req.on("close")` 置标志中断生成循环；`res.on("error", () => {})` |
| P2-4 | scripts/make-release.sh:21 + install.sh:69 | **发行包可能夹带个人数据 tar 包**：仅排 `data.tar`，未排 `*.tar`——backup.sh 支持 `OUTPUT_DIR=. `，此类备份含 data/.env/.git 全量个人信息，会被打进发行包部署到目标机 | 两处补 `--exclude='*.tar'` |
| P2-5 | install.sh:14 + README.md:192 | **macOS 安装流程必然失败**：默认 `INSTALL_DIR=/opt/mystokview`，macOS `/opt` 为 root 所有，README 却称「macOS 可直接 bash install.sh（无需 sudo）」→ 非 root 在 `mkdir -p` 处 EACCES 退出 | README 注明 macOS 需 sudo 或覆盖 INSTALL_DIR |

## 四、P3 发现（23 条）

### 后端（7 条）

| 位置 | 问题 |
|---|---|
| server/windMcp.ts:141-149 | callTool 中 `result` 为 null 时 catch 块内 `result.content` 二次解引用抛 TypeError 掩盖原错误。两处改 `result?.content?.[0]?.text` |
| server/db.ts:271-275 | ALTER TABLE 的 catch-all 吞掉「列已存在」以外的错误（如库锁），后续 chatRepo 将报 no such column。建议仅忽略 duplicate column |
| server/index.ts:179 | POST /api/holdings 的 open_date 无格式校验（任意字符串入库）。用 SNAP_DATE_RE 校验或置 null |
| server/agent.ts:94 | 文本块含 "authentication required" 即整块丢弃，会误伤恰好提及该短语的合法回复。建议改为整块匹配报错模式才替换 |
| server/agent.ts:8-19 | getFreePort 释放与 CodeBuddy 绑定间存在 TOCTOU 竞态（低概率，可接受），建议注明 |
| server/index.ts:677 | wind-news key-missing 分支 `refreshed: null` 与其余路由 `{noData:true}` 不一致（前端因 configMissing 早退无实际影响） |
| src/pages/WindMoneyFlowPage.tsx:90 | 负缓存行（真无资金面数据、error=""）也显示「该次抓取失败，请刷新重试」，文案误导。按 `entry.error` 区分「抓取失败」与「暂无数据」 |

### 前端（4 条）

| 位置 | 问题 |
|---|---|
| src/pages/WindConsensusPage.tsx:73-77 | Number.isFinite 修复未覆盖 null（`Number(null) === 0` 可通过）：明细行目标价为 null 时误标「下调」。条件改 `target != null && prevTarget != null` |
| src/components/AddHoldingDialog.tsx:28-31 | keyword 清空时 effect 提前 return 不递增 seq——在途旧搜索返回后旧候选重新弹出。early return 前也 `++searchSeqRef.current` |
| src/pages/WindNewsPage.tsx:150-151 | refreshOne noData 提示不拼 `j.error`，与其余 4 个 Wind 页不一致（与 P1-1 一并修） |
| src/App.tsx:96-141 | 17 页面常驻挂载，首屏一次性并发触发全部页面 useEffect 请求（含 6 个 westock 实时抓取），消耗限流额度拖慢首屏。建议记录 visited 状态惰性挂载 |

### 脚本与配置（12 条）

| 位置 | 问题 |
|---|---|
| scripts/make-release.sh:21-24 | 未排除 `wind-mcp-doc/`（实测已混入发行包）。补 `--exclude=wind-mcp-doc` |
| scripts/make-release.sh:21-22 | 排除模式无锚定（`--exclude=data` 连 `src/data/` 也排除）。改 `./data` 锚定顶层 |
| scripts/backup.sh:28,39 | EXTRA_EXCLUDE 无引号展开（SC2086），改数组展开 |
| scripts/backup.sh:26-27,47 | set -e 中途失败时 mktemp 临时目录泄漏，加 trap 清理 |
| install.sh:12 | `VERSION="0.1.0"` 定义后未使用，与真实版本脱节。删除 |
| install.sh:69-71 | EXCLUDES 与 make-release 不同步（缺 `.DS_Store`、`release`），开发目录直跑会拷入发行包 |
| vite.config.ts:8 | PORT 非数字时 `Number()` → NaN，proxy target 变 `localhost:NaN` 静默断代理。加 isFinite 回退 |
| index.html:6 | 标题「我的股票」与 AGENTS.md/README 的「MyStokView（我的持仓）」不一致——经核实为用户有意更名，属**文档待同步**而非 bug |
| coderevewreport.md | 评审报告已入库（经核实为有意保留），文件名拼写为 coderevew——如需改名可顺手修正 |
| scripts/docker-test.sh:8,35,38 | 版本号三处硬编码 0.1.0，版本 bump 后脚本失效。从 package.json 读取 |
| wind_news_agent.py:2,29,104 | 文档头称 GLM-5.3-Flash 而 `MODEL = "glm-5.3"` 不一致；`payload["result"]` 在 result 缺失时抛 KeyError 而非友好报错 |
| .gitignore | 缺 `.codebuddy/`（install.sh/make-release 均排除但仓库不忽略） |

## 五、第一轮修复的回归检查结论

三路审查对全部 16+24 项修复做了回归检查，除上述 2 个 P1 外**其余确认完好**，要点：

- mergeSingleRefresh 五路由等价（wind-news 改调助手后与原手写逻辑一致）；error 空串哨兵的合并写/响应/前端渲染闭环正确
- moneyflow 负缓存 filter（`moneyflow || !error`）与合并写配合正确；RateLimiter 精确等待无竞态、waitMs 恒为正
- SSE 响应事件过滤正确（JSON-RPC 响应必有 id/result/error 之一）；tools 迁移幂等、chatRepo JSON 容错完整
- ChatPage 超时/abort、JsonView 熔断、EditableNumber 校验流程、config memo、refresh/refreshOne 互斥接管均按设计工作
- POST/PATCH 数值校验、chat sessionId 校验、quotes try/catch、双限流、tsx 入 dependencies 等前轮修复全部确认完整
- 脚本链路：make-release 暂存组装自洽（无自我包含）、backup.sh 端到端实测通过、install.sh 数组在 bash 3.2 兼容、.gitignore 实测全命中、agent.ts API_BASE 三方（index/vite/systemd）PORT 语义一致

## 六、修复优先级建议

1. **立即**：P1-1、P1-2（两个回归，各约 5 行）
2. **本周**：P2-1（force 清日期，6 处同构）、P2-2（callDocs 错误透传）、P2-3（chat 断开处理）
3. **择期**：P2-4/5（脚本与文档）、全部 P3
4. 顺带：README/AGENTS.md 标题同步为「我的股票」（配合 index.html 有意更名）
