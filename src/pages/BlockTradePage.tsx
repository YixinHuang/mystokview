import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import AuthBanner from "../components/AuthBanner";
import MarginSection from "../components/MarginSection";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import { fmtAmount, fmtPct } from "../utils";
import type { BlockMarginEntry, BlockMarginPayload, BlockTradeData, TechSummary } from "../types";

/** 汇总评级 → 文案与涨红跌绿样式 */
function ratingMeta(rating: TechSummary["rating"]): { text: string; cls: string } {
  if (rating === "bull") return { text: "偏多", cls: "up" };
  if (rating === "bear") return { text: "偏空", cls: "down" };
  return { text: "中性", cls: "flat" };
}

function BlockSection({ b }: { b: BlockTradeData }) {
  const total = b.trades.reduce((s, t) => s + t.value, 0);
  return (
    <div style={{ fontSize: 13, lineHeight: 1.9 }}>
      <div>
        <span style={{ fontWeight: 500 }}>大宗交易（{b.date}）</span>
        <span style={{ color: "var(--td-text-color-secondary)" }}>
          ：{b.trades.length > 0 ? `成交 ${b.trades.length} 笔 · 合计 ${fmtAmount(total)}` : "当日无成交"}
          {b.close_price !== null && ` · 收盘 ${b.close_price}`}
        </span>
      </div>
      {b.trades.map((t, i) => (
        <div key={i} style={{ fontSize: 12, color: "var(--td-text-color-secondary)", paddingLeft: 12 }}>
          {t.date && `${t.date} · `}{t.type || "大宗交易"} · 成交价 {t.price ?? "--"} · {fmtAmount(t.value)} · 折溢价 {fmtPct(t.discount)}
          {t.buyer && ` · 买方 ${t.buyer}`}
          {t.seller && ` / 卖方 ${t.seller}`}
        </div>
      ))}
    </div>
  );
}

function BlockMarginRow({ entry }: { entry: BlockMarginEntry }) {
  const rating = entry.summary ? ratingMeta(entry.summary.rating) : null;
  const hasData = entry.block || entry.margin;
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
        {rating && (
          <span className={rating.cls} style={{ marginLeft: "auto", fontWeight: 600 }}>
            {rating.text}
          </span>
        )}
      </div>
      {hasData ? (
        <div>
          {entry.summary && (
            <ul style={{ margin: "4px 0 8px", paddingLeft: 18 }}>
              {entry.summary.signals.map((s, i) => (
                <li key={i} style={{ fontSize: 13, lineHeight: 1.8 }}>{s}</li>
              ))}
            </ul>
          )}
          {entry.block && <BlockSection b={entry.block} />}
          {entry.margin && <MarginSection m={entry.margin} />}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          暂无数据（大宗交易与融资融券仅支持 A 股个股）
        </div>
      )}
    </div>
  );
}

/** 大宗交易：每只持仓展示大宗交易明细（westock fund block）+ 融资融券（westock fund margin）与汇总。
 * 实时抓取按抓取当日持久化到 SQLite，可选日期读取历史快照。 */
export default function BlockTradePage() {
  const [data, setData] = useState<BlockMarginPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const dateRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    const d = dateRef.current;
    setLoading(true);
    try {
      const url = d ? `/api/block-margin?date=${encodeURIComponent(d)}` : "/api/block-margin";
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "请求失败");
      if (j.error) MessagePlugin.warning(j.error);
      if (mounted.current && seq === seqRef.current) {
        setData(j);
        if (!j.fromDb) {
          setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        }
      }
    } catch (e: any) {
      MessagePlugin.error(`大宗交易刷新失败：${e.message}`);
    } finally {
      if (mounted.current && seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const pickDate = useCallback(
    (v: string | null) => {
      dateRef.current = v;
      setSelectedDate(v);
      refresh();
    },
    [refresh]
  );

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>大宗交易</h2>
          {selectedDate ? (
            <span style={{ fontSize: 12, color: "var(--td-brand-color)" }}>
              正在查看 {selectedDate} 的历史快照（来自本地数据库）
            </span>
          ) : (
            lastRefresh && (
              <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>
                上次刷新 {lastRefresh}
              </span>
            )
          )}
        </div>
        <Space>
          <SnapshotDatePicker value={selectedDate} onChange={pickDate} />
          <Button icon={<RefreshIcon />} loading={loading} onClick={() => refresh()}>
            刷新数据
          </Button>
        </Space>
      </div>

      {data && <SnapshotDateTags dates={data.availableDates} selected={selectedDate} onPick={pickDate} />}

      {data && data.fromDb && data.items.every((i) => !i.block && !i.margin) && (
        <div style={{ marginBottom: 12, fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          {selectedDate} 暂无历史快照，可从上方「历史快照」标签切换到已有数据的日期，或清除日期后刷新实时数据。
        </div>
      )}

      {data?.authRequired && (
        <AuthBanner
          authUrl={data.authUrl}
          stale={false}
          onDone={() => refresh()}
          title="资金数据需要授权"
          description="westock 资金数据服务未授权，暂时无法获取大宗交易与融资融券。完成授权后点击「刷新数据」即可恢复。"
        />
      )}

      {data && (
        <Card bordered title={
          <span>
            {data.fromDb ? `${data.date} ` : ""}持仓大宗交易与两融（{data.summary.total} 只）
            <span style={{ marginLeft: 16, fontSize: 13, fontWeight: 400 }}>
              汇总：
              <span className="up" style={{ marginLeft: 4 }}>偏多 {data.summary.bull}</span>
              <span className="flat" style={{ margin: "0 4px" }}>· 中性 {data.summary.neutral}</span>
              <span className="down">· 偏空 {data.summary.bear}</span>
            </span>
          </span>
        }>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => <BlockMarginRow key={e.code} entry={e} />)
          )}
        </Card>
      )}
    </div>
  );
}
