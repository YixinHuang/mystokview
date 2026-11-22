import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Dialog, Loading, Space, Tag, MessagePlugin } from "tdesign-react";
import { RefreshIcon } from "tdesign-icons-react";
import AuthBanner from "../components/AuthBanner";
import { SnapshotDatePicker, SnapshotDateTags, toSnapshotDate } from "../components/snapshot";
import type { NewsDetail, NewsEntry, NewsItem, NewsPayload } from "../types";

function NewsRow({ entry, onOpen }: { entry: NewsEntry; onOpen: (item: NewsItem) => void }) {
  return (
    <div style={{ padding: "12px 4px", borderBottom: "1px solid var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{entry.name}</span>
        <Tag size="small" variant="outline">{entry.code}</Tag>
        {entry.news?.time && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--td-text-color-secondary)" }}>
            {entry.news.time}
          </span>
        )}
      </div>
      {entry.news ? (
        <div>
          <span
            className="news-title-link"
            onClick={() => onOpen(entry.news!)}
          >
            {entry.news.title}
          </span>
          <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", marginTop: 4 }}>
            来源：{entry.news.src || "未知"}
            {entry.news.summary && ` · ${entry.news.summary}`}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)" }}>暂无最新资讯</div>
      )}
    </div>
  );
}

/** 我的新闻：每只持仓展示一条最新新闻（westock news list），点击弹窗查看详情（westock news detail）。
 * 实时抓取按抓取当日持久化到 SQLite，可选日期读取历史快照。 */
export default function NewsPage() {
  const [data, setData] = useState<NewsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<NewsDetail | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const dateRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    const d = dateRef.current;
    setLoading(true);
    try {
      const url = d ? `/api/news?date=${encodeURIComponent(d)}` : "/api/news";
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
      MessagePlugin.error(`新闻刷新失败：${e.message}`);
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

  const openDetail = useCallback(async (item: NewsItem) => {
    if (!item.id) {
      MessagePlugin.warning("该新闻缺少详情 ID，无法查看");
      return;
    }
    setDetailVisible(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await fetch(`/api/news/detail?id=${encodeURIComponent(item.id)}`);
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
          <h2 style={{ margin: 0 }}>我的新闻</h2>
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
            刷新新闻
          </Button>
        </Space>
      </div>

      {data && <SnapshotDateTags dates={data.availableDates} selected={selectedDate} onPick={pickDate} />}

      {data && data.fromDb && data.items.every((i) => !i.news) && (
        <div style={{ marginBottom: 12, fontSize: 13, color: "var(--td-text-color-secondary)" }}>
          {selectedDate} 暂无历史快照，可从上方「历史快照」标签切换到已有数据的日期，或清除日期后刷新实时数据。
        </div>
      )}

      {data?.authRequired && (
        <AuthBanner
          authUrl={data.authUrl}
          stale={false}
          onDone={() => refresh()}
          title="资讯服务需要授权"
          description="westock 资讯服务未授权，暂时无法获取持仓新闻。完成授权后点击「刷新新闻」即可恢复。"
        />
      )}

      {data && (
        <Card bordered title={`${data.fromDb ? `${data.date} ` : ""}持仓资讯（${data.items.length} 只）`}>
          {data.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", padding: "8px 0" }}>
              暂无持仓，请先在「我的持仓」页新增。
            </div>
          ) : (
            data.items.map((e) => <NewsRow key={e.code} entry={e} onOpen={openDetail} />)
          )}
        </Card>
      )}

      <Dialog
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        header={detail?.title ?? "新闻详情"}
        width="760px"
        top="6vh"
        footer={<Button theme="primary" onClick={() => setDetailVisible(false)}>关闭</Button>}
      >
        {detailLoading ? (
          <div style={{ padding: "56px 0", textAlign: "center" }}>
            <Loading loading text="正在获取新闻详情..." size="small" />
          </div>
        ) : detail ? (
          <div>
            {(detail.time || detail.src) && (
              <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", marginBottom: 12 }}>
                {detail.time}
                {detail.src && ` · 来源：${detail.src}`}
              </div>
            )}
            <div
              className="news-detail-content"
              dangerouslySetInnerHTML={{ __html: detail.content }}
            />
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
