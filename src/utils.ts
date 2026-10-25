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
