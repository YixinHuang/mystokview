import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import { fmtPct } from "../utils";
import type { WindConsensusData, WindConsensusEntry, WindConsensusPayload } from "../types";

/** 一致评级 → 涨红跌绿样式 */
function ratingClass(rating: string | null): string {
  if (!rating) return "flat";
  if (/买入|增持|推荐|强烈/.test(rating)) return "up";
  if (/卖出|减持|回避/.test(rating)) return "down";
  return "flat";
}

const METRICS: Array<{ suffix: string; label: string }> = [
  { suffix: "营业收入", label: "营业收入（百万元）" },
  { suffix: "营业收入同比增长率(%)", label: "营收同比" },
  { suffix: "归母净利润", label: "归母净利润（百万元）" },
  { suffix: "归母净利润同比增长率(%)", label: "净利同比" },
  { suffix: "EPS", label: "EPS（元）" },
  { suffix: "ROE(%)", label: "ROE" },
  { suffix: "PE", label: "PE（倍）" },
];

function forecastYears(fc: Record<string, string | number>): string[] {
  const years = new Set<string>();
  for (const k of Object.keys(fc)) {
    const m = k.match(/^(\d{4})年/);
    if (m) years.add(m[1]);
  }
  return [...years].sort();
}

function forecastCell(fc: Record<string, string | number>, year: string, suffix: string): string {
  const v = fc[`${year}年${suffix}`] ?? fc[`${year}年预测${suffix}`];
  return v === undefined ? "--" : String(v);
}

