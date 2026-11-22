/** 金额格式化：千分位 + 两位小数 */
export function fmtMoney(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "--";
  return n.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 带符号百分比 */
export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "--";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** 带符号金额 */
export function fmtSigned(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "--";
  return `${n >= 0 ? "+" : ""}${fmtMoney(n)}`;
}

/** 涨红跌绿的 className */
export function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

/** 金额（元）→ 亿，带符号，保留两位小数 */
export function fmtYi(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "--";
  return `${(v / 1e8).toFixed(2)} 亿`;
}

/** 金额（元）→ 可读中文单位：≥1 亿显示亿，≥1 万显示万，否则原值 */
export function fmtAmount(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "--";
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return `${v} 元`;
}

/** 股数 → 可读单位：≥1 亿显示亿股，≥1 万显示万股，否则原值 */
export function fmtShares(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "--";
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿股`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)} 万股`;
  return `${v} 股`;
}
