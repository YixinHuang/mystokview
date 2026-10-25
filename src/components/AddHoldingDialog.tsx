import { useEffect, useRef, useState } from "react";
import {
  Dialog, Form, Input, InputNumber, DatePicker, Button, Space, Tag, MessagePlugin, Loading,
} from "tdesign-react";
import type { SearchResult } from "../types";

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

/** 新增持仓：支持按名称搜索自动填入代码 */
export default function AddHoldingDialog({ visible, onClose, onCreated }: Props) {
  const [keyword, setKeyword] = useState("");
  const [candidates, setCandidates] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [quantity, setQuantity] = useState<number | undefined>();
  const [costPrice, setCostPrice] = useState<number | undefined>();
  const [openDate, setOpenDate] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // 名称输入防抖搜索
  useEffect(() => {
    if (!keyword.trim()) {
      setCandidates([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(keyword.trim())}`);
        const j = await r.json();
        setCandidates(Array.isArray(j) ? j : []);
      } catch {
        setCandidates([]);
      } finally {
        setSearching(false);
      }
    }, 400);
  }, [keyword]);

  const reset = () => {
    setKeyword("");
    setCandidates([]);
    setSelected(null);
    setQuantity(undefined);
    setCostPrice(undefined);
    setOpenDate("");
  };

  const submit = async () => {
    if (!selected && !keyword.trim()) {
      MessagePlugin.warning("请输入证券名称或代码");
      return;
    }
    if (!quantity || quantity <= 0) {
      MessagePlugin.warning("请输入持仓数量");
      return;
    }
    if (costPrice === undefined || costPrice < 0) {
      MessagePlugin.warning("请输入成本价");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { quantity, cost_price: costPrice };
      if (selected) {
        body.code = selected.code;
        body.name = selected.name;
      } else {
        body.name = keyword.trim(); // 后端会自动搜索匹配
      }
      if (openDate) body.open_date = openDate;
      const r = await fetch("/api/holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "新增失败");
      MessagePlugin.success(`已新增 ${j.name}（${j.code}）`);
      reset();
      onCreated();
    } catch (e: any) {
      MessagePlugin.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      header="新增持仓"
      visible={visible}
      width={560}
      onClose={() => { reset(); onClose(); }}
      onConfirm={submit}
      confirmBtn={{ content: "确认新增", loading: submitting }}
    >
      <Form labelWidth={90} colon>
        <Form.FormItem label="证券" name="security">
          <Input
            placeholder="输入名称或代码搜索，如：贵州茅台 / 600519"
            value={keyword}
            onChange={(v) => {
              setKeyword(String(v));
              setSelected(null);
            }}
            clearable
          />
          <Loading loading={searching} size="small">
            {candidates.length > 0 && !selected && (
              <div
                style={{
                  marginTop: 6, border: "1px solid var(--td-component-stroke)",
                  borderRadius: 6, maxHeight: 180, overflow: "auto",
                }}
              >
                {candidates.map((c) => (
                  <div
                    key={c.code}
                    style={{ padding: "6px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--td-bg-color-container-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    onClick={() => {
                      setSelected(c);
                      setKeyword(c.name);
                      setCandidates([]);
                    }}
                  >
                    <span>{c.name}</span>
                    <Space size={4}>
                      <Tag size="small" variant="outline">{c.market}</Tag>
                      <span style={{ fontFamily: "monospace", color: "var(--td-text-color-secondary)" }}>{c.code}</span>
                    </Space>
                  </div>
                ))}
              </div>
            )}
          </Loading>
          {selected && (
            <div style={{ marginTop: 6 }}>
              已选：<Tag theme="primary" variant="light">{selected.name} · {selected.code}</Tag>
            </div>
          )}
        </Form.FormItem>
        <Form.FormItem label="持仓数量" name="quantity">
          <InputNumber
            placeholder="股 / 份"
            value={quantity}
            onChange={(v) => setQuantity(v as number | undefined)}
            min={0}
            style={{ width: "100%" }}
          />
        </Form.FormItem>
        <Form.FormItem label="成本价" name="costPrice">
          <InputNumber
            placeholder="每股成本"
            value={costPrice}
            onChange={(v) => setCostPrice(v as number | undefined)}
            min={0}
            decimalPlaces={4}
            style={{ width: "100%" }}
          />
        </Form.FormItem>
        <Form.FormItem label="建仓日期" name="openDate">
          <DatePicker
            value={openDate}
            onChange={(v) => setOpenDate(String(v ?? ""))}
            style={{ width: "100%" }}
            clearable
          />
        </Form.FormItem>
      </Form>
    </Dialog>
  );
}
