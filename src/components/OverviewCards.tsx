import { Row, Col, Card } from "tdesign-react";
import type { Summary } from "../types";
import { fmtMoney, fmtPct, fmtSigned, pnlClass } from "../utils";

export default function OverviewCards({ summary }: { summary: Summary }) {
  const cards = [
    { title: "组合总市值", value: fmtMoney(summary.total_market_value), cls: "" },
    { title: "持仓总成本", value: fmtMoney(summary.total_cost), cls: "" },
    {
      title: "浮动盈亏",
      value: fmtSigned(summary.total_float_pnl),
      sub: fmtPct(summary.total_float_pnl_pct),
      cls: pnlClass(summary.total_float_pnl),
    },
    {
      title: "累计已实现盈亏",
      value: fmtSigned(summary.total_realized_pnl),
      cls: pnlClass(summary.total_realized_pnl),
    },
  ];
  return (
    <Row gutter={[16, 16]}>
      {cards.map((c) => (
        <Col key={c.title} xs={12} sm={6} md={3}>
          <Card bordered hoverShadow style={{ height: "100%" }}>
            <div style={{ fontSize: 13, color: "var(--td-text-color-secondary)", marginBottom: 8 }}>
              {c.title}
            </div>
            <div className={c.cls} style={{ fontSize: 22, fontWeight: 600 }}>
              {c.value}
            </div>
            {c.sub && (
              <div className={c.cls} style={{ fontSize: 13, marginTop: 4 }}>
                {c.sub}
              </div>
            )}
          </Card>
        </Col>
      ))}
    </Row>
  );
}
