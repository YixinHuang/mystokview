import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Dialog, Loading, MessagePlugin, Space, Tag } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import AuthBanner from "../components/AuthBanner";
import { SnapshotDatePicker, SnapshotDateTags } from "../components/snapshot";
import { pnlClass } from "../utils";
import type { ReportDetail, ReportEntry, ReportItem, ReportsPayload } from "../types";

/** 投资评级 → 涨红跌绿样式（买入/增持红、卖出/减持绿、其余灰） */
function tzpjClass(tzpj: string): string {
  if (/买入|增持|推荐|强烈/.test(tzpj)) return "up";
  if (/卖出|减持|回避/.test(tzpj)) return "down";
  return "flat";
}

function ReportListRow({ item, onOpen }: { item: ReportItem; onOpen: (item: ReportItem) => void }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px dashed var(--td-component-stroke)" }}>
      <span
        className="news-title-link"
        style={{ fontSize: 13 }}
        onClick={() => onOpen(item)}
      >
        {item.title}
      </span>
      <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", marginTop: 4 }}>
        {item.time}
        {item.type_str && ` · ${item.type_str}`}
        {item.tzpj && (
          <>
            {" · 评级 "}
            <span className={tzpjClass(item.tzpj)}>{item.tzpj}</span>
          </>
        )}
      </div>
    </div>
  );
}

function HoldingReports({ entry, onOpen }: { entry: ReportEntry; onOpen: (item: ReportItem) => void }) {
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
      </div>
      {entry.reports.length > 0 ? (
        <div>
          {entry.reports.map((r) => (
            <ReportListRow key={r.id} item={r} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>暂无研报</div>
      )}
    </div>
  );
}

/** 我的研报：每只持仓展示最新研报列表（westock report list），点击弹窗查看正文（westock report detail）。
 * 实时抓取按抓取当日持久化到 SQLite，可选日期读取历史快照。 */
export default function ReportsPage() {
  const [data, setData] = useState<ReportsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const dateRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    const d = dateRef.current;
    setLoading(true);
    try {
      const url = d ? `/api/reports?date=${encodeURIComponent(d)}` : "/api/reports";
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
      MessagePlugin.error(`研报刷新失败：${e.message}`);
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

  const openDetail = useCallback(async (item: ReportItem) => {
    if (!item.id) {
      MessagePlugin.warning("该研报缺少详情 ID，无法查看");
      return;
    }
    setDetailVisible(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await fetch(`/api/reports/detail?id=${encodeURIComponent(item.id)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "详情获取失败");
      if (mounted.current) setDetail(j);
    } catch (e: any) {
      MessagePlugin.error(`详情获取失败：${e.message}`);
      setDetailVisible(false);
    } finally {
      if (mounted.current) setDetailLoading(false);
    }
  }, []);

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>我的研报</h2>
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
            刷新研报
          </Button>
        </Space>
      </div>

      {data && <SnapshotDateTags dates={data.availableDates} selected={selectedDate} onPick={pickDate} />}

      {data && data.fromDb && data.items.every((i) => i.reports.length === 0) && (
        <div style={{ marginBottom: 12, fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          {selectedDate} 暂无历史快照，可从上方「历史快照」标签切换到已有数据的日期，或清除日期后刷新实时数据。
        </div>
      )}

      {data?.authRequired && (
        <AuthBanner
          authUrl={data.authUrl}
          stale={false}
          onDone={() => refresh()}
          title="研报服务需要授权"
          description="westock 研报服务未授权，暂时无法获取持仓研报。完成授权后点击「刷新研报」即可恢复。"
        />
      )}

      {data && (
        <Card bordered title={`${data.fromDb ? `${data.date} ` : ""}持仓研报（${data.items.length} 只）`}>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => <HoldingReports key={e.code} entry={e} onOpen={openDetail} />)
          )}
        </Card>
      )}

      <Dialog
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        header={detail?.title ?? "研报详情"}
        width="760px"
        top="6vh"
        footer={<Button theme="primary" onClick={() => setDetailVisible(false)}>关闭</Button>}
      >
        {detailLoading ? (
          <div style={{ padding: "56px 0", textAlign: "center" }}>
            <Loading loading text="正在获取研报详情..." size="small" />
          </div>
        ) : detail ? (
          <div>
            {(detail.date || detail.org) && (
              <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", marginBottom: 12 }}>
                {detail.date}
                {detail.publish_time && ` · 发布于 ${detail.publish_time}`}
                {detail.org && ` · 机构：${detail.org}`}
              </div>
            )}
            <div
              className="report-detail-content"
              style={{ maxHeight: "62vh", overflowY: "auto" }}
            >
              {detail.content}
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
