import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import AuthBanner from "../components/AuthBanner";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import type { ChipAnalysis, TechnicalEntry, TechnicalPayload, TechIndicators, TechSummary } from "../types";

const f2 = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "--" : n.toFixed(2));

/** 汇总评级 → 文案与涨红跌绿样式 */
function ratingMeta(rating: TechSummary["rating"]): { text: string; cls: string } {
  if (rating === "bull") return { text: "偏多", cls: "up" };
  if (rating === "bear") return { text: "偏空", cls: "down" };
  return { text: "中性", cls: "flat" };
}

function IndicatorLine({ t }: { t: TechIndicators }) {
  return (
    <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", lineHeight: 1.9 }}>
      <div>
        MACD（DIF {f2(t.dif)} / DEA {f2(t.dea)} / 柱 {f2(t.macd)}）· KDJ（K {f2(t.kdj_k)} / D {f2(t.kdj_d)} / J {f2(t.kdj_j)}）
        · RSI（6 {f2(t.rsi6)} / 12 {f2(t.rsi12)} / 24 {f2(t.rsi24)}）
      </div>
      <div>
        均线 MA5 {f2(t.ma5)} / MA10 {f2(t.ma10)} / MA20 {f2(t.ma20)} / MA60 {f2(t.ma60)} / MA120 {f2(t.ma120)} / MA250 {f2(t.ma250)}
      </div>
      <div>
        布林（下轨 {f2(t.boll_lower)} · 中轨 {f2(t.boll_mid)} · 上轨 {f2(t.boll_upper)}）
      </div>
    </div>
  );
}

function ChipLine({ c, closePrice }: { c: ChipAnalysis; closePrice: number }) {
  const pos = closePrice >= c.avg_cost ? "上方" : "下方";
  return (
    <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", lineHeight: 1.9 }}>
      筹码：获利比例 {f2(c.profit_rate)}% · 平均成本 {f2(c.avg_cost)}（现价处于其{pos}）
      · 70% 集中度 {f2(c.concentration70)} / 90% 集中度 {f2(c.concentration90)}
    </div>
  );
}

function TechRow({ entry }: { entry: TechnicalEntry }) {
  const rating = entry.summary ? ratingMeta(entry.summary.rating) : null;
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
        {entry.tech && (
          <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>
            现价 {f2(entry.tech.close_price)} · {entry.tech.date}
          </span>
        )}
        {rating && (
          <span className={rating.cls} style={{ marginLeft: "auto", fontWeight: 600 }}>
            {rating.text}
          </span>
        )}
      </div>
      {entry.summary ? (
        <div>
          <ul style={{ margin: "4px 0 8px", paddingLeft: 18 }}>
            {entry.summary.signals.map((s, i) => (
              <li key={i} style={{ fontSize: 13, lineHeight: 1.8 }}>{s}</li>
            ))}
          </ul>
          <IndicatorLine t={entry.tech!} />
          {entry.chip && <ChipLine c={entry.chip} closePrice={entry.tech!.close_price} />}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>暂无技术指标数据</div>
      )}
    </div>
  );
}

/** 技术分析：每只持仓展示最新技术指标（westock technical）+ 筹码成本（westock chip）与汇总评级。
 * 实时抓取的结果按（代码, 指标日期）持久化到 SQLite；选择日期后改为读取本地历史快照。 */
export default function TechnicalPage() {
  const [data, setData] = useState<TechnicalPayload | null>(null);
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
      const url = d ? `/api/technical?date=${encodeURIComponent(d)}` : "/api/technical";
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "请求失败"); // 500 等错误必须拦下，否则 setData({error}) 会在渲染层崩溃
      // westock 限频等非致命错误（HTTP 200 + error 字段）：警告但仍渲染部分数据（与其他页面一致）
      if (j.error) MessagePlugin.warning(j.error);
      if (mounted.current && seq === seqRef.current) {
        setData(j);
        if (!j.fromDb) {
          setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        }
      }
    } catch (e: any) {
      MessagePlugin.error(`技术分析刷新失败：${e.message}`);
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
          <h2 style={{ margin: 0 }}>技术分析</h2>
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
            刷新分析
          </Button>
        </Space>
      </div>

      {data && <SnapshotDateTags dates={data.availableDates} selected={selectedDate} onPick={pickDate} />}

      {data?.authRequired && (
        <AuthBanner
          authUrl={data.authUrl}
          stale={false}
          onDone={() => refresh()}
          title="技术服务需要授权"
          description="westock 技术分析服务未授权，暂时无法获取技术指标与筹码数据。完成授权后点击「刷新分析」即可恢复。"
        />
      )}

      {data && data.fromDb && data.items.every((i) => !i.tech) && (
        <div style={{ marginBottom: 12, fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          {selectedDate} 暂无历史快照，可从上方「历史快照」标签切换到已有数据的日期，或清除日期后刷新实时数据。
        </div>
      )}

      {data && (
        <Card bordered title={
          <span>
            {data.fromDb ? `${data.date} 持仓技术分析` : `持仓技术分析`}（{data.summary.total} 只）
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
            data.items.map((e) => <TechRow key={e.code} entry={e} />)
          )}
        </Card>
      )}
    </div>
  );
}
