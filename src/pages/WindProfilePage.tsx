import { useMemo } from "react";
import { Collapse } from "tdesign-react";
import WindToolPage from "../components/WindToolPage";
import JsonView from "../components/JsonView";
import type { WindToolPageConfig } from "../components/WindToolPage";

const SECONDARY = "var(--td-text-color-secondary)";

/** 画像数据为深度嵌套的研究文档，按四大类折叠面板呈现（默认收起，展开即全量数据） */
function ProfileView({ data }: { data: any }) {
  if (!data || typeof data !== "object") return null;
  const META_KEYS = ["查询日期"];
  const entries = Object.entries(data).filter(([k]) => !META_KEYS.includes(k));
  const { Panel } = Collapse;

  return (
    <div>
      <div style={{ fontSize: 12, color: SECONDARY, marginBottom: 8 }}>
        查询日期：{data["查询日期"] ?? "--"}
      </div>
      <Collapse defaultExpandAll={false}>
        {entries.map(([k, v]) => (
          <Panel key={k} header={k} value={k}>
            <JsonView data={v} />
          </Panel>
        ))}
      </Collapse>
    </div>
  );
}

/** Wind 公司画像：万得 MCP stock_get_company_profile（公司身份/主营经营/控制权治理/融资投向，
 * 四大类折叠面板）。数据存储与展现逻辑与「Wind一致预期」一致（最近日期优先快照 + force 强刷 + 历史回看）。 */
export default function WindProfilePage() {
  const config = useMemo<WindToolPageConfig>(
    () => ({
      title: "Wind 公司画像",
      apiUrl: "/api/wind-profile",
      refreshLabel: "刷新画像",
      emptyHint: "暂无公司画像数据（该次抓取失败，请刷新重试）",
      renderData: (data) => <ProfileView data={data} />,
    }),
    []
  );
  return <WindToolPage config={config} />;
}
