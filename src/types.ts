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

export interface NewsItem {
  id: string;
  src: string;
  title: string;
  summary: string;
  time: string;
  url: string;
}

export interface NewsEntry {
  code: string;
  name: string;
  news: NewsItem | null;
}

export interface NewsDetail {
  title: string;
  time: string;
  src: string;
  content: string;
}

export interface TechIndicators {
  date: string;
  close_price: number;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  ma250: number | null;
  dif: number | null;
  dea: number | null;
  macd: number | null;
  kdj_k: number | null;
  kdj_d: number | null;
  kdj_j: number | null;
  rsi6: number | null;
  rsi12: number | null;
  rsi24: number | null;
  boll_upper: number | null;
  boll_mid: number | null;
  boll_lower: number | null;
}

export interface ChipAnalysis {
  date: string;
  avg_cost: number;
  concentration70: number;
  concentration90: number;
  profit_rate: number;
}

export interface TechSummary {
  rating: "bull" | "bear" | "neutral";
  signals: string[];
}

export interface TechnicalEntry {
  code: string;
  name: string;
  tech: TechIndicators | null;
  chip: ChipAnalysis | null;
  summary: TechSummary | null;
}

export interface TechnicalPayload {
  items: TechnicalEntry[];
  summary: { bull: number; neutral: number; bear: number; total: number };
  date: string | null;
  fromDb: boolean;
  availableDates: string[];
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}
export interface ConsensusData {
  year: string;
  eps: number;
  pe: number | null;
  revenue_yoy: number | null;
  profit_yoy: number | null;
  target_price: number;
}

export interface RatingData {
  current_price: number;
  institutions: number;
  buy_cnt: number;
  hold_cnt: number;
  sell_cnt: number;
  total_cnt: number;
  target_avg: number | null;
}

export interface ScoreDim {
  value: number;
  detail: string;
}

export interface ScoreInfo {
  cap: ScoreDim;
  comp: ScoreDim;
  funm: ScoreDim;
  risk: ScoreDim;
  tec: ScoreDim;
}

export interface ConsensusEntry {
  code: string;
  name: string;
  price: number | null;
  consensus: ConsensusData | null;
  rating: RatingData | null;
  score: ScoreInfo | null;
  summary: TechSummary | null;
}

