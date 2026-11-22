/* 通用 JSON 递归渲染器：对象→嵌套小节，对象数组→表格，标量数组→行，标量→键值行。
   用于 Wind 估值/公司动态/技术分析等 NL 工具返回的异构 JSON 展示。 */
const SECONDARY = "var(--td-text-color-secondary)";

function isFilled(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

function ScalarText({ v }: { v: unknown }) {
  if (!isFilled(v)) return <span style={{ color: SECONDARY }}>--</span>;
  if (typeof v === "object") return <span>{JSON.stringify(v)}</span>;
  return <span>{String(v)}</span>;
}

function ObjArrayTable({ value }: { value: Array<Record<string, unknown>> }) {
  const keys: string[] = [];
  for (const item of value) {
    for (const k of Object.keys(item)) if (!keys.includes(k)) keys.push(k);
  }
  // 行数熔断：超大对象数组（如十大流通股东）一次性渲染数千 DOM 会卡顿
  const MAX_ROWS = 200;
  const shown = value.slice(0, MAX_ROWS);
  return (
    <div style={{ overflowX: "auto", marginTop: 2 }}>
      <table style={{ fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k} style={{ fontWeight: 500, color: SECONDARY, padding: "3px 10px 3px 0", textAlign: "left", whiteSpace: "nowrap" }}>
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((item, ri) => (
            <tr key={ri}>
              {keys.map((k) => {
                const v = item[k];
                const text = isFilled(v)
                  ? typeof v === "object"
                    ? JSON.stringify(v).slice(0, 80)
                    : String(v)
                  : "--";
                return (
                  <td key={k} style={{ padding: "3px 10px 3px 0", maxWidth: 280, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={text}>
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {value.length > MAX_ROWS && (
        <div style={{ fontSize: 12, color: SECONDARY, marginTop: 2 }}>
          已省略 {value.length - MAX_ROWS} 行（超过 {MAX_ROWS} 行渲染上限）
        </div>
      )}
    </div>
  );
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const pad = { paddingLeft: depth * 12 };

  // 深度熔断：超过 8 层的嵌套直接折叠为字符串，防极端嵌套拖垮渲染
  if (depth > 8) {
    const v = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
    return (
      <div style={{ fontSize: 12, lineHeight: 1.8, ...pad }}>
        {name && <span style={{ color: SECONDARY }}>{name}：</span>}
        <ScalarText v={v} />
      </div>
    );
  }

  // 标量
  if (!isFilled(value) || typeof value !== "object") {
    return (
      <div style={{ fontSize: 12, lineHeight: 1.8, ...pad }}>
        {name && <span style={{ color: SECONDARY }}>{name}：</span>}
        <ScalarText v={value} />
      </div>
    );
  }

  // 数组
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div style={{ fontSize: 12, lineHeight: 1.8, ...pad }}>
          {name && <span style={{ color: SECONDARY }}>{name}：</span>}
          <span style={{ color: SECONDARY }}>（空）</span>
        </div>
      );
    }
    const allObj = value.every((v) => v && typeof v === "object" && !Array.isArray(v));
    if (allObj) {
      return (
        <div style={{ ...pad, marginTop: depth === 0 ? 6 : 2 }}>
          {name && <div style={{ fontWeight: 500 }}>{name}（{value.length}）</div>}
          <ObjArrayTable value={value as Array<Record<string, unknown>>} />
        </div>
      );
    }
    return (
      <div style={{ fontSize: 12, lineHeight: 1.8, ...pad }}>
        {name && <span style={{ color: SECONDARY }}>{name}：</span>}
        <ScalarText v={value.map((v) => (typeof v === "object" ? JSON.stringify(v) : v)).join("，")} />
      </div>
    );
  }

  // 对象 → 递归小节
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <div style={{ marginTop: depth === 0 ? 8 : 2 }}>
      {name && <div style={{ fontWeight: 600, marginBottom: 2 }}>{name}</div>}
      <div style={{ borderLeft: depth > 0 ? "2px solid var(--td-component-stroke)" : undefined, paddingLeft: depth > 0 ? 10 : 0 }}>
        {entries.map(([k, v]) => (
          <JsonNode key={k} name={k} value={v} depth={depth + 1} />
        ))}
      </div>
    </div>
  );
}

export default function JsonView({ data }: { data: unknown }) {
  return <JsonNode value={data} depth={0} />;
}
