"""
使用 GLM-5.3 的函数调用（Tool Call）能力，桥接"万得金融文档检索服务"MCP，
查询上市公司的财经新闻、市场评论。

架构：
    用户问题(公司名) ──> GLM-5.3 ──(tool_calls)──> 本地 MCP 客户端
                          ^                             │
                          └──────(工具结果回传，模型总结)──────┘

MCP 侧协议：JSON-RPC 2.0 over HTTP POST，响应为 SSE 流，鉴权 Bearer Token。
    服务端工具（tools/list 动态获取，无需写死）：
      - get_financial_news(query, top_k)      财经新闻/市场评论
      - get_company_announcements(query, top_k) 上市公司官方公告

运行前：
    pip install openai requests
    export ZHIPUAI_API_KEY="智谱 API Key"        # https://open.bigmodel.cn
    export WIND_API_KEY="万得 API Key"           # 已在 ~/.wind-aifinmarket/config 配置的会自动读取
"""

import json
import os
import sys
from pathlib import Path

import requests
from openai import OpenAI

MODEL = "glm-5.3"
ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/"
WIND_MCP_ENDPOINT = "https://mcp.wind.com.cn/vserver_financial_docs/mcp/"


def _load_wind_api_key() -> str:
    """按 优先级 读取万得 Key：环境变量 > ~/.wind-aifinmarket/config。"""
    key = os.environ.get("WIND_API_KEY", "").strip()
    if key:
        return key
    config = Path.home() / ".wind-aifinmarket" / "config"
    if config.exists():
        for line in config.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("WIND_API_KEY"):
                parts = line.split("=", 1)
                if len(parts) < 2:
                    continue
                key = parts[1].strip().strip('"').strip("'")
                if key and not key.startswith("#"):
                    return key
    raise SystemExit("未找到万得 API Key，请设置环境变量 WIND_API_KEY")


# ----------------------------------------------------------------------
# 第一步：极简 MCP 客户端（JSON-RPC 2.0 + SSE 解析）
# ----------------------------------------------------------------------
class WindMCPClient:
    def __init__(self, endpoint: str = WIND_MCP_ENDPOINT, api_key: str = ""):
        self.endpoint = endpoint
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self._id = 0

    def _rpc(self, method: str, params: dict) -> dict:
        """发送一条 JSON-RPC 请求，解析 SSE 流并返回 result（出错抛异常）。"""
        self._id += 1
        resp = requests.post(
            self.endpoint,
            headers=self.headers,
            json={"jsonrpc": "2.0", "id": self._id, "method": method, "params": params},
            timeout=60,
        )
        if resp.status_code == 401:
            raise RuntimeError("万得 MCP 认证失败，请检查 WIND_API_KEY")
        resp.raise_for_status()

        # 服务端不返回 charset，requests 会按 latin-1 解码导致中文乱码，强制 UTF-8
        resp.encoding = "utf-8"

        # 响应可能是 SSE（事件按空行分隔，事件内多行 data 需按规范用 \n 拼接），
        # 也可能是普通 JSON，两种都兼容
        payload = None
        if "text/event-stream" in resp.headers.get("Content-Type", ""):
            for event in resp.text.replace("\r\n", "\n").split("\n\n"):
                data_lines = [
                    line[5:].strip()
                    for line in event.splitlines()
                    if line.startswith("data:")
                ]
                if not data_lines:
                    continue
                try:
                    payload = json.loads("\n".join(data_lines))
                except json.JSONDecodeError:
                    continue  # 跳过无法解析的事件（如注释、心跳）
        else:
            payload = resp.json()
        if payload is None:
            raise RuntimeError(f"MCP 响应中未找到数据: {resp.text[:200]}")
        if "error" in payload:
            raise RuntimeError(f"MCP 错误: {payload['error']}")
        if "result" not in payload or payload["result"] is None:
            raise RuntimeError(f"MCP 响应缺少 result: {str(payload)[:200]}")
        return payload["result"]

    def list_tools(self) -> list:
        """获取服务端全部工具定义（含 JSON Schema 形式的 inputSchema）。"""
        return self._rpc("tools/list", {})["tools"]

    def call_tool(self, name: str, arguments: dict) -> dict:
        """调用服务端工具，把 content[0].text 里的 JSON 字符串解析成 dict。"""
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        try:
            return json.loads(result["content"][0]["text"])
        except (KeyError, IndexError, json.JSONDecodeError):
            return {"raw": result}


# ----------------------------------------------------------------------
# 第二步：把 MCP 工具 schema 转成 GLM 函数调用格式
# ----------------------------------------------------------------------
def mcp_tools_to_openai(tools: list) -> list:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["inputSchema"],  # JSON Schema，直接兼容
            },
        }
        for tool in tools
    ]


# ----------------------------------------------------------------------
# 第三步：与模型对话，处理工具调用循环
# ----------------------------------------------------------------------
def ask_company_news(client: OpenAI, mcp: WindMCPClient, company: str) -> str:
    print(f"\n服务端可用工具: {[t['name'] for t in mcp.list_tools()]}")

    messages = [
        {
            "role": "system",
            "content": "你是财经资讯助手。用户给出一家上市公司，请调用 get_financial_news 工具"
                       "检索与该公司相关的财经新闻和市场评论，必要时可用 get_company_announcements "
                       "补充官方公告。回答必须基于工具返回的真实内容，归纳要点并注明新闻来源标题和日期，"
                       "不得编造。用简洁的中文回答。",
        },
        {"role": "user", "content": f"帮我查询上市公司「{company}」最近的财经新闻和市场评论"},
    ]

    for _ in range(5):
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=mcp_tools_to_openai(mcp.list_tools()),
            temperature=0.1,
        )
        msg = response.choices[0].message

        if not msg.tool_calls:
            return msg.content or "(模型没有返回内容)"

        messages.append(msg)  # 带 tool_calls 的助手消息必须加回历史

        for tool_call in msg.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments or "{}")
            print(f"  [模型请求调用] {fn_name}({fn_args})")

            try:
                result = mcp.call_tool(fn_name, fn_args)
            except Exception as exc:  # 工具报错也回传给模型，让它自行调整
                result = {"error": str(exc)}

            items = result.get("data", {}).get("items", [])
            print(f"  [工具返回] {len(items)} 条文档")
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": json.dumps(result, ensure_ascii=False),
                }
            )

    return "(达到工具调用轮次上限)"


def main() -> None:
    companies = sys.argv[1:] or ["贵州茅台"]
    mcp = WindMCPClient(api_key=_load_wind_api_key())

    zhipu_key = os.environ.get("ZHIPUAI_API_KEY", "").strip()
    if not zhipu_key:
        raise SystemExit("请先设置环境变量 ZHIPUAI_API_KEY（在 https://open.bigmodel.cn 获取）")
    client = OpenAI(api_key=zhipu_key, base_url=ZHIPU_BASE_URL)

    for company in companies:
        print(f"助手: {ask_company_news(client, mcp, company)}")


if __name__ == "__main__":
    main()
