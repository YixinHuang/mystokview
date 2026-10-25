import { useState } from "react";
import { Layout, Menu } from "tdesign-react";
import { WalletIcon, ChatBubbleIcon } from "tdesign-icons-react";
import HoldingsPage from "./pages/HoldingsPage";
import ChatPage from "./pages/ChatPage";

const { Aside, Content } = Layout;

export default function App() {
  const [page, setPage] = useState<string>("holdings");

  return (
    <Layout style={{ height: "100vh" }}>
      <Aside
        width="180px"
        style={{ background: "var(--td-bg-color-container)", borderRight: "1px solid var(--td-component-stroke)" }}
      >
        <div style={{ padding: "18px 24px 10px", fontWeight: 600, fontSize: 16 }}>
          MyStokView
        </div>
        <Menu
          value={page}
          onChange={(v) => setPage(String(v))}
          style={{ background: "transparent" }}
        >
          <Menu.MenuItem value="holdings" icon={<WalletIcon />}>
            我的持仓
          </Menu.MenuItem>
          <Menu.MenuItem value="chat" icon={<ChatBubbleIcon />}>
            持仓管家
          </Menu.MenuItem>
        </Menu>
      </Aside>
      <Layout>
        <Content style={{ padding: 20, overflow: "auto", background: "var(--td-bg-color-page)" }}>
          <div style={{ display: page === "holdings" ? "block" : "none" }}>
            <HoldingsPage />
          </div>
          <div style={{ display: page === "chat" ? "block" : "none", height: "100%" }}>
            <ChatPage />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
