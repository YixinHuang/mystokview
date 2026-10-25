import { query } from "@tencent-ai/agent-sdk";
import net from "node:net";

const API_BASE = "http://localhost:3001";

/** 获取空闲端口：CodeBuddy CLI 默认监听 58145，会与 WorkBuddy 桌面端冲突，需动态指定 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    srv.on("error", reject);
  });
}

export const SYSTEM_PROMPT = `你是「持仓管家」，一位内嵌在 MyStokView 持仓管理应用里的 AI 助手，帮助用户管理 A 股/ETF 持仓。

## 你可以使用的工具

通过 Bash 工具用 curl 调用本应用的本地 API（基础地址 ${API_BASE}）：

1. 查询持仓概览（含实时行情、市值、权重、浮动盈亏、已实现盈亏、汇总）：
   curl -s ${API_BASE}/api/holdings
2. 查询实时行情（代码格式 sh600519 / sz300253 / hk00700）：
   curl -s "${API_BASE}/api/quotes?codes=sh600519,sz300253"
3. 新增持仓（name 或 code 二选一；给 name 会自动搜索匹配代码）：
   curl -s -X POST ${API_BASE}/api/holdings -H "Content-Type: application/json" -d '{"name":"宁德时代","quantity":100,"cost_price":180.5,"open_date":"2026-10-24"}'
4. 修改持仓（quantity 持仓数量 / cost_price 成本价 / realized_pnl 已实现盈亏，可单改一项）：
   curl -s -X PATCH ${API_BASE}/api/holdings/sh600519 -H "Content-Type: application/json" -d '{"quantity":800}'
5. 删除持仓：
   curl -s -X DELETE ${API_BASE}/api/holdings/sh600519
6. 搜索证券代码：
   curl -s "${API_BASE}/api/search?q=蓝色光标"
7. 查询行情授权状态：
   curl -s ${API_BASE}/api/auth/status

## 行为准则

- 查询概览：调一次 /api/holdings 即可拿到全部数据，用简洁的中文表格或要点汇报，涨用"涨"描述、跌用"跌"描述。
- 修改持仓：先查询拿到改前数据，修改后再查一次，向用户汇报「改前 → 改后」对比（数量、成本、浮动盈亏变化）。
- 删除/新增：操作后重新查询概览确认结果。
- 用户问行情：用 /api/quotes 查询后解读。
- 授权引导：若 API 返回里 authRequired 为 true 或 stale 为 true，提醒用户行情当前来自缓存，引导用户在页面上方 banner 打开授权链接完成扫码授权；不要假装行情是实时的。
- 金额单位为元，保留两位小数；盈亏要带正负号与百分比。
- 所有回答使用简体中文，简洁专业。`;

export interface AgentStreamEvent {
  type: "text" | "tool" | "done" | "error";
  text?: string;
  toolName?: string;
  error?: string;
}

/** 发起一次持仓管家对话，返回 SSE 友好的异步事件流 */
export async function* runHousekeeperTurn(
  userMessage: string,
  history: Array<{ role: string; content: string }>
): AsyncGenerator<AgentStreamEvent> {
  const historyText = history
    .slice(-10)
    .map((m) => `${m.role === "user" ? "用户" : "持仓管家"}：${m.content}`)
    .join("\n");

  const prompt = historyText
    ? `以下是最近对话记录：\n${historyText}\n\n用户最新消息：${userMessage}`
    : userMessage;

  try {
    const cliPort = await getFreePort();
    const stream = query({
      prompt,
      options: {
        maxTurns: 15,
        cwd: process.cwd(),
        executable: "node",
        allowedTools: ["Bash", "Read"],
        systemPrompt: SYSTEM_PROMPT,
        permissionMode: "bypassPermissions",
        extraArgs: { port: String(cliPort) },
      },
    });

    for await (const message of stream as AsyncIterable<any>) {
      if (message.type === "assistant") {
        const content = message.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            // 过滤 CLI 原始英文认证报错，统一由下方中文引导替代
            if (/authentication required/i.test(block.text)) continue;
            yield { type: "text", text: block.text };
          } else if (block.type === "tool_use") {
            yield { type: "tool", toolName: String(block.name ?? "tool") };
          }
        }
      } else if (message.type === "result") {
        yield { type: "done" };
      }
    }
    yield { type: "done" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/authentication required/i.test(msg)) {
      yield {
        type: "error",
        error:
          "持仓管家的 AI 引擎（CodeBuddy CLI）尚未登录。请任选一种方式完成鉴权后重试：\n" +
          "1. 在终端执行：npx codebuddy login（按提示在浏览器完成登录）\n" +
          "2. 或在项目根目录 .env 中配置 CODEBUDDY_API_KEY（从 CodeBuddy 控制台获取），然后重启后端服务",
      };
    } else {
      yield { type: "error", error: `Agent 调用失败：${msg}` };
    }
  }
}
