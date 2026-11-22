import { useCallback, useMemo, useState } from "react";
import { Button, Dialog, MessagePlugin } from "tdesign-react";
import WindToolPage from "../components/WindToolPage";
import type { WindToolPageConfig } from "../components/WindToolPage";

const SECONDARY = "var(--td-text-color-secondary)";

/** 动态五组分组的展示定义 */
const GROUPS = [
  { key: "recentEvent", label: "近期事件" },
  { key: "announcement", label: "公告" },
  { key: "news", label: "新闻" },
  { key: "report", label: "机构研究观点" },
  { key: "meeting", label: "投资者交流" },
];

function pick(item: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = item[k];
    if (v !== null && v !== undefined && String(v).trim()) return String(v);
  }
  return "";
}

function clamp(v: string, n: number): string {
  return v.length > n ? v.slice(0, n) + "…" : v;
}

const TWO_LINE_CLAMP = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical" as const,
  overflow: "hidden",
};

/** 单条动态行：标题/观点可点击弹窗查看全文，行内仅截断摘要（与「我的新闻」一致） */
function UpdateItemRow({
  item,
  groupLabel,
  onOpen,
}: {
  item: Record<string, unknown>;
  groupLabel: string;
  onOpen: (item: Record<string, unknown>, groupLabel: string) => void;
}) {
  const primary = clamp(pick(item, ["title", "viewpoint", "abstract", "content"]) || "（无标题）", 90);
  const date = pick(item, ["time", "announcementDate", "date", "publishDate"]);
  const source = String(item.source ?? "").trim();
  const abstract = pick(item, ["abstract", "content"]) || "";

  return (
    <div style={{ padding: "8px 0", borderBottom: "1px dashed var(--td-component-stroke)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          className="news-title-link"
          style={{ fontSize: 13 }}
          onClick={() => onOpen(item, groupLabel)}
          title="点击查看全文"
        >
          {primary}
        </span>
        {date && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: SECONDARY, whiteSpace: "nowrap" }}>
            {date}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: SECONDARY, marginTop: 4, ...TWO_LINE_CLAMP }}>
        {[
          source && `来源：${source}`,
          abstract && abstract !== primary ? abstract : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </div>
  );
}

function UpdatesView({
  data,
  onOpen,
}: {
  data: any;
  onOpen: (item: Record<string, unknown>, groupLabel: string) => void;
}) {
  const groups = GROUPS.map((g) => ({
    ...g,
    items: Array.isArray(data?.[g.key]) ? (data[g.key] as Array<Record<string, unknown>>) : [],
  })).filter((g) => g.items.length > 0);

  if (groups.length === 0) {
    return <div style={{ fontSize: 13, color: SECONDARY }}>近期无公司动态</div>;
  }

  return (
    <div>
      {groups.map((g) => (
        <div key={g.key} style={{ marginTop: g === groups[0] ? 0 : 12 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {g.label}（{g.items.length} 条）
          </div>
          {g.items.map((item, i) => (
            <UpdateItemRow key={i} item={item} groupLabel={g.label} onOpen={onOpen} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 弹窗正文：摘要与正文分开呈现，全文不截断 */
function DetailBody({ item }: { item: Record<string, unknown> }) {
  const abstract = pick(item, ["abstract"]).trim();
  const content = pick(item, ["content"]).trim();
  return (
    <div style={{ maxHeight: "62vh", overflowY: "auto" }}>
      {abstract && (!content || abstract !== content) && (
        <div style={{ marginBottom: content ? 14 : 0, lineHeight: 1.85 }}>{abstract}</div>
      )}
      {content && <div className="report-detail-content">{content}</div>}
      {!content && !abstract && <div style={{ color: SECONDARY }}>（无正文内容）</div>}
    </div>
  );
}

/** Wind 公司动态：万得 MCP stock_get_company_updates（事件/公告/新闻/机构观点/投资者交流），
 * 展现方式与「我的新闻」一致（分组 + 标题行 + 来源摘要），点击条目弹窗查看全文。 */
export default function WindUpdatesPage() {
  const [detail, setDetail] = useState<{ item: Record<string, unknown>; groupLabel: string } | null>(null);

  const config = useMemo<WindToolPageConfig>(
    () => ({
      title: "Wind 公司动态",
      apiUrl: "/api/wind-updates",
      refreshLabel: "刷新动态",
      emptyHint: "暂无公司动态（该次抓取失败，请刷新重试）",
      renderData: (data) => <UpdatesView data={data} onOpen={(item, groupLabel) => setDetail({ item, groupLabel })} />,
    }),
    []
  );

  const detailTitle = detail ? clamp(pick(detail.item, ["title", "viewpoint", "abstract", "content"]) || detail.groupLabel, 60) : "";
  const detailMeta = detail
    ? [
        pick(detail.item, ["time", "announcementDate", "date", "publishDate"]),
        pick(detail.item, ["source"]) && `来源：${pick(detail.item, ["source"])}`,
        detail.groupLabel,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const detailUrl = detail ? String(detail.item.url ?? "").trim() : "";

  return (
    <>
      <WindToolPage config={config} />
      <Dialog
        visible={detail !== null}
        onClose={() => setDetail(null)}
        header={detail ? detailTitle || "公司动态详情" : "公司动态详情"}
        width="760px"
        top="6vh"
        footer={
          <Button theme="primary" onClick={() => setDetail(null)}>
            关闭
          </Button>
        }
      >
        {detail && (
          <div>
            {detailMeta && (
              <div style={{ fontSize: 12, color: SECONDARY, marginBottom: 8 }}>{detailMeta}</div>
            )}
            {detailUrl && (
              <div style={{ fontSize: 12, marginBottom: 12 }}>
                原文链接：
                <a href={detailUrl} target="_blank" rel="noreferrer">
                  {detailUrl}
                </a>
              </div>
            )}
            <DetailBody item={detail.item} />
          </div>
        )}
      </Dialog>
    </>
  );
}
