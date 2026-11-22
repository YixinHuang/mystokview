import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import AuthBanner from "../components/AuthBanner";
import MarginSection from "../components/MarginSection";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import { fmtAmount, fmtShares, fmtYi, pnlClass } from "../utils";
import type {
  FundFlowEntry,
  FundFlowPayload,
  FundFlowData,
  NorthHoldingData,
  ShortData,
  SouthHoldingData,
  TechSummary,
} from "../types";

/** 汇总评级 → 文案与涨红跌绿样式 */
function ratingMeta(rating: TechSummary["rating"]): { text: string; cls: string } {
  if (rating === "bull") return { text: "资金流入", cls: "up" };
  if (rating === "bear") return { text: "资金流出", cls: "down" };
  return { text: "持平", cls: "flat" };
}

/** 资金项：带符号着色（流入红、流出绿） */
function FlowItem({ label, value }: { label: string; value: number }) {
  return (
    <span>
      {label} <span className={pnlClass(value)}>{fmtYi(value)}</span>
    </span>
  );
}

const f2 = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "--" : n.toFixed(2));

/** 北向资金季度持仓（陆股通，A 股） */
function NorthHoldingSection({ n }: { n: NorthHoldingData }) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.9 }}>
      <span style={{ fontWeight: 500 }}>北向持仓（最新季度披露至 {n.disclose_end || "—"}）</span>
      <span style={{ color: "var(--td-text-color-secondary)" }}>
        ：持股比例 {f2(n.holding_ratio)}% · 市值 {fmtAmount(n.holding_cap)} · {fmtShares(n.hold_shares)}
        {n.cap_chg_q !== null && (
          <>
            {" · 环比 "}
            <span className={pnlClass(n.cap_chg_q)}>{fmtAmount(n.cap_chg_q)}</span>
          </>
        )}
        {n.cap_chg_y !== null && (
          <>
            {" · 同比 "}
            <span className={pnlClass(n.cap_chg_y)}>{fmtAmount(n.cap_chg_y)}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** 港股/美股卖空数据 */
function ShortSection({ s }: { s: ShortData }) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.9 }}>
      <span style={{ fontWeight: 500 }}>卖空（{s.date}）</span>
      <span style={{ color: "var(--td-text-color-secondary)" }}>
        ：卖空 {fmtShares(s.short_shares)} · {fmtAmount(s.short_amount)}
        {s.short_ratio !== null && ` · 占比 ${s.short_ratio.toFixed(2)}%`}
        {s.close_price !== null && `（收盘 ${s.close_price}）`}
      </span>
    </div>
  );
}

/** 港股通南下资金持仓 */
function SouthHoldingSection({ s }: { s: SouthHoldingData }) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.9 }}>
      <span style={{ fontWeight: 500 }}>南下持仓（{s.date}）</span>
      <span style={{ color: "var(--td-text-color-secondary)" }}>
        ：持股比例 {f2(s.hold_ratio)}% · {fmtShares(s.hold_shares)}
        {s.cap_chg_daily !== null && (
          <>
            {" · 日市值变动 "}
            <span className={pnlClass(s.cap_chg_daily)}>{fmtAmount(s.cap_chg_daily)}</span>
          </>
        )}
        {s.cap_chg_quarterly !== null && (
          <>
            {" · 季度市值变动 "}
            <span className={pnlClass(s.cap_chg_quarterly)}>{fmtAmount(s.cap_chg_quarterly)}</span>
          </>
        )}
      </span>
    </div>
  );
}

function FlowRow({ entry }: { entry: FundFlowEntry }) {
  const rating = entry.summary ? ratingMeta(entry.summary.rating) : null;
  const f: FundFlowData | null = entry.flow;
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
        {f && (
          <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>
            {f.date && `截至 ${f.date}`}
          </span>
        )}
        {rating && (
          <span className={rating.cls} style={{ marginLeft: "auto", fontWeight: 600 }}>
            {rating.text}
          </span>
        )}
      </div>
      {f || entry.margin || entry.north || entry.short || entry.south ? (
        <div>
          {f && (
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              <div>
                <FlowItem label="当日主力净流入" value={f.main_net} />
                <span style={{ color: "var(--td-text-color-secondary)" }}>　·　</span>
                <FlowItem label="超大单" value={f.jumbo_net} />
                <span style={{ color: "var(--td-text-color-secondary)" }}>　·　</span>
                <FlowItem label="大单" value={f.block_net} />
                <span style={{ color: "var(--td-text-color-secondary)" }}>　·　</span>
                <FlowItem label="中单" value={f.mid_net} />
                <span style={{ color: "var(--td-text-color-secondary)" }}>　·　</span>
                <FlowItem label="小单" value={f.small_net} />
              </div>
              <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>
                <FlowItem label="5 日主力净流入" value={f.main_net_5d} />
                <span>　·　</span>
                <FlowItem label="10 日" value={f.main_net_10d} />
                <span>　·　</span>
                <FlowItem label="20 日" value={f.main_net_20d} />
                <span>　·　主力流入 {fmtYi(f.main_in)} / 流出 {fmtYi(f.main_out)}</span>
              </div>
            </div>
          )}
          {entry.margin && <MarginSection m={entry.margin} />}
          {entry.north && <NorthHoldingSection n={entry.north} />}
          {entry.short && <ShortSection s={entry.short} />}
          {entry.south && <SouthHoldingSection s={entry.south} />}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          暂无资金类数据
        </div>
      )}
    </div>
  );
}

/** 资金流向：每只持仓展示个股资金流向（westock fund flow）+ 融资融券（A 股）+ 北向持仓（A 股）
 * + 卖空与南下持仓（港股）。实时抓取按抓取当日持久化到 SQLite，可选日期读取历史快照。 */
export default function FundFlowPage() {
  const [data, setData] = useState<FundFlowPayload | null>(null);
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
      const url = d ? `/api/fund-flow?date=${encodeURIComponent(d)}` : "/api/fund-flow";
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
      MessagePlugin.error(`资金流向刷新失败：${e.message}`);
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
          <h2 style={{ margin: 0 }}>资金流向</h2>
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
            刷新资金
          </Button>
        </Space>
      </div>

      {data && <SnapshotDateTags dates={data.availableDates} selected={selectedDate} onPick={pickDate} />}

      {data && data.fromDb && data.items.every((i) => !i.flow && !i.margin && !i.north && !i.short && !i.south) && (
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
          description="westock 资金数据服务未授权，暂时无法获取资金流向。完成授权后点击「刷新资金」即可恢复。"
        />
      )}

      {data && (
        <Card bordered title={
          <span>
            {data.fromDb ? `${data.date} ` : ""}持仓资金流向（{data.summary.total} 只）
            <span style={{ marginLeft: 16, fontSize: 13, fontWeight: 400 }}>
              汇总：
              <span className="up" style={{ marginLeft: 4 }}>流入 {data.summary.inflow}</span>
              <span className="flat" style={{ margin: "0 4px" }}>·</span>
              <span className="down">流出 {data.summary.outflow}</span>
            </span>
          </span>
        }>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => <FlowRow key={e.code} entry={e} />)
          )}
        </Card>
      )}
    </div>
  );
}
