import { DatePicker, Tag } from "tdesign-react";

export const SNAPSHOT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 从 DatePicker onChange 值中提取合法日期字符串，非法（含清除）返回 null */
export function toSnapshotDate(v: unknown): string | null {
  return typeof v === "string" && SNAPSHOT_DATE_RE.test(v) ? v : null;
}

/** 页头日期选择器：valueType 固定 YYYY-MM-DD，可清除 */
export function SnapshotDatePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <DatePicker
      value={value ?? undefined}
      valueType="YYYY-MM-DD"
      clearable
      placeholder="选择历史日期"
      onChange={(v) => onChange(toSnapshotDate(v))}
      style={{ width: 150 }}
    />
  );
}

/** 已有快照日期的快速跳转标签行（无数据时不渲染） */
export function SnapshotDateTags({
  dates,
  selected,
  onPick,
}: {
  dates: string[];
  selected: string | null;
  onPick: (d: string | null) => void;
}) {
  if (dates.length === 0) return null;
  return (
    <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>历史快照：</span>
      {dates.map((d) => (
        <Tag
          key={d}
          variant={d === selected ? "dark" : "outline"}
          theme={d === selected ? "primary" : "default"}
          style={{ cursor: "pointer" }}
          onClick={() => onPick(d === selected ? null : d)}
        >
          {d}
        </Tag>
      ))}
    </div>
  );
}
