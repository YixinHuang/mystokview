import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import AuthBanner from "../components/AuthBanner";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import { fmtMoney, fmtSigned } from "../utils";
import type { ConsensusEntry, ConsensusPayload, RatingData, ScoreInfo, ConsensusData, TechSummary } from "../types";

const f2 = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "--" : n.toFixed(2));

/** 汇总评级 → 文案与涨红跌绿样式 */
function ratingMeta(rating: TechSummary["rating"]): { text: string; cls: string } {
  if (rating === "bull") return { text: "偏多", cls: "up" };
  if (rating === "bear") return { text: "偏空", cls: "down" };
  return { text: "中性", cls: "flat" };
}

function ConsensusLine({ c, price }: { c: ConsensusData; price: number | null }) {
  const upside = price && price > 0 ? ((c.target_price - price) / price) * 100 : null;
  return (
    <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", lineHeight: 1.9 }}>
      一致预期（{c.year}E）：目标价 {f2(c.target_price)}
      {upside !== null && ` · 较现价空间 ${fmtSigned(upside)}%`} · EPS {f2(c.eps)} · PE {f2(c.pe)}
      · 营收增速 {f2(c.revenue_yoy)}% · 净利增速 {f2(c.profit_yoy)}%
    </div>
  );
}

function ScoreLine({ s }: { s: ScoreInfo }) {
  return (
    <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", lineHeight: 1.9 }}>
      股票评分：综合 {f2(s.comp.value)}（{s.comp.detail}）
      · 市值 {f2(s.cap.value)} · 基本面 {f2(s.funm.value)} · 风险 {f2(s.risk.value)} · 技术面 {f2(s.tec.value)}
    </div>
  );
}

function RatingLine({ r }: { r: RatingData }) {
  return (
    <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", lineHeight: 1.9 }}>
      机构评级：买入 {r.buy_cnt} / {r.total_cnt} 家 · 持有 {r.hold_cnt} · 卖出 {r.sell_cnt}
      {r.target_avg !== null && ` · 目标均价 ${f2(r.target_avg)}（现价 ${f2(r.current_price)}）`}
    </div>
  );
}

function ConsensusRow({ entry }: { entry: ConsensusEntry }) {
  const rating = entry.summary ? ratingMeta(entry.summary.rating) : null;
  const hasData = entry.consensus || entry.score || entry.rating;
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
        {entry.price !== null && (
          <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>
            现价 {fmtMoney(entry.price)}
          </span>
        )}
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
          {entry.consensus && <ConsensusLine c={entry.consensus} price={entry.price} />}
          {entry.score && <ScoreLine s={entry.score} />}
          {entry.rating && <RatingLine r={entry.rating} />}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          暂无研究数据（一致预期支持 A股/港股，机构评级支持港股/美股，评分仅 A股）
        </div>
      )}
    </div>
  );
}

/** 一致预期：每只持仓展示一致预期（consensus）+ 机构评级（rating）+ 股票评分（score）与汇总评级。
 * 实时抓取按抓取当日持久化到 SQLite，可选日期读取历史快照。 */
export default function ConsensusPage() {
  const [data, setData] = useState<ConsensusPayload | null>(null);
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
      const url = d ? `/api/consensus?date=${encodeURIComponent(d)}` : "/api/consensus";
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "请求失败");
      // westock 限频等非致命错误：数据可能不全，警告但仍渲染
      if (j.error) MessagePlugin.warning(j.error);
      if (mounted.current && seq === seqRef.current) {
        setData(j);
        if (!j.fromDb) {
          setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        }
      }
    } catch (e: any) {
      MessagePlugin.error(`一致预期刷新失败：${e.message}`);
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
          <h2 style={{ margin: 0 }}>一致预期</h2>
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
            刷新预期
          </Button>
        </Space>
      </div>

      {data && <SnapshotDateTags dates={data.availableDates} selected={selectedDate} onPick={pickDate} />}

      {data && data.fromDb && data.items.every((i) => !i.consensus && !i.rating && !i.score) && (
        <div style={{ marginBottom: 12, fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          {selectedDate} 暂无历史快照，可从上方「历史快照」标签切换到已有数据的日期，或清除日期后刷新实时数据。
        </div>
      )}

      {data?.authRequired && (
        <AuthBanner
          authUrl={data.authUrl}
          stale={false}
          onDone={() => refresh()}
          title="研究数据需要授权"
          description="westock 研究数据服务未授权，暂时无法获取一致预期与评分。完成授权后点击「刷新预期」即可恢复。"
        />
      )}

      {data && (
        <Card bordered title={
          <span>
            {data.fromDb ? `${data.date} ` : ""}持仓一致预期（{data.summary.total} 只）
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
            data.items.map((e) => <ConsensusRow key={e.code} entry={e} />)
          )}
        </Card>
      )}
    </div>
  );
}
