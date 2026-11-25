import { useState } from "react";
import { Layout, Menu } from "tdesign-react";
import { WalletIcon, ChatBubbleIcon, ArticleIcon, ChartAnalyticsIcon, FlagIcon, Flag1Icon, BookIcon, MoneyIcon, CurrencyExchangeIcon, ArrowLeftRight1Icon, CloudIcon, DashboardIcon, CalendarEventIcon, ChartBarIcon, NotificationIcon, ChartLineData1Icon, UserCircleIcon } from "tdesign-icons-react";
import HoldingsPage from "./pages/HoldingsPage";
import ChatPage from "./pages/ChatPage";
import NewsPage from "./pages/NewsPage";
import WindNewsPage from "./pages/WindNewsPage";
import TechnicalPage from "./pages/TechnicalPage";
import ConsensusPage from "./pages/ConsensusPage";
import WindConsensusPage from "./pages/WindConsensusPage";
import WindValuationPage from "./pages/WindValuationPage";
import WindUpdatesPage from "./pages/WindUpdatesPage";
import WindProfilePage from "./pages/WindProfilePage";
import WindTechnicalPage from "./pages/WindTechnicalPage";
import WindRiskPage from "./pages/WindRiskPage";
import WindEventsPage from "./pages/WindEventsPage";
import WindMoneyFlowPage from "./pages/WindMoneyFlowPage";
import ReportsPage from "./pages/ReportsPage";
import FundFlowPage from "./pages/FundFlowPage";
import BlockTradePage from "./pages/BlockTradePage";

const { Aside, Content } = Layout;

