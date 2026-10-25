import { useState } from "react";
import { Table, Progress, Tag, Button, Input, Space, Popconfirm, MessagePlugin } from "tdesign-react";
import { DeleteIcon } from "tdesign-icons-react";
import type { Holding, Summary } from "../types";
import { fmtMoney, fmtPct, fmtSigned, pnlClass } from "../utils";

interface Props {
  holdings: Holding[];
  summary: Summary;
  onPatch: (code: string, patch: { quantity?: number; cost_price?: number; realized_pnl?: number }) => Promise<void>;
  onRemove: (code: string) => Promise<void>;
}

/** 点击可编辑的数字单元格 */
function EditableNumber({
  value,
  display,
  onSave,
}: {
  value: number;
  display: string;
  onSave: (v: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <span
        title="点击编辑"
        style={{ cursor: "pointer", borderBottom: "1px dashed var(--td-text-color-placeholder)" }}
        onClick={() => {
          setText(String(value));
          setEditing(true);
        }}
      >
        {display}
      </span>
    );
  }
  return (
    <Space size={4}>
      <Input
        size="small"
        autoWidth
        value={text}
        autofocus
        onChange={(v) => setText(String(v))}
        onEnter={async () => {
          const n = Number(text);
          if (Number.isNaN(n)) {
            MessagePlugin.error("请输入数字");
            return;
          }
          setSaving(true);
          try {
            await onSave(n);
            setEditing(false);
          } catch (e: any) {
            MessagePlugin.error(e.message ?? "保存失败");
          } finally {
            setSaving(false);
          }
        }}
        onBlur={() => setEditing(false)}
      />
    </Space>
  );
}

export default function HoldingsTable({ holdings, summary, onPatch, onRemove }: Props) {
  const columns = [
    {
      colKey: "code",
      title: "代码",
      width: 110,
      cell: ({ row }: { row: Holding }) => (
        <span style={{ fontFamily: "monospace" }}>{row.code}</span>
      ),
    },
    { colKey: "name", title: "名称", width: 150, ellipsis: true },
    {
      colKey: "price",
      title: "最新价",
      width: 130,
      cell: ({ row }: { row: Holding }) => (
        <div>
          <div className={pnlClass(row.change_percent)} style={{ fontWeight: 600 }}>
            {row.price !== null ? fmtMoney(row.price, row.price < 10 ? 4 : 2) : "--"}
          </div>
          {row.change_percent !== null && (
            <Tag
              size="small"
              variant="light"
              theme={row.change_percent > 0 ? "danger" : row.change_percent < 0 ? "success" : "default"}
            >
              {fmtPct(row.change_percent)}
            </Tag>
          )}
        </div>
      ),
    },
    {
      colKey: "quantity",
      title: "持仓数量",
      width: 130,
      cell: ({ row }: { row: Holding }) => (
        <EditableNumber
          value={row.quantity}
          display={row.quantity.toLocaleString("zh-CN")}
          onSave={async (v) => onPatch(row.code, { quantity: v })}
        />
      ),
    },
    {
      colKey: "market_value",
      title: "市值",
      width: 120,
      cell: ({ row }: { row: Holding }) => fmtMoney(row.market_value),
    },
    {
      colKey: "weight",
      title: "权重",
      width: 150,
      cell: ({ row }: { row: Holding }) =>
        row.weight !== null ? (
          <Progress
            percentage={row.weight}
            strokeWidth={8}
            color={{ from: "#84CAF6", to: "#0594FA" }}
            label={<span style={{ fontSize: 12 }}>{row.weight.toFixed(1)}%</span>}
          />
        ) : (
          "--"
        ),
    },
    {
      colKey: "cost",
      title: "成本",
      width: 150,
      cell: ({ row }: { row: Holding }) => (
        <div>
          <div>
            <EditableNumber
              value={row.cost_price}
              display={`成本价 ${fmtMoney(row.cost_price, 4)}`}
              onSave={async (v) => onPatch(row.code, { cost_price: v })}
            />
          </div>
          <div style={{ fontSize: 12, color: "var(--td-text-color-secondary)", marginTop: 2 }}>
            金额 {fmtMoney(row.cost_amount)}
          </div>
        </div>
      ),
    },
    {
      colKey: "float_pnl",
      title: "浮动盈亏",
      width: 120,
      cell: ({ row }: { row: Holding }) => (
        <span className={pnlClass(row.float_pnl)}>{fmtSigned(row.float_pnl)}</span>
      ),
    },
    {
      colKey: "float_pnl_pct",
      title: "盈亏比例",
      width: 100,
      cell: ({ row }: { row: Holding }) => (
        <span className={pnlClass(row.float_pnl)}>{fmtPct(row.float_pnl_pct)}</span>
      ),
    },
    {
      colKey: "realized_pnl",
      title: "已实现盈亏",
      width: 140,
      cell: ({ row }: { row: Holding }) => (
        <span className={pnlClass(row.realized_pnl)}>
          <EditableNumber
            value={row.realized_pnl}
            display={fmtSigned(row.realized_pnl)}
            onSave={async (v) => onPatch(row.code, { realized_pnl: v })}
          />
        </span>
      ),
    },
    {
      colKey: "op",
      title: "操作",
      width: 70,
      cell: ({ row }: { row: Holding }) => (
        <Popconfirm
          content={`确认删除 ${row.name}（${row.code}）？`}
          onConfirm={async () => {
            try {
              await onRemove(row.code);
              MessagePlugin.success("已删除");
            } catch (e: any) {
              MessagePlugin.error(e.message ?? "删除失败");
            }
          }}
        >
          <Button size="small" variant="text" theme="danger" icon={<DeleteIcon />} />
        </Popconfirm>
      ),
    },
  ];

  const quoteTime = holdings.find((h) => h.quote_time)?.quote_time;

  return (
    <div>
      <Table
        rowKey="code"
        size="small"
        data={holdings}
        columns={columns as any}
        bordered
        hover
        tableLayout="auto"
      />
      <div
        style={{
          display: "flex", flexWrap: "wrap", gap: 24, fontSize: 13,
          padding: "10px 16px", border: "1px solid var(--td-component-border)",
          borderTop: "none", background: "var(--td-bg-color-secondarycontainer)",
        }}
      >
        <span style={{ fontWeight: 600 }}>合计</span>
        <span>市值：<b>{fmtMoney(summary.total_market_value)}</b></span>
        <span>成本：<b>{fmtMoney(summary.total_cost)}</b></span>
        <span>
          浮动盈亏：
          <b className={pnlClass(summary.total_float_pnl)}>
            {fmtSigned(summary.total_float_pnl)}（{fmtPct(summary.total_float_pnl_pct)}）
          </b>
        </span>
        <span>
          已实现盈亏：
          <b className={pnlClass(summary.total_realized_pnl)}>
            {fmtSigned(summary.total_realized_pnl)}
          </b>
        </span>
        {quoteTime && (
          <span style={{ color: "var(--td-text-color-secondary)" }}>行情日期：{quoteTime}</span>
        )}
      </div>
    </div>
  );
}
