import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import { SnapshotDatePicker, SnapshotDateTags } from "./snapshot";
import JsonView from "./JsonView";
import type { WindToolEntry, WindToolPayload } from "../types";

const SECONDARY = "var(--td-text-color-secondary)";

export interface WindToolPageConfig {
  title: string;
  apiUrl: string; // 无参数时即按此地址请求（数据存储规则在后端）
  refreshLabel: string;
  emptyHint: string;
  /** 自定义行内数据渲染（不传则用 JsonView 通用渲染） */
  renderData?: (data: any) => ReactNode;
}

function ToolRow({
  entry,
  emptyHint,
  renderData,
  singleLoading,
  onRefreshOne,
}: {
  entry: WindToolEntry;
  emptyHint: string;
  renderData?: (data: any) => ReactNode;
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
      {entry.data !== null && entry.data !== undefined ? (
        renderData ? (
          renderData(entry.data)
        ) : (
          <JsonView data={entry.data} />
        )
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          {emptyHint}
          {entry.error && <div style={{ color: "var(--td-error-color-6)", marginTop: 2 }}>{entry.error}</div>}
        </div>
      )}
    </div>
  );
}

/** Wind 通用工具页：最近日期优先快照 + force 强刷 + ?date= 历史回看 + ?code= 单股票单独刷新。
 * 数据为 NL 工具返回的异构 JSON，用 JsonView 通用渲染。 */
export default function WindToolPage({ config }: { config: WindToolPageConfig }) {
  const [data, setData] = useState<WindToolPayload | null>(null);
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
      ? `${config.apiUrl}?date=${encodeURIComponent(d)}`
      : force
        ? `${config.apiUrl}?force=1`
        : config.apiUrl;
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
        MessagePlugin.error(`${config.title}刷新失败：${e.message}`);
      }
    } finally {
      if (mounted.current && seq === seqRef.current) setLoading(false);
    }
  }, [config]);

  /** 单独刷新一只股票：实时抓取并合并落库（当日记录优先、其余持仓从最近日期记录补底） */
  const refreshOne = useCallback(async (code: string) => {
    const seq = ++seqRef.current;
    setLoading(false); // 全量刷新在途时接管：其响应将被 seq 守卫忽略
    setSingleLoading(code);
    try {
      const r = await fetch(`${config.apiUrl}?code=${encodeURIComponent(code)}`);
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
        MessagePlugin.success("已单独刷新该股票数据");
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
  }, [config]);

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
          <h2 style={{ margin: 0 }}>{config.title}</h2>
          {selectedDate ? (
            <span style={{ fontSize: 12, color: "var(--td-brand-color)" }}>
              正在查看 {selectedDate} 的历史快照（来自本地数据库）
            </span>
          ) : data?.fromDb ? (
            data.isHistorical ? (
              <span style={{ fontSize: 12, color: "#e37318" }}>
                正在展示 {data.snapshotDate} 的历史数据，如需最新数据请点击「{config.refreshLabel}」
              </span>
            ) : (
              <span style={{ fontSize: 12, color: SECONDARY }}>当日数据来自本地数据库</span>
            )
          ) : (
            lastRefresh && (
              <span style={{ fontSize: 12, color: SECONDARY }}>
                上次刷新 {lastRefresh}
              </span>
            )
          )}
        </div>
        <Space>
          <SnapshotDatePicker value={selectedDate} onChange={pickDate} />
          <Button icon={<RefreshIcon />} loading={loading} onClick={() => refresh(true)}>
            {config.refreshLabel}
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
              未找到 WIND_API_KEY。两种配置方式（二选一）后点击「{config.refreshLabel}」：
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
        <Card bordered title={`${data.fromDb ? `${data.date} ` : ""}${config.title}（${data.items.length} 只）`}>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => (
              <ToolRow
                key={e.code}
                entry={e}
                emptyHint={config.emptyHint}
                renderData={config.renderData}
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
