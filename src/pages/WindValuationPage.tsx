import { useMemo } from "react";
import WindToolPage from "../components/WindToolPage";
import type { WindToolPageConfig } from "../components/WindToolPage";

const SECONDARY = "var(--td-text-color-secondary)";

/** 趋势字段长名 → 短列头（数据值全保留，仅列头缩写） */
const TREND_FIELD_LABELS: Record<string, string> = {
  "当前值": "当前值",
  "所处3年分位点(%)": "3年分位",
  "3年80%分位值": "3年80%分位",
  "3年20%分位值": "3年20%分位",
  "所处3年中位数": "3年中位",
  "所处5年分位点(%)": "5年分位",
  "5年80%分位值": "5年80%分位",
  "5年20%分位值": "5年20%分位",
  "所处5年中位数": "5年中位",
};

/** 当前估值：横向 stat 卡片 */
function StatGrid({ cur }: { cur: Record<string, unknown> }) {
  const entries = Object.entries(cur);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ background: "var(--td-bg-color-secondarycontainer)", borderRadius: 6, padding: "8px 4px", textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{v === null || v === undefined ? "--" : String(v)}</div>
          <div style={{ fontSize: 11, color: SECONDARY, marginTop: 2 }}>{k}</div>
        </div>
      ))}
    </div>
  );
}

/** 对象 → 转置表（行 = 键名，列 = 各字段并集），未知字段用原名 */
function transposeTable(block: Record<string, Record<string, unknown>>, labelCol: string) {
  const keys = Object.keys(block ?? {});
  if (keys.length === 0) return null;
  const fields: string[] = [];
  for (const k of keys) {
    for (const f of Object.keys(block[k] ?? {})) {
      if (!fields.includes(f)) fields.push(f);
    }
  }
  const rows = keys.map((k) => [
    k,
    ...fields.map((f) => {
      const v = block[k]?.[f];
      return v === null || v === undefined ? "--" : String(v);
    }),
  ]);
  return { columns: [labelCol, ...fields.map((f) => TREND_FIELD_LABELS[f] ?? f)], rows };
}

function CompactTable({ columns, rows, firstColBold }: { columns: string[]; rows: Array<Array<string>>; firstColBold?: boolean }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} style={{ fontWeight: 500, color: SECONDARY, padding: "3px 8px 3px 0", textAlign: i === 0 ? "left" : "center", whiteSpace: "nowrap" }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((v, ci) => (
                <td key={ci} style={{ padding: "2px 8px 2px 0", textAlign: ci === 0 ? "left" : "center", fontWeight: firstColBold && ci === 0 ? 600 : 400, whiteSpace: "nowrap" }}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 估值数据专用紧凑布局：当前估值卡片 + 趋势/相对估值转置表 + 可比公司两栏网格 */
function ValuationView({ data }: { data: any }) {
  if (!data || typeof data !== "object") return null;
  const cur = (data["自身当前估值"] ?? {}) as Record<string, unknown>;
  const trend = (data["自身估值趋势分析"] ?? {}) as Record<string, Record<string, unknown>>;
  const compList = data["可比公司"]?.["可比公司列表"];
  const rel = (data["可比公司相对估值分析"] ?? null) as Record<string, Record<string, unknown>> | null;
  const note = String(data["注释"] ?? "").trim();

  const trendTable = transposeTable(trend, "指标");
  const relTable = rel ? transposeTable(rel, "指标") : null;

  return (
    <div>
      <div style={{ fontSize: 11, color: SECONDARY, marginBottom: 10, display: "flex", gap: 12, alignItems: "center" }}>
        <span style={{ whiteSpace: "nowrap" }}>{data.tool ?? ""} · {data.windCode ?? ""}</span>
        {note && (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={note}>
            口径：{note}
          </span>
        )}
      </div>

      <div style={{ fontWeight: 500, marginBottom: 6 }}>当前估值</div>
      <StatGrid cur={cur} />

      {trendTable && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>估值趋势（分位点越低越接近历史低位）</div>
          <CompactTable columns={trendTable.columns} rows={trendTable.rows} />
        </div>
      )}

      {Array.isArray(compList) && compList.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>可比公司（{compList.length} 家）</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "4px 24px" }}>
            {compList.map((c: any, i: number) => (
              <div key={i} style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "baseline" }}>
                <span>{String(c["证券简称"] ?? "--")}</span>
                <span style={{ color: SECONDARY, fontSize: 11 }}>{String(c.windCode ?? "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {relTable && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>可比公司相对估值分析</div>
          <CompactTable columns={relTable.columns} rows={relTable.rows} />
        </div>
      )}
    </div>
  );
}

/** Wind 估值：万得 MCP stock_get_company_valuation（当前估值/估值趋势/可比公司相对估值），
 * 专用紧凑布局保证单公司估值数据一屏呈现。 */
export default function WindValuationPage() {
  // config 必须 memo：页面常驻仅 display 切换，App 任意菜单切换都会重渲染本页，
  // 未 memo 会导致 refresh 重建 → useEffect 重跑 → 每次切菜单重复请求
  const config = useMemo<WindToolPageConfig>(
    () => ({
      title: "Wind 估值",
      apiUrl: "/api/wind-valuation",
      refreshLabel: "刷新估值",
      emptyHint: "暂无估值数据（该标的可能无机构覆盖，或该次抓取失败，请刷新重试）",
      renderData: (data) => <ValuationView data={data} />,
    }),
    []
  );
  return <WindToolPage config={config} />;
}
