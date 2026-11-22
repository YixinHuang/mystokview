import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import type { WindMoneyFlowEntry, WindMoneyFlowPayload } from "../types";

/** 分块渲染顺序：用户关注的三个板块置前 */
const SECTION_ORDER = ["主力资金", "融资融券", "陆股通", "成交活跃度", "基金机构持仓", "十大流通股东变化"];

/** 通用分块表格（字段为表头，最近5日为行） */
function BlockTable({ fields, rows }: { fields: string[]; rows: any[][] }) {
  return (
    <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          {fields.map((f, i) => (
            <th key={i} style={{ fontWeight: 500, color: "var(--td-text-color-secondary)", padding: "4px 10px 4px 0", textAlign: "left" }}>
              {f}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((v, ci) => (
              <td key={ci} style={{ padding: "3px 10px 3px 0" }}>{v === null || v === undefined ? "--" : String(v)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 陆股通等扁平键值块 */
function KvBlock({ block }: { block: Record<string, any> }) {
  return (
    <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", lineHeight: 1.9 }}>
      {Object.entries(block).map(([k, v]) => (
        <div key={k}>
          {k}：<span style={{ color: "var(--td-text-color-primary)" }}>{String(v)}</span>
        </div>
      ))}
    </div>
  );
}

function SectionBlock({ name, block }: { name: string; block: Record<string, any> }) {
  const isTable = Array.isArray(block["字段"]) && Array.isArray(block["最近5日"]);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>{name}</div>
      {isTable ? (
        <BlockTable fields={block["字段"]} rows={block["最近5日"]} />
      ) : (
        <KvBlock block={block} />
      )}
    </div>
  );
}

function MoneyFlowRow({ entry }: { entry: WindMoneyFlowEntry }) {
  const m = entry.moneyflow;
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
        {m && (
          <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>
            交易日期 {m.trade_date} {m.trade_time && `· ${m.trade_time}`}
          </span>
        )}
      </div>
      {m ? (
        <div>
          {Object.entries(m.sections)
            .sort(([a], [b]) => {
              const ia = SECTION_ORDER.indexOf(a);
              const ib = SECTION_ORDER.indexOf(b);
              return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            })
            .map(([name, block]) => (
              <SectionBlock key={name} name={name} block={block} />
            ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          暂无 Wind 资金面数据（该次抓取失败，请刷新重试）
          {entry.error && <div style={{ color: "var(--td-error-color-6)", marginTop: 2 }}>{entry.error}</div>}
        </div>
      )}
    </div>
  );
}

/** Wind 资金流向：每只持仓展示万得 MCP 的资金面数据（stock_get_money_flow_analysis：
 * 主力资金、融资融券、陆股通北向持仓、成交活跃度等）。
 * 页面加载优先读当日快照（缺失持仓仅补抓）；刷新强制实时抓取；可选日期读历史快照。 */
export default function WindMoneyFlowPage() {
  const [data, setData] = useState<WindMoneyFlowPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const dateRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async (force = false) => {
    const seq = ++seqRef.current;
    const d = force ? null : dateRef.current; // 强制刷新总是回到当日实时数据
    const url = d
      ? `/api/wind-moneyflow?date=${encodeURIComponent(d)}`
      : force
        ? "/api/wind-moneyflow?force=1"
        : "/api/wind-moneyflow";
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
        MessagePlugin.error(`Wind 资金流向刷新失败：${e.message}`);
      }
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
          <h2 style={{ margin: 0 }}>Wind 资金流向</h2>
          {selectedDate ? (
            <span style={{ fontSize: 12, color: "var(--td-brand-color)" }}>
              正在查看 {selectedDate} 的历史快照（来自本地数据库）
            </span>
          ) : data?.fromDb ? (
            <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>
              当日数据来自本地数据库，点「刷新资金」可实时更新
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
          <Button icon={<RefreshIcon />} loading={loading} onClick={() => refresh(true)}>
            刷新资金
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
              未找到 WIND_API_KEY。两种配置方式（二选一）后点击「刷新资金」：
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
        <Card bordered title={`${data.fromDb ? `${data.date} ` : ""}持仓 Wind 资金流向（${data.items.length} 只）`}>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => <MoneyFlowRow key={e.code} entry={e} />)
          )}
        </Card>
      )}
    </div>
  );
}