export default function App() {
  const [page, setPage] = useState<string>("holdings");
  // 惰性挂载：页面首次切到时才渲染（此前 17 页常驻挂载，首屏会一次性并发触发全部 useEffect 请求）
  const [visited, setVisited] = useState<Set<string>>(() => new Set(["holdings"]));

  const openPage = (p: string) => {
    setPage(p);
    setVisited((v) => (v.has(p) ? v : new Set(v).add(p)));
  };

  return (
    <Layout style={{ height: "100vh" }}>
      <Aside
        width="180px"
        style={{ background: "var(--td-bg-color-container)", borderRight: "1px solid var(--td-component-stroke)" }}
      >
        <div style={{ padding: "18px 24px 10px", fontWeight: 600, fontSize: 16 }}>
          工作台
        </div>
        <Menu
          value={page}
          onChange={(v) => openPage(String(v))}
          style={{ background: "transparent" }}
        >
          <Menu.MenuItem value="holdings" icon={<WalletIcon />}>
            列表展示
          </Menu.MenuItem>
          <Menu.MenuItem value="news" icon={<ArticleIcon />}>
            我的新闻
          </Menu.MenuItem>
          <Menu.MenuItem value="windnews" icon={<CloudIcon />}>
            Wind 新闻
          </Menu.MenuItem>
          <Menu.MenuItem value="tech" icon={<ChartAnalyticsIcon />}>
            技术分析
          </Menu.MenuItem>
          <Menu.MenuItem value="consensus" icon={<FlagIcon />}>
            一致预期
          </Menu.MenuItem>
          <Menu.MenuItem value="windconsensus" icon={<Flag1Icon />}>
            Wind一致预期
          </Menu.MenuItem>
          <Menu.MenuItem value="windvaluation" icon={<ChartBarIcon />}>
            Wind估值
          </Menu.MenuItem>
          <Menu.MenuItem value="windupdates" icon={<NotificationIcon />}>
            Wind公司动态
          </Menu.MenuItem>
          <Menu.MenuItem value="windprofile" icon={<UserCircleIcon />}>
            Wind公司画像
          </Menu.MenuItem>
          <Menu.MenuItem value="windtechnical" icon={<ChartLineData1Icon />}>
            Wind技术分析
          </Menu.MenuItem>
          <Menu.MenuItem value="windrisk" icon={<DashboardIcon />}>
            Wind风险指标
          </Menu.MenuItem>
          <Menu.MenuItem value="windevents" icon={<CalendarEventIcon />}>
            Wind事件
          </Menu.MenuItem>
          <Menu.MenuItem value="reports" icon={<BookIcon />}>
            我的研报
          </Menu.MenuItem>
          <Menu.MenuItem value="fundflow" icon={<MoneyIcon />}>
            资金流向
          </Menu.MenuItem>
          <Menu.MenuItem value="windmoneyflow" icon={<CurrencyExchangeIcon />}>
            Wind资金流向
          </Menu.MenuItem>
          <Menu.MenuItem value="blocktrade" icon={<ArrowLeftRight1Icon />}>
            大宗交易
          </Menu.MenuItem>
          <Menu.MenuItem value="chat" icon={<ChatBubbleIcon />}>
            持仓管家
          </Menu.MenuItem>
        </Menu>
      </Aside>
      <Layout>
        <Content style={{ padding: 20, overflow: "auto", background: "var(--td-bg-color-page)" }}>
          {visited.has("holdings") && (
            <div style={{ display: page === "holdings" ? "block" : "none" }}>
              <HoldingsPage />
            </div>
          )}
          {visited.has("news") && (
            <div style={{ display: page === "news" ? "block" : "none" }}>
              <NewsPage />
            </div>
          )}
          {visited.has("windnews") && (
            <div style={{ display: page === "windnews" ? "block" : "none" }}>
              <WindNewsPage />
            </div>
          )}
          {visited.has("tech") && (
            <div style={{ display: page === "tech" ? "block" : "none" }}>
              <TechnicalPage />
            </div>
          )}
          {visited.has("consensus") && (
            <div style={{ display: page === "consensus" ? "block" : "none" }}>
              <ConsensusPage />
            </div>
          )}
          {visited.has("windconsensus") && (
            <div style={{ display: page === "windconsensus" ? "block" : "none" }}>
              <WindConsensusPage />
            </div>
          )}
          {visited.has("windvaluation") && (
            <div style={{ display: page === "windvaluation" ? "block" : "none" }}>
              <WindValuationPage />
            </div>
          )}
          {visited.has("windupdates") && (
            <div style={{ display: page === "windupdates" ? "block" : "none" }}>
              <WindUpdatesPage />
            </div>
          )}
          {visited.has("windprofile") && (
            <div style={{ display: page === "windprofile" ? "block" : "none" }}>
              <WindProfilePage />
            </div>
          )}
          {visited.has("windtechnical") && (
            <div style={{ display: page === "windtechnical" ? "block" : "none" }}>
              <WindTechnicalPage />
            </div>
          )}
          {visited.has("windrisk") && (
            <div style={{ display: page === "windrisk" ? "block" : "none" }}>
              <WindRiskPage />
            </div>
          )}
          {visited.has("windevents") && (
            <div style={{ display: page === "windevents" ? "block" : "none" }}>
              <WindEventsPage />
            </div>
          )}
          {visited.has("reports") && (
            <div style={{ display: page === "reports" ? "block" : "none" }}>
              <ReportsPage />
            </div>
          )}
          {visited.has("fundflow") && (
            <div style={{ display: page === "fundflow" ? "block" : "none" }}>
              <FundFlowPage />
            </div>
          )}
          {visited.has("windmoneyflow") && (
            <div style={{ display: page === "windmoneyflow" ? "block" : "none" }}>
              <WindMoneyFlowPage />
            </div>
          )}
          {visited.has("blocktrade") && (
            <div style={{ display: page === "blocktrade" ? "block" : "none" }}>
              <BlockTradePage />
            </div>
          )}
          {visited.has("chat") && (
            <div style={{ display: page === "chat" ? "block" : "none", height: "100%" }}>
              <ChatPage />
            </div>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
