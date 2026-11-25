# MyStokView 全项目 Code Review 报告（第三轮）

- **审查日期**：2026-11-23
- **审查范围**：与前两轮一致——server/ 全部、src/ 全部页面与组件、scripts/ 4 脚本、install.sh、配置文件、wind_news_agent.py、仓库卫生
- **审查方法**：三路并行深读（后端 / 前端 / 脚本与配置），以 `git diff 2d14d6d..HEAD` 定位二轮审查后新增且**尚未被任何审查覆盖**的代码；关键发现逐条人工核验，脚本类做了沙箱实测
- **基线**：二轮报告的 30 项发现已全部修复（提交 `2d14d6d` → `5e793db` → `662a889` → `4b89ea5` → `eff358c`），本轮审查的是这些修复落地后的代码
- **类型检查基线**：`npx tsc --noEmit` 通过

## 一、总体结论

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 / P1 | **0** | 首次实现零高危——前两轮的回归问题未再出现 |
| P2 | 5 | 本轮自身修复引入 2 个新回归（已如实标注） |
| P3 | 21 | 一致性/健壮性/文案细节 |

**趋势向好**：P0/P1 从第一轮的 5 → 第二轮的 2 → 本轮 **0**。本轮 26 项中 2 个 P2 是本轮修复自身引入的小回归（backup.sh trap 退出码、搜索 loading 卡死），均已在报告中给出修复方案。

## 二、P2 发现（5 条）

### P2-1 backup.sh 的 EXIT trap 使成功路径退出码变为 1（本轮新引入回归）
- **位置**：scripts/backup.sh:26
- **问题**：`cleanup() { [ -n "$SNAP_DIR" ] && rm -rf "$SNAP_DIR"; }` —— SNAP_DIR 为空时 `[ -n ]` 返回 1，EXIT trap 的非零状态会把**成功脚本**的退出码改写为 1（实测 /bin/bash 3.2.57：无 data/portfolio.db 时打印「备份完成」但 exit=1）。命中条件：无 sqlite3 或 DB 文件不存在（新 clone、自动化先行跑）。反向不成立（body 失败 + trap 成功仍 exit=1，失败不会被掩盖）
- **建议**：改为 `if [ -n "$SNAP_DIR" ]; then rm -rf "$SNAP_DIR"; fi` 或尾部补 `|| :`

### P2-2 coderevewreport*.md 已入库并混入发行包（处理需你决策）
- **位置**：仓库根 coderevewreport.md / coderevewreport2.md（`6e7881c`、`2d14d6d` 提交入库）
- **问题**：实测 make-release 产物顶层含两份内部审查报告，随之部署到目标机；文件名拼写为 revew
- **说明**：报告入库源自本轮 P2-13 仓库卫生的 `git add -A`，文件名是你明确指定的——是否移出仓库由你决策。若决定移出：`git rm` 两文件 + .gitignore 加 `coderevewreport*.md`（或至少在 make-release/install.sh 排除）

### P2-3 AddHoldingDialog 搜索进行中清空关键词会让 searching 永久卡 true（本轮新引入回归）
- **位置**：src/components/AddHoldingDialog.tsx:29,45
- **问题**：本轮修复「清空关键词递增 seq 作废在途请求」后，在途 fetch 已执行 `setSearching(true)`，其 finally 的 `seq === searchSeqRef.current` 因 seq 过期被跳过——用户清空输入后 Loading 永不熄灭（再次输入非空关键词才自愈）
- **建议**：空关键词分支补 `setSearching(false)`；或 finally 改为 `seq <= searchSeqRef.current` 判断

### P2-4 wind-news 单刷成功 payload 缺 `error: ""` 哨兵，旧错误无法清除
- **位置**：server/index.ts:736
- **问题**：`mergeSingleRefresh(..., { news, announcements })` 无 error 键，合并写保留 prev.error——当日先限频出错、后单刷成功的持仓会在页面上**永久显示陈旧错误**，直到下次全刷。对比 wind-consensus 单刷 payload 带 `error: e.error ?? ""` 能正确清错
- **建议**：成功 payload 补 `error: freshErr ?? ""`

### P2-5 wind-news 全刷（force/首次）响应 items 不含 error，全部持仓 401/积分不足时用户只见空列表无提示
- **位置**：server/index.ts:815-818（已人工核验：该 items 行为 6 空格缩进，未被此前 12 空格的 replace_all 覆盖）
- **问题**：error-only 行已落库，但全刷响应既不透出 items.error 也不并入 topError——当场点「刷新资讯」得到空列表且无任何错误提示；错误要到下一次普通加载（规则 1）才显示
- **建议**：全刷响应 items 补 `error: p?.error ?? null`（同规则 1 写法）

## 三、P3 发现（21 条）

### 后端（8 条）