export interface ConsensusPayload {
  items: ConsensusEntry[];
  summary: { bull: number; neutral: number; bear: number; total: number };
  date: string | null;
  fromDb: boolean;
  availableDates: string[];
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

export interface ReportItem {
  id: string;
  title: string;
  type_str: string;
  tzpj: string;
  time: string;
}

export interface ReportEntry {
  code: string;
  name: string;
  reports: ReportItem[];
}

export interface ReportsPayload {
  items: ReportEntry[];
  date: string | null;
  fromDb: boolean;
  availableDates: string[];
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

export interface ReportDetail {
  title: string;
  date: string;
  publish_time: string;
  org: string;
  content: string;
}

export interface WindDoc {
  title: string;
  date: string;
  content: string;
  url: string;
  doc_type: string;
}

export interface WindNewsEntry {
  code: string;
  name: string;
  news: WindDoc[];
  announcements: WindDoc[];
}

export interface WindNewsPayload {
  items: WindNewsEntry[];
  date: string | null;
  fromDb: boolean;
  snapshotDate: string | null;
  isHistorical: boolean;
  availableDates: string[];
  configMissing: boolean;
  refreshed: { code: string; noData: boolean } | null;
  error: string | null;
}

export interface WindConsensusData {
  wind_code: string;
  rating: string | null;
  rating_count: number | null;
  target_price: number | null;
  current_price: number | null;
  upside: number | null;
  forecast: Record<string, string | number> | null;
  details: Array<Record<string, unknown>> | null;
}

export interface WindConsensusEntry {
  code: string;
  name: string;
  consensus: WindConsensusData | null;
  error: string | null;
}

export interface WindConsensusPayload {
  items: WindConsensusEntry[];
  date: string | null;
  fromDb: boolean;
  snapshotDate: string | null;
  isHistorical: boolean;
  availableDates: string[];
  configMissing: boolean;
  refreshed: { code: string; noData: boolean } | null;
  error: string | null;
}

export interface WindRiskTable {
  category: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface WindRiskEntry {
  code: string;
  name: string;
  tables: WindRiskTable[];
  error: string | null;
}

export interface WindRiskPayload {
  items: WindRiskEntry[];
  date: string | null;
  fromDb: boolean;
  snapshotDate: string | null;
  isHistorical: boolean;
  availableDates: string[];
  configMissing: boolean;
  refreshed: { code: string; noData: boolean } | null;
  error: string | null;
}

export interface WindEventTable {
  category: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface WindEventsEntry {
  code: string;
  name: string;
  tables: WindEventTable[];
  error: string | null;
}

export interface WindEventsPayload {
  items: WindEventsEntry[];
  date: string | null;
  fromDb: boolean;
  snapshotDate: string | null;
  isHistorical: boolean;
  availableDates: string[];
  configMissing: boolean;
  refreshed: { code: string; noData: boolean } | null;
  error: string | null;
}

export interface WindToolEntry {
  code: string;
  name: string;
  data: any; // 工具返回的异构 JSON
  error: string | null;
}

export interface WindToolPayload {
  items: WindToolEntry[];
  date: string | null;
  fromDb: boolean;
  snapshotDate: string | null;
  isHistorical: boolean;
  availableDates: string[];
  configMissing: boolean;
  refreshed: { code: string; noData: boolean } | null;
  error: string | null;
}

export interface WindMoneyFlowData {
  wind_code: string;
  trade_date: string;
  trade_time: string;
  // 资金面数据原样分块：主力资金/融资融券/陆股通/成交活跃度/基金机构持仓/十大流通股东变化
  sections: Record<string, any>;
}

export interface WindMoneyFlowEntry {
  code: string;
  name: string;
  moneyflow: WindMoneyFlowData | null;
  error: string | null;
}

export interface WindMoneyFlowPayload {
  items: WindMoneyFlowEntry[];
  date: string | null;
  fromDb: boolean;
  snapshotDate: string | null;
  availableDates: string[];
  configMissing: boolean;
  error: string | null;
}

export interface FundFlowData {
  date: string;
  main_net: number;
  jumbo_net: number;
  block_net: number;
  mid_net: number;
  small_net: number;
  main_in: number;
  main_out: number;
  main_net_5d: number;
  main_net_10d: number;
  main_net_20d: number;
}

export interface NorthHoldingData {
  date: string;
  disclose_end: string;
  holding_cap: number;
  holding_ratio: number;
  hold_shares: number;
  cap_chg_q: number | null;
  cap_chg_y: number | null;
}

export interface ShortData {
  date: string;
  close_price: number | null;
  short_shares: number;
  short_amount: number;
  short_ratio: number | null;
}

export interface SouthHoldingData {
  date: string;
  hold_ratio: number;
  hold_shares: number;
  cap_chg_daily: number | null;
  cap_chg_quarterly: number | null;
}

export interface FundFlowEntry {
  code: string;
  name: string;
  flow: FundFlowData | null;
  margin: MarginData | null;
  north: NorthHoldingData | null;
  short: ShortData | null;
  south: SouthHoldingData | null;
  summary: TechSummary | null;
}

export interface FundFlowPayload {
  items: FundFlowEntry[];
  summary: { inflow: number; outflow: number; total: number };
  date: string | null;
  fromDb: boolean;
  availableDates: string[];
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

export interface BlockTrade {
  date: string;
  price: number;
  value: number;
  discount: number;
  type: string;
  buyer: string;
  seller: string;
}

export interface BlockTradeData {
  date: string;
  close_price: number | null;
  change_pct: number | null;
  trades: BlockTrade[];
}

export interface MarginData {
  date: string;
  finance_value: number;
  security_value: number;
  finance_buy: number;
  finance_refund: number | null;
  trading_value: number | null;
  finance_value_dod: number | null;
  security_value_dod: number | null;
}

export interface BlockMarginEntry {
  code: string;
  name: string;
  block: BlockTradeData | null;
  margin: MarginData | null;
  summary: TechSummary | null;
}

export interface BlockMarginPayload {
  items: BlockMarginEntry[];
  summary: { bull: number; neutral: number; bear: number; total: number };
  date: string | null;
  fromDb: boolean;
  availableDates: string[];
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

export interface NewsPayload {
  items: NewsEntry[];
  date: string | null;
  fromDb: boolean;
  availableDates: string[];
  authRequired: boolean;
  authUrl: string | null;
  error: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
}
