export interface Holding {
  id: number;
  code: string;
  name: string;
  quantity: number;
  cost_price: number;
  open_date: string | null;
  realized_pnl: number;
  price: number | null;
  prev_close: number | null;
  change_percent: number | null;
  quote_time: string | null;
  market_value: number | null;
  cost_amount: number;
  float_pnl: number | null;
  float_pnl_pct: number | null;
  weight: number | null;
}

export interface Summary {
  total_market_value: number;
  total_cost: number;
  total_float_pnl: number;
  total_float_pnl_pct: number;
  total_realized_pnl: number;
  count: number;
}

export interface MarketMeta {
  stale: boolean;
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

export interface HoldingsPayload {
  holdings: Holding[];
  summary: Summary;
  market: MarketMeta;
}

export interface SearchResult {
  code: string;
  name: string;
  market: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
}
