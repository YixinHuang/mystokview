import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import type { WindDoc, WindNewsEntry, WindNewsPayload } from "../types";

/** 单条文档：标题可点击跳原文，content 截两行摘要 */
function WindDocRow({ doc }: { doc: WindDoc }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px dashed var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        {doc.url ? (
          <a href={doc.url} target="_blank" rel="noreferrer" className="news-title-link" style={{ fontSize: 13 }}>
            {doc.title}
          </a>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 500 }}>{doc.title}</span>
        )}
        {doc.date && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--td-text-color-secondary)", whiteSpace: "nowrap" }}>
            {doc.date}
          </span>
        )}
      </div>
      {doc.content && (
        <div
          style={{
            fontSize: 12,
            color: "var(--td-text-color-secondary)",
            marginTop: 4,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {doc.content}
        </div>
      )}
    </div>
  );
}

function HoldingWindNews({
  entry,
  refreshing,
  onRefreshOne,
}: {
  entry: WindNewsEntry;
  refreshing: boolean;
  onRefreshOne: (code: string) => void;
}) {
  const hasData = entry.news.length > 0 || entry.announcements.length > 0;
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
        <Button
          size="small"
          variant="outline"
          loading={refreshing}
          onClick={() => onRefreshOne(entry.code)}
          style={{ marginLeft: "auto" }}
        >
          单独刷新
        </Button>
      </div>
      {hasData ? (
        <div>
          <div style={{ margin: "6px 0 4px", fontWeight: 500 }}>财经新闻 / 市场评论（{entry.news.length} 条）</div>
          {entry.news.length > 0 ? (
            entry.news.map((d, i) => <WindDocRow key={`n-${i}`} doc={d} />)
          ) : (
            <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>暂无</div>
          )}
          <div style={{ margin: "12px 0 4px", fontWeight: 500 }}>官方公告（{entry.announcements.length} 条）</div>
          {entry.announcements.length > 0 ? (
            entry.announcements.map((d, i) => <WindDocRow key={`a-${i}`} doc={d} />)
          ) : (
            <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>暂无</div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          暂无万得资讯（可能未配置 API Key 或该次抓取失败，请刷新重试）
        </div>
      )}
    </div>
  );
}

/** Wind 新闻：每只持仓展示万得 MCP 的财经新闻（get_financial_news）与官方公告（get_company_announcements）。
 * 页面加载优先读当日快照（缺失持仓仅补抓）；右上角刷新强制实时抓取并更新当日快照；可选日期读历史快照。
 * 实时抓取较慢（每只持仓 2 次 MCP 调用），用请求序号防止慢返回覆盖最新状态。 */
export default function WindNewsPage() {
  const [data, setData] = useState<WindNewsPayload | null>(null);
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
      ? `/api/wind-news?date=${encodeURIComponent(d)}`
      : force
        ? "/api/wind-news?force=1"
        : "/api/wind-news";
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
        MessagePlugin.error(`Wind 新闻刷新失败：${e.message}`);
      }
    } finally {
      if (mounted.current && seq === seqRef.current) setLoading(false);
    }
  }, []);

  /** 单独刷新一只股票：实时抓取并合并落库（当日记录优先，其余持仓从最近日期记录补齐） */
  const refreshOne = useCallback(async (code: string) => {
    const seq = ++seqRef.current;
    setLoading(false); // 全量刷新在途时接管：其响应将被 seq 守卫忽略
    setSingleLoading(code);
    try {
      const r = await fetch(`/api/wind-news?code=${encodeURIComponent(code)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "请求失败");
      // configMissing 响应不含列表数据：仅提示，保留当前视图与日期选择
      if (j.configMissing) {
        MessagePlugin.warning("未找到万得 API Key，无法刷新");
        return;
      }
      if (j.refreshed?.noData) {
        MessagePlugin.warning("未查询到该股票的当日数据");
      } else {
        MessagePlugin.success("已单独刷新该股票资讯");
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
          <h2 style={{ margin: 0 }}>Wind 新闻</h2>
          {selectedDate ? (
            <span style={{ fontSize: 12, color: "var(--td-brand-color)" }}>
              正在查看 {selectedDate} 的历史快照（来自本地数据库）
            </span>
          ) : data?.fromDb ? (
            data.isHistorical ? (
              <span style={{ fontSize: 12, color: "#e37318" }}>
                正在展示 {data.snapshotDate} 的历史数据，如需最新数据请点击「刷新资讯」
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
            刷新资讯
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
              未找到 WIND_API_KEY。两种配置方式（二选一）后点击「刷新资讯」：
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
        <Card bordered title={`${data.fromDb ? `${data.date} ` : ""}持仓 Wind 资讯（${data.items.length} 只）`}>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => (
              <HoldingWindNews
                key={e.code}
                entry={e}
                refreshing={singleLoading === e.code}
                onRefreshOne={refreshOne}
              />
            ))
          )}
        </Card>
      )}
    </div>
  );
}
