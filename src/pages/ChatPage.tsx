import { useEffect, useRef, useState } from "react";
import { Button, Card, Input, Tag, MessagePlugin, Space } from "tdesign-react";
import { SendIcon } from "tdesign-icons-react";
import type { ChatMessage } from "../types";

const SESSION_ID = "housekeeper";

const SUGGESTIONS = [
  "帮我看看现在持仓整体情况",
  "把贵州茅台的持仓数量改成 800",
  "新增 1000 股宁德时代，成本价 180",
  "查一下金山办公最新行情",
];

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/chat/history?sessionId=${SESSION_ID}`)
      .then((r) => r.json())
      .then((rows: Array<{ role: string; content: string }>) =>
        setMessages(rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content })))
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const patchLastAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant") {
          next[i] = fn(next[i]);
          break;
        }
      }
      return next;
    });
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content }, { role: "assistant", content: "", tools: [] }]);
    setStreaming(true);
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, message: content }),
      });
      if (!resp.ok || !resp.body) throw new Error(`请求失败：${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let ev: any;
          try {
            ev = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (ev.type === "text" && ev.text) {
            patchLastAssistant((m) => ({ ...m, content: m.content ? m.content + "\n" + ev.text : ev.text }));
          } else if (ev.type === "tool" && ev.toolName) {
            patchLastAssistant((m) => ({ ...m, tools: [...(m.tools ?? []), ev.toolName] }));
          } else if (ev.type === "error") {
            patchLastAssistant((m) => ({
              ...m,
              content: m.content ? m.content + "\n\n" + ev.error : ev.error,
            }));
          }
        }
      }
    } catch (e: any) {
      MessagePlugin.error(e.message ?? "发送失败");
      patchLastAssistant((m) => ({ ...m, content: m.content || "（连接失败，请检查后端服务）" }));
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", height: "calc(100vh - 40px)", display: "flex", flexDirection: "column" }}>
      <h2 style={{ margin: "0 0 12px" }}>持仓管家</h2>
      <Card bordered style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }} bodyStyle={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div ref={listRef} style={{ flex: 1, overflow: "auto", padding: "8px 4px" }}>
          {messages.length === 0 && (
            <div style={{ color: "var(--td-text-color-secondary)", fontSize: 13 }}>
              <p>你好，我是持仓管家。可以帮你：</p>
              <ul style={{ lineHeight: 1.9 }}>
                <li>查询持仓概览（市值、浮动盈亏、权重、已实现盈亏）</li>
                <li>修改持仓数量 / 成本价 / 已实现盈亏，并汇报改前改后对比</li>
                <li>新增、删除持仓</li>
                <li>查询任意证券的实时行情</li>
              </ul>
              <Space breakLine>
                {SUGGESTIONS.map((s) => (
                  <Tag key={s} variant="outline" theme="primary" style={{ cursor: "pointer" }} onClick={() => send(s)}>
                    {s}
                  </Tag>
                ))}
              </Space>
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                margin: "10px 0",
              }}
            >
              <div style={{ maxWidth: "78%" }}>
                <div className={m.role === "user" ? "chat-bubble-user" : "chat-bubble-assistant"}>
                  {m.content || (streaming && i === messages.length - 1 ? "正在思考…" : "")}
                </div>
                {m.tools && m.tools.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <Tag size="small" variant="outline" theme="default">
                      工具调用：{m.tools.join("、")}
                    </Tag>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, paddingTop: 12, borderTop: "1px solid var(--td-component-stroke)" }}>
          <Input
            value={input}
            placeholder="问点什么，例如：把卫宁健康成本价改成 8.3"
            onChange={(v) => setInput(String(v))}
            onEnter={() => send()}
            disabled={streaming}
          />
          <Button theme="primary" icon={<SendIcon />} loading={streaming} onClick={() => send()}>
            发送
          </Button>
        </div>
      </Card>
    </div>
  );
}
