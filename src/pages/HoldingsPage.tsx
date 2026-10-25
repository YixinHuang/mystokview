import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Switch, Space, Card, MessagePlugin } from "tdesign-react";
import { RefreshIcon, AddIcon } from "tdesign-icons-react";
import OverviewCards from "../components/OverviewCards";
import HoldingsTable from "../components/HoldingsTable";
import AddHoldingDialog from "../components/AddHoldingDialog";
import AuthBanner from "../components/AuthBanner";
import type { HoldingsPayload } from "../types";

export default function HoldingsPage() {
  const [data, setData] = useState<HoldingsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [addVisible, setAddVisible] = useState(false);
  const [lastRefresh, setLastRefresh] = useState("");
  const mounted = useRef(true);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetch("/api/holdings");
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      if (mounted.current) {
        setData(j);
        setLastRefresh(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      }
    } catch (e: any) {
      if (!silent) MessagePlugin.error(`行情刷新失败：${e.message}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => refresh(true), 60000);
    return () => clearInterval(t);
  }, [autoRefresh, refresh]);

  const patchHolding = useCallback(
    async (code: string, patch: { quantity?: number; cost_price?: number; realized_pnl?: number }) => {
      const r = await fetch(`/api/holdings/${code}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "保存失败");
      MessagePlugin.success("已保存");
      await refresh(true);
    },
    [refresh]
  );

  const removeHolding = useCallback(
    async (code: string) => {
      const r = await fetch(`/api/holdings/${code}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "删除失败");
      await refresh(true);
    },
    [refresh]
  );

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>我的持仓</h2>
          {lastRefresh && (
            <span style={{ fontSize: 12, color: "var(--td-text-color-secondary)" }}>
              上次刷新 {lastRefresh}
            </span>
          )}
        </div>
        <Space align="center">
          <span style={{ fontSize: 13 }}>自动刷新（60s）</span>
          <Switch value={autoRefresh} onChange={(v) => setAutoRefresh(Boolean(v))} />
          <Button icon={<RefreshIcon />} loading={loading} onClick={() => refresh()}>
            刷新行情
          </Button>
          <Button theme="primary" icon={<AddIcon />} onClick={() => setAddVisible(true)}>
            新增持仓
          </Button>
        </Space>
      </div>

      {data?.market && (data.market.authRequired || data.market.stale) && (
        <AuthBanner
          authUrl={data.market.authUrl}
          stale={data.market.stale}
          onDone={() => refresh()}
        />
      )}

      {data && <OverviewCards summary={data.summary} />}

      {data && (
        <Card bordered style={{ marginTop: 16 }} title={`持仓明细（${data.summary.count} 只）`}>
          <HoldingsTable
            holdings={data.holdings}
            summary={data.summary}
            onPatch={patchHolding}
            onRemove={removeHolding}
          />
        </Card>
      )}

      <AddHoldingDialog
        visible={addVisible}
        onClose={() => setAddVisible(false)}
        onCreated={() => {
          setAddVisible(false);
          refresh();
        }}
      />
    </div>
  );
}
