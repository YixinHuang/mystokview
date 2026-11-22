import { fmtAmount, fmtPct } from "../utils";
import type { MarginData } from "../types";

/** 融资融券数据行（资金流向 / 大宗交易页共用） */
export default function MarginSection({ m }: { m: MarginData }) {
  const dod = (v: number | null) => (v === null ? "" : `（日环比 ${fmtPct(v)}）`);
  return (
    <div style={{ fontSize: 13, lineHeight: 1.9 }}>
      <span style={{ fontWeight: 500 }}>融资融券（{m.date}）</span>
      <span style={{ color: "var(--td-text-color-secondary)" }}>
        ：融资余额 {fmtAmount(m.finance_value)}{dod(m.finance_value_dod)} · 融券余额 {fmtAmount(m.security_value)}{dod(m.security_value_dod)}
        {m.trading_value !== null && ` · 两融余额 ${fmtAmount(m.trading_value)}`}
        {` · 当日融资买入 ${fmtAmount(m.finance_buy)}${m.finance_refund !== null ? ` / 偿还 ${fmtAmount(m.finance_refund)}` : ""}`}
      </span>
    </div>
  );
}
