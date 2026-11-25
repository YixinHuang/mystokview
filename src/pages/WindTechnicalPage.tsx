import { useMemo } from "react";
import WindToolPage from "../components/WindToolPage";
import type { WindToolPageConfig } from "../components/WindToolPage";
import { pnlClass } from "../utils";

const SECONDARY = "var(--td-text-color-secondary)";
const fmt = (v: unknown) => {
  if (v === null || v === undefined) return "--";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  return String(v);
};
const fmtNum = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n.toFixed(2) : "--";
};
/** 技术特征对象 → 「键：值」说明文本（布尔转是/否） */
const fmtFeat = (v: unknown): string => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.entries(v)
      .map(([k, vv]) => `${k}：${typeof vv === "boolean" ? (vv ? "是" : "否") : String(vv)}`)
      .join(" · ");
  }
  return String(v ?? "").trim();
};

/** 关键价位扁平块 → 横向 stat 卡片 */
function LevelCards({ levels }: { levels: Record<string, unknown> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 8 }}>
      {Object.entries(levels).map(([k, v]) => (
        <div key={k} style={{ background: "var(--td-bg-color-secondarycontainer)", borderRadius: 6, padding: "6px 4px", textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{fmtNum(v)}</div>
          <div style={{ fontSize: 11, color: SECONDARY, marginTop: 2 }}>{k}</div>
        </div>
      ))}
    </div>
  );
}

/** 区间涨跌幅扁平块 → 横向着色 stat 行 */
function ChgRow({ chg }: { chg: Record<string, number> }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 12 }}>
      {Object.entries(chg).map(([k, v]) => (
        <span key={k}>
          <span style={{ color: SECONDARY }}>{k}　</span>
          <span className={pnlClass(v)}>{fmtNum(v)}%</span>
        </span>
      ))}
    </div>
  );
}

/** NL 表格块转置：行 = 字段（技术特征除外，单独成说明行），列 = 最近 5 日日期 */
function TechBlockTable({ block }: { block: Record<string, any> }) {
  const fields: string[] = block["字段"] ?? [];
  const rows5: any[][] = block["最近5日"] ?? [];
  if (fields.length === 0 || rows5.length === 0) return null;
  // 最近5日为行式存储：row[j] 对应 字段[j]（row[0] 即日期），转置时列头取全部日期、值直接按字段下标取
  const headers = rows5.map((r) => String(r[0] ?? ""));
  const bodyRows = fields
    .slice(1)
    .filter((f) => f !== "技术特征")
    .map((f) => {
      const fi = fields.indexOf(f);
      return {
        field: f,
        values: rows5.map((r) => fmt(r[fi])),
      };
    });
  const feat = fmtFeat(block["技术特征"]);
  return (
    <div>
      <table style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ fontWeight: 500, color: SECONDARY, padding: "3px 8px 3px 0", textAlign: "left" }}>{fields[0] ?? ""}</th>
            {headers.map((d, i) => (
              <th key={i} style={{ fontWeight: 500, color: SECONDARY, padding: "3px 8px", textAlign: "center" }}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((r, ri) => (
            <tr key={ri}>
              <td style={{ padding: "2px 8px 2px 0", color: SECONDARY, whiteSpace: "nowrap" }}>{r.field}</td>
              {r.values.map((v, vi) => (
                <td key={vi} style={{ padding: "2px 8px", textAlign: "center" }}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {feat && <div style={{ fontSize: 11, color: SECONDARY, marginTop: 2 }}>{feat}</div>}
    </div>
  );
}

/** 技术面数据专用紧凑布局：meta 行 + 区间涨跌幅/关键价位 stat + 三大组转置表两列排布 */
function TechView({ data }: { data: any }) {
  const zj = (data?.["技术面数据"] ?? null) as Record<string, any> | null;
  if (!zj || typeof zj !== "object") {
    return <div style={{ fontSize: 13, color: SECONDARY }}>暂无技术面数据</div>;
  }
  const meta = [
    zj["交易日期"] && `交易日期 ${zj["交易日期"]}`,
    zj["交易时间"],
    zj["复权方式"] && `复权：${zj["复权方式"]}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const chg = (zj["趋势分析"]?.["区间涨跌幅"] ?? null) as Record<string, number> | null;
  const levels = (zj["关键价位"] ?? null) as Record<string, number> | null;
  const groups = [
    { label: "趋势分析", keys: ["价格表现", "均线系统", "MACD", "OBV"], parent: zj["趋势分析"] },
    { label: "动能指标", keys: ["RSI", "KDJ", "CCI"], parent: zj["动能指标"] },
    { label: "波动与通道", keys: ["BOLL", "ATR"], parent: zj["波动与通道"] },
  ];

  return (
    <div>
      <div style={{ fontSize: 12, color: SECONDARY, marginBottom: 8 }}>{meta}</div>
      {chg && Object.keys(chg).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>区间涨跌幅</div>
          <ChgRow chg={chg} />
        </div>
      )}
      {levels && Object.keys(levels).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>关键价位</div>
          <LevelCards levels={levels} />
        </div>
      )}
      {groups.map((g) => {
        const blocks = g.keys.map((k) => ({ name: k, block: g.parent?.[k] ?? null })).filter((b) => b.block);
        if (blocks.length === 0) return null;
        return (
          <div key={g.label} style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>{g.label}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px 24px" }}>
              {blocks.map((b) => (
                <TechBlockTable key={b.name} block={b.block} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Wind 技术分析：万得 MCP stock_get_technical_analysis（趋势/动能/波动与通道/关键价位），
 * 专用紧凑布局保证单公司技术数据一屏呈现。 */
export default function WindTechnicalPage() {
  const config = useMemo<WindToolPageConfig>(
    () => ({
      title: "Wind 技术分析",
      apiUrl: "/api/wind-technical",
      refreshLabel: "刷新技术面",
      emptyHint: "暂无技术面数据（该标的可能无数据，或该次抓取失败，请刷新重试）",
      renderData: (data) => <TechView data={data} />,
    }),
    []
  );
  return <WindToolPage config={config} />;
}
