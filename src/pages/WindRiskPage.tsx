import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import type { WindRiskEntry, WindRiskPayload, WindRiskTable } from "../types";

/** 通用风险指标表：列名由服务端 NL 动态生成（含窗口与单位） */
function RiskTable({ table }: { table: WindRiskTable }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>{table.category}</div>
      <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {table.columns.map((col, i) => (
              <th key={i} style={{ fontWeight: 500, color: "var(--td-text-color-secondary)", padding: "4px 10px 4px 0", textAlign: "left" }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((v, ci) => (
                <td key={ci} style={{ padding: "3px 10px 3px 0" }}>{v === null ? "--" : String(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RiskRow({
  entry,
  singleLoading,
  onRefreshOne,
}: {
  entry: WindRiskEntry;
  singleLoading: boolean;
  onRefreshOne: (code: string) => void;
}) {
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
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
      {entry.tables.length > 0 ? (
        <div>
          {entry.tables.map((t, i) => (
            <RiskTable key={i} table={t} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          暂无风险指标（该标的可能无数据，或该次抓取失败，请刷新重试）
          {entry.error && <div style={{ color: "var(--td-error-color-6)", marginTop: 2 }}>{entry.error}</div>}
        </div>
      )}
    </div>
  );
}

/** Wind 风险指标：每只持仓展示万得 MCP 的定量风险指标（get_risk_metrics，
 * 系统性风险/收益质量/波动与损失三类，金融工程口径，过去 1 年窗口）。
 * 页面加载优先读当日快照（缺失持仓仅补抓）；刷新强制实时抓取；可选日期读历史快照。 */
export default function WindRiskPage() {
  const [data, setData] = useState<WindRiskPayload | null>(null);
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
      ? `/api/wind-risk?date=${encodeURIComponent(d)}`
      : force
        ? "/api/wind-risk?force=1"
        : "/api/wind-risk";
    setLoading(true);
    try {
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
      if (seq === seqRef.current) {
        MessagePlugin.error(`Wind 风险指标刷新失败：${e.message}`);
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
      const r = await fetch(`/api/wind-risk?code=${encodeURIComponent(code)}`);
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
        MessagePlugin.success("已单独刷新该股票指标");
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
          <h2 style={{ margin: 0 }}>Wind 风险指标</h2>
          {selectedDate ? (
            <span style={{ fontSize: 12, color: "var(--td-brand-color)" }}>
              正在查看 {selectedDate} 的历史快照（来自本地数据库）
            </span>
          ) : data?.fromDb ? (
            data.isHistorical ? (
              <span style={{ fontSize: 12, color: "#e37318" }}>
                正在展示 {data.snapshotDate} 的历史数据，如需最新数据请点击「刷新指标」
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
            刷新指标
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
              未找到 WIND_API_KEY。两种配置方式（二选一）后点击「刷新指标」：
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
        <Card bordered title={`${data.fromDb ? `${data.date} ` : ""}持仓 Wind 风险指标（${data.items.length} 只，过去 1 年窗口）`}>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => (
              <RiskRow
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
