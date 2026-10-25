# MyStokView · 我的持仓

基于 [CodeBuddy Agent SDK](https://www.codebuddy.ai) 的**股票持仓管理 Web 应用**。用于记录 A 股 / ETF 持仓，结合实时行情计算市值、浮动盈亏、权重与已实现盈亏，并内置一个能用自然语言查询 / 修改持仓的「持仓管家」AI 助手。

---

## 功能特性

- **持仓管理**：新增 / 修改 / 删除持仓（支持按名称自动搜索证券代码）。
- **实时行情**：通过 `westock` 获取实时价格、涨跌幅；未授权时自动回退本地缓存并提示授权。
- **盈亏分析**：自动计算个股市值、成本、浮动盈亏与百分比、组合权重，以及组合汇总（总市值 / 总成本 / 总浮动盈亏 / 已实现盈亏）。
- **AI 持仓管家**：对话式查询与操作持仓，AI 通过工具调用本地 API 完成增删改查。
- **自动刷新**：持仓页每 60 秒静默刷新行情，可手动开关。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + TDesign React |
| 后端 | Node.js + Express 4 + TypeScript（`tsx` 直接运行 TS） |
| 数据库 | better-sqlite3（本地文件 `data/portfolio.db`，WAL 模式） |
| AI | `@tencent-ai/agent-sdk`（内置 CodeBuddy CLI） |
| 行情 | 外部 CLI `westock`（需单独安装并扫码授权） |

---

## 环境要求

- **Node.js >= 18**（开发 / 运行）
- **npm**（随 Node 附带）
- **westock 命令行工具**（行情数据源，**非 npm 直接依赖**，需单独安装并扫码授权，详见下文）

> 提示：首次克隆后建议先运行 `npm run setup` 一键预检上述依赖是否满足。

---

## 快速开始

```bash
# 1. 安装项目依赖
npm install

# 2. 安装并授权行情工具 westock（见下方专门章节）

# 3.（可选）配置环境变量，复制示例并按需修改
cp .env.example .env

# 4. 开发模式：同时启动前端(5173)与后端(3001)
npm run dev
# 浏览器打开 http://localhost:5173

# 生产模式
npm run build      # 构建前端到 dist/
npm start          # 启动后端并托管 dist/，访问 http://localhost:3001
```

---

## westock 安装与授权（重要）

`westock` 是本项目获取 A 股 / ETF **实时行情**的命令行工具，项目通过 `execFile("westock", ...)` 调用它并解析其 markdown 表格输出。它**不在 `package.json` 中**，需要你在宿主机上单独安装并完成一次扫码授权。

### 1. 安装

请按 `westock` 官方 / 实际来源选择安装方式，常见方式（若与官方不一致，请以官方文档为准）：

```bash
npm install -g westock
# 或参考 westock 官方文档的其它安装方式
```

### 2. 验证安装

```bash
westock version --json
```

若命令不存在，请先完成上面的安装步骤。

### 3. 授权（扫码登录）

`westock` 首次使用需要授权，否则行情查询会返回 `AUTH_REQUIRED:<授权链接>`。两种授权入口：

- **方式 A（推荐）**：直接运行 `westock version`，工具会输出授权链接，在浏览器打开并扫码登录。
- **方式 B**：在本应用的「我的持仓」页面，若行情处于缓存状态，页面顶部会显示**授权提示 banner**，点击其中的链接完成扫码授权即可。

授权成功后，`westock version --json` 中的 `auth` 字段为 `true`，行情即恢复实时。

### 4. 一键预检

项目提供了预检脚本，可一次性检测 Node 版本、npm 依赖、`westock` 安装与授权状态、`.env` 配置：

```bash
npm run setup          # 等价于 bash scripts/check-prereqs.sh
```

后端启动时也会自动检测 `westock` 并在控制台打印安装 / 授权状态（未安装或未授权时会给出引导，且不影响应用启动，仅行情回退为缓存）。

### 5. 降级说明

未安装 `westock` 或未授权时，应用**仍可正常运行**，但行情来自 `quote_cache` 本地缓存，页面顶部会显示授权提示 banner。AI 管家在回答行情类问题时也会如实告知"行情来自缓存，非实时"。

---

## 配置项（`.env`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3001` | 后端服务端口（前端 Vite 已代理 `/api` 到该端口） |
| `CODEBUDDY_API_KEY` | 空 | 可选。AI 持仓管家的鉴权方式之一；也可改用 `npx codebuddy login` 浏览器登录（推荐，无需填 Key） |

---

## AI 持仓管家

「持仓管家」基于 `@tencent-ai/agent-sdk` 的 `query` 能力。它在本应用内被限定只能使用 `Bash` 与 `Read` 工具，并通过 `curl` 调用本应用的本地 API（基础地址 `http://localhost:3001`）来完成持仓查询 / 新增 / 修改 / 删除与行情查询，形成"AI 调用自身后端"的闭环。

**首次使用前需登录 CodeBuddy CLI（二选一）：**

```bash
npx codebuddy login     # 浏览器登录（推荐）
# 或在 .env 中配置 CODEBUDDY_API_KEY 后重启后端
```

为规避 CodeBuddy CLI 默认监听端口 `58145` 与 WorkBuddy 桌面端的冲突，应用会为每次对话**动态分配空闲端口**。若 Agent 调用失败且提示未登录，请按页面 / 控制台指引完成 `npx codebuddy login`。

---

## 项目结构

```
mystokview/
├── scripts/
│   └── check-prereqs.sh     运行前环境预检（Node / 依赖 / westock）
├── server/
│   ├── index.ts             Express 路由 + 盈亏计算 + SSE 对话
│   ├── db.ts                建表、种子数据、持仓/行情缓存/聊天仓库
│   ├── market.ts            调用 westock，解析行情，未授权回退缓存
│   └── agent.ts             Agent SDK 封装，系统提示词，SSE 事件流
├── src/
│   ├── pages/               HoldingsPage（持仓）、ChatPage（管家）
│   ├── components/          OverviewCards / HoldingsTable / AddHoldingDialog / AuthBanner
│   ├── types.ts / utils.ts / App.tsx / main.tsx
├── vite.config.ts          代理 /api → localhost:3001
├── .env.example            环境变量示例
└── package.json
```

---

## 数据说明

- 数据库文件位于 `data/portfolio.db`（已被 `.gitignore` 忽略，含个人持仓，请勿提交）。
- 首次启动会自动写入 7 只示例持仓（见 `server/db.ts` 的 `SEED_HOLDINGS`）。正式使用前可在页面删除或替换。

---

## 常见问题（FAQ）

- **行情总显示"缓存 / 来自缓存"？** —— `westock` 未安装或未授权，按上文"westock 安装与授权"完成扫码登录。
- **AI 管家回复失败 / 提示未登录？** —— CodeBuddy CLI 尚未登录，终端执行 `npx codebuddy login`，或配置 `CODEBUDDY_API_KEY`。
- **端口冲突？** —— 后端默认 3001；CodeBuddy CLI 默认 58145 已由应用动态端口规避，若仍冲突可在 `.env` 改 `PORT`。
- **生产部署后前端空白？** —— 需先 `npm run build` 生成 `dist/`，再用 `npm start` 启动（Express 会托管 `dist/`）。

---

## 安全提示

- 后端 `/api/*` **当前无鉴权**，仅适用于本地 / 内网可信环境；如需公网部署，请自行增加鉴权层。
- AI 管家以 `bypassPermissions` 模式运行，工具范围限定为 `Bash` + `Read`，仅用于调用本地 API 与读取文件，请知悉其权限边界。

---

## 发行版安装包

项目提供一键安装器，便于在任意 Linux（systemd）/ macOS 机器上分发部署。

### 生成安装包

```bash
bash scripts/make-release.sh
```

产出 `release/mystokview-<version>.tar.gz`（已自动排除 `node_modules`、`dist`、`data`、`.env`、`.workbuddy` 等本地产物与敏感文件）。

### 在目标机安装

```bash
tar -xzf mystokview-0.1.0.tar.gz
cd mystokview-0.1.0
sudo bash install.sh            # Linux：自动装 Node>=18、npm install、构建、注册 systemd 服务并启动
# macOS 可直接 bash install.sh（nohup 后台启动，未注册系统服务）
```

`install.sh` 支持环境变量覆盖：`INSTALL_DIR`（默认 `/opt/mystokview`）、`PORT`（默认 `3001`）、`APP_USER`（默认 `mystokview`）。

### 安装后

- 开放防火墙端口 `3001`（云控制台安全组 / `ufw allow 3001`）。
- 实时行情：服务器安装并扫码授权 `westock`（`npm install -g westock && westock version`）；未授权时行情走本地缓存，应用仍正常运行。
- AI 管家：目标机终端执行 `npx codebuddy login` 完成登录。
- 日志：Linux `journalctl -u mystokview -f`；macOS `tail -f /opt/mystokview/mystokview.log`。