function ForecastTable({ fc }: { fc: Record<string, string | number> }) {
  const years = forecastYears(fc);
  return (
    <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left", fontWeight: 500, color: "var(--td-text-color-secondary)", padding: "4px 8px 4px 0" }}>一致预测</th>
          {years.map((y) => (
            <th key={y} style={{ fontWeight: 500, color: "var(--td-text-color-secondary)", padding: 4 }}>{y}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {METRICS.map((m) => (
          <tr key={m.suffix}>
            <td style={{ color: "var(--td-text-color-secondary)", padding: "3px 8px 3px 0" }}>{m.label}</td>
            {years.map((y) => (
              <td key={y} style={{ textAlign: "center", padding: 4 }}>{forecastCell(fc, y, m.suffix)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DetailList({ details }: { details: Array<Record<string, unknown>> }) {
  return (
    <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", lineHeight: 1.9 }}>
      {details.map((d, i) => {
        const target = d["目标价"];
        const prevTarget = d["前次目标价"];
        // 先确认可转数字再比较：任一为非数字时 Number() 为 NaN，NaN !== NaN 恒真会误标调整方向
        const tgtNum = Number(target);
        const prevNum = Number(prevTarget);
        const chg = target !== undefined && prevTarget !== undefined && Number.isFinite(tgtNum) && Number.isFinite(prevNum) && prevNum !== tgtNum
          ? `（前次 ${prevTarget}，${tgtNum < prevNum ? "下调" : "上调"}）`
          : "";
        return (
          <div key={i}>
            {String(d["日期"] ?? "")} · {String(d["研究机构"] ?? "")} {String(d["研究员"] ?? "")} ·{" "}
            <span className={ratingClass(String(d["评级"] ?? ""))}>{String(d["评级"] ?? "")}</span>
            {target !== undefined && ` · 目标价 ${String(target)}`}
            {chg && <span style={{ color: "var(--td-text-color-secondary)" }}>{chg}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ConsensusRow({
  entry,
  singleLoading,
  onRefreshOne,
}: {
  entry: WindConsensusEntry;
  singleLoading: boolean;
  onRefreshOne: (code: string) => void;
}) {
  const c = entry.consensus;
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
        {c && <Tag size="small" variant="outline" theme="primary">{c.wind_code}</Tag>}
        {c?.rating && (
          <span className={ratingClass(c.rating)} style={{ fontWeight: 600 }}>
            {c.rating}
          </span>
        )}
        <Button
          size="small"
          variant="outline"
          loading={singleLoading}
          onClick={() => onRefreshOne(entry.code)}
          style={{ marginLeft: "auto" }}
        >
          单独刷新
        </Button>
      </div>
      {c ? (
        <div>
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            一致目标价 <span style={{ fontWeight: 600 }}>{c.target_price ?? "--"}</span>
            <span style={{ color: "var(--td-text-color-secondary)" }}>
              （当前价 {c.current_price ?? "--"} · 上涨空间{" "}
              <span className={c.upside !== null ? (c.upside >= 0 ? "up" : "down") : ""}>
                {c.upside !== null ? fmtPct(c.upside) : "--"}
              </span>
              {" "}· {c.rating_count ?? "--"} 家机构评级）
            </span>
          </div>
          {c.forecast && Object.keys(c.forecast).length > 0 && (
            <div style={{ margin: "8px 0" }}>
              <ForecastTable fc={c.forecast} />
            </div>
          )}
          {c.details && c.details.length > 0 && (
            <div>
              <div style={{ margin: "6px 0 4px", fontWeight: 500 }}>最新评级明细（{c.details.length} 家）</div>
              <DetailList details={c.details} />
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          暂无一致预期（该标的可能无机构覆盖，或该次抓取失败，请刷新重试）
          {entry.error && <div style={{ color: "var(--td-error-color-6)", marginTop: 2 }}>{entry.error}</div>}
        </div>
      )}
    </div>
  );
}

/** Wind 一致预期：每只持仓展示万得 MCP 的机构一致预期（stock_get_company_earnings_estimate）。
 * 页面加载优先读当日快照（缺失持仓仅补抓）；右上角刷新强制实时抓取并更新当日快照；可选日期读历史快照。
 * 实时抓取较慢，用请求序号防慢返回覆盖。 */
export default function WindConsensusPage() {
  const [data, setData] = useState<WindConsensusPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [singleLoading, setSingleLoading] = useState<string | null>(null);
  const dateRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async (force = false) => {
    const seq = ++seqRef.current;
    setSingleLoading(null); // 单独刷新在途时接管：其响应将被 seq 守卫忽略
    const d = force ? null : dateRef.current; // 强制刷新总是回到当日实时数据
    const url = d
      ? `/api/wind-consensus?date=${encodeURIComponent(d)}`
      : force
        ? "/api/wind-consensus?force=1"
        : "/api/wind-consensus";
    setLoading(true);
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "请求失败");
      if (j.error) MessagePlugin.warning(j.error);
      if (mounted.current && seq === seqRef.current) {
        setData(j);
        if (force) {
          // 规则 3：强刷成功即回到当日视图，清空日期选择（否则副标题仍停留在历史快照提示）
          dateRef.current = null;
          setSelectedDate(null);
        }
        if (!j.fromDb) {
          setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        }
      }
    } catch (e: any) {
      if (seq === seqRef.current) {
        MessagePlugin.error(`Wind 一致预期刷新失败：${e.message}`);
      }
    } finally {
      if (mounted.current && seq === seqRef.current) setLoading(false);
    }
  }, []);

  /** 单独刷新一只股票：实时抓取并合并落库（当日记录优先、其余持仓从最近日期记录补底） */
  const refreshOne = useCallback(async (code: string) => {
    const seq = ++seqRef.current;
    setLoading(false); // 全量刷新在途时接管：其响应将被 seq 守卫忽略
    setSingleLoading(code);
    try {
      const r = await fetch(`/api/wind-consensus?code=${encodeURIComponent(code)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "请求失败");
      // configMissing 响应不含列表数据：仅提示，保留当前视图与日期选择
      if (j.configMissing) {
        MessagePlugin.warning("未找到万得 API Key，无法刷新");
        return;
      }
      if (j.refreshed?.noData) {
        MessagePlugin.warning(j.error ? `未查询到该股票的当日数据：${j.error}` : "未查询到该股票的当日数据");
      } else {
        MessagePlugin.success("已单独刷新该股票预期");
      }
      if (mounted.current && seq === seqRef.current) {
        setData(j);
        // 单独刷新写入的是当日数据（noData 时响应即最近日期快照视图）→ 清除历史选择
        dateRef.current = null;
        setSelectedDate(null);
        if (!j.fromDb && !j.refreshed?.noData) {
          setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        }
      }
    } catch (e: any) {
      if (seq === seqRef.current) {
        MessagePlugin.error(`单独刷新失败：${e.message}`);
      }
    } finally {
      if (mounted.current && seq === seqRef.current) setSingleLoading(null);
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
          <h2 style={{ margin: 0 }}>Wind 一致预期</h2>
          {selectedDate ? (
            <span style={{ fontSize: 12, color: "var(--td-brand-color)" }}>
              正在查看 {selectedDate} 的历史快照（来自本地数据库）
            </span>
          ) : data?.fromDb ? (
            data.isHistorical ? (
              <span style={{ fontSize: 12, color: "#e37318" }}>
                正在展示 {data.snapshotDate} 的历史数据，如需最新数据请点击「刷新预期」
              </span>
            ) : (
              <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>当日数据来自本地数据库</span>
            )
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
          <Button icon={<RefreshIcon />} loading={loading} onClick={() => refresh(true)}>
            刷新预期
          </Button>
        </Space>
      </div>

      {data && <SnapshotDateTags dates={data.availableDates} selected={selectedDate} onPick={pickDate} />}

      {data?.configMissing && (
        <Alert
          theme="warning"
          style={{ marginBottom: 16 }}
          title="需要配置万得 API Key"
          message={
            <div>
              未找到 WIND_API_KEY。两种配置方式（二选一）后点击「刷新预期」：
              <div style={{ marginTop: 4 }}>
                1. 设置环境变量 <code>WIND_API_KEY</code>（写入项目根目录 .env 亦可）；2. 在
                <code>~/.wind-aifinmarket/config</code> 中配置 <code>WIND_API_KEY=...</code>。
              </div>
            </div>
          }
        />
      )}

      {data && !data.configMissing && data.error && (
        <Alert theme="error" style={{ marginBottom: 16 }} title="万得 MCP 连接失败" message={data.error} />
      )}

      {data && (
        <Card bordered title={`${data.fromDb ? `${data.date} ` : ""}持仓 Wind 一致预期（${data.items.length} 只）`}>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => (
              <ConsensusRow
                key={e.code}
                entry={e}
                singleLoading={singleLoading === e.code}
                onRefreshOne={refreshOne}
              />
            ))
          )}
        </Card>
      )}
    </div>
  );
}