| 位置 | 问题 |
|---|---|
| server/index.ts:159/182 | open_date 校验用 trim 后的值、入库存原始值（带空格入库与 ?date= 比对不上）。入库前统一 trim |
| server/index.ts:651-653 | wind-news `?date=` 历史路径 items 不含 error，与 wind-consensus 同路径不一致（历史回看不显示抓取错误） |
| server/index.ts:1556-1560 | catch-all `app.get("*")` 把未知 `/api/*` 路径当 SPA 路由返回 HTML 200，前端 r.json() 解析失败难排查。catch-all 前加 /api 前缀 404 兜底 |
| server/index.ts:801-806 | 全刷抓取失败（MCP 连不上）时响应恒 `fromDb: false`，items 实为库中旧值，前端「上次刷新」被误更新。失败分支按实际标注 |
| server/index.ts:801-806 | 该段缩进错乱（diff 格式残留），纯可读性 |
| server/market.ts:1615-1627 | searchCode 不识别 AUTH_REQUIRED——westock 未授权时新增持仓误报「未搜索到」。检出时抛带授权链接的专用错误 |
| server/market.ts:349-387 | fetchNews 不检测限频文案（fetchReports/fetchFundFlow 均有），限频残缺时静默显示「无新闻」。与 fetchReports 对齐 |
| server/agent.ts:96 | CLI 以 text 块输出认证报错时整块被丢弃且无中文引导替代，该轮回复为空（注释声称的替代未实现于该路径）。过滤处改为 yield 中文引导 error 事件 |

### 前端（8 条）

| 位置 | 问题 |
|---|---|
| src/pages/WindConsensusPage.tsx:82 | 目标价为 null 时行内渲染字面量 "null"（`null !== undefined` 为真）。75 行已改 `!= null`，两处口径不一致，对齐 |
| src/pages/WindNewsPage.tsx:69,87 | 合并写可产生「旧数据 + 新 error」共存的 entry，hasData 分支不渲染 error——该股刷新失败对用户不可见。hasData 分支补行内提示 |
| src/components/WindToolPage.tsx:47,56 | ToolRow 同上：有数据时 error 不渲染，缺口同修 |
| src/pages/NewsPage.tsx:101-104 | openDetail 无序号守卫，快速连点两条新闻时慢的旧响应覆盖弹窗。加 seqRef（ReportsPage.tsx:121-124 同款同修） |
| src/pages/NewsPage.tsx:190 | 新闻正文 dangerouslySetInnerHTML——后端 sanitizeNewsHtml 已消毒，此项为纵深防御建议（改纯文本或保持现状注明） |
| src/pages/FundFlowPage.tsx:254-256 | 汇总栏流入/流出金额未格式化（原始元值），与页内 fmtYi/fmtAmount 风格割裂 |
| src/pages/NewsPage.tsx:142 等六处 | 未选日期时「{selectedDate} 暂无历史快照」文案失真（渲染为空串开头，且此刻展示的是当日数据非历史查询）。selectedDate 为 null 时改「当日暂无数据」 |
| src/components/AddHoldingDialog.tsx:116-139 + src/pages/HoldingsPage.tsx:56-57 | 选中候选后以候选名再发起一次多余搜索（effect 跳过 keyword === selected?.name）；PATCH 成功提示「已保存」后静默刷新失败无反馈，表格停留旧值直到 60s 自动刷新 |

### 脚本与配置（5 条）

| 位置 | 问题 |
|---|---|
| package.json:9 | description 仍为「我的持仓」——命名同步漏网（README/AGENTS.md/index.html 已改「我的股票」） |
| server/index.ts:36 + server/agent.ts:5 | 与 vite.config 同类的 PORT 非数字问题未同步：PORT=abc 时 agent.ts 得 `localhost:NaN` 静默断链（index.ts listen(NaN) 会抛异常尚可发现）。同款 isFinite 守卫 |
| install.sh:68-70 | EXCLUDES 缺 wind-mcp-doc，与 make-release 不一致——免 sudo 路径会把本地 gitignored 参考目录拷入安装目录。补齐 |
| README.md:134 | 项目结构树过时：scripts/ 仅列 1 个（实际 4 个）、src/pages/ 仅列 2 页（实际 17 页）；backup.sh（含敏感数据打包）全文零提及。补树与说明 |
| scripts/docker-test.sh:24-29 | systemd 等待循环超时后不失败，静默继续到第 6 步才暴露。循环后补就绪断言 `|| exit 1` |

## 四、二轮修复的回归检查结论（全部通过）

三路审查对二轮 30 项修复逐项回归检查，**未发现功能性回归**（仅上述 2 个 P2 级小回归，已列明）。要点确认：

- wind-news 单刷连接失败分支返回快照视图（不再清空列表）✓；noData toast 拼 j.error ✓
- force 清日期 6 处实现一致、与 refreshOne 清日期无冲突 ✓；refresh/refreshOne 互斥接管四种交错顺序推演正确 ✓
- callDocs 错误透传（含部分成功组合）、error 空串哨兵、负缓存 filter、chat SSE clientGone（res close + writableEnded）✓
- callTool 空值安全、tools 迁移幂等、App 惰性挂载（无 display:none 挂载场景、StrictMode 双挂载无残留）✓
- 脚本：backup.sh 数组展开 bash 3.2 实测正确、快照追加路径对齐；make-release 产物排除集实测全部生效（除 coderevewreport* 见 P2-2）；docker-test 动态 VERSION 引用链自洽；lockfile 一致 ✓

## 五、修复优先级建议

1. **尽快**：P2-1（trap 退出码，一行）、P2-3（searching 卡死，一行）——两个本轮引入的小回归
2. **尽快**：P2-4、P2-5（wind-news 错误哨兵与透传收尾，各 1-2 行）
3. **决策**：P2-2（两份报告是否移出仓库/发行包，由你定）
4. **批量**：P3 中后端 5 条错误可见性/一致性小修 + 前端 8 条文案/守卫补齐 + 脚本文档同步
5. **酌情**：App 惰性挂载后如需进一步降低首屏负载，可将 westock 系页面的 mount 请求改为「挂载后可见时才发」
