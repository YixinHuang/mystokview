import { useState } from "react";
import { Alert, Button, Space, MessagePlugin } from "tdesign-react";

interface Props {
  authUrl: string | null;
  stale: boolean;
  onDone: () => void;
  /** 覆盖默认文案（如新闻页传入资讯相关描述） */
  title?: string;
  description?: string;
}

/** westock 未授权时的扫码授权引导 */
export default function AuthBanner({ authUrl, stale, onDone, title, description }: Props) {
  const [checking, setChecking] = useState(false);

  const checkAuth = async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/auth/status");
      const j = await r.json();
      if (j.authed) {
        MessagePlugin.success("授权成功，行情已恢复实时查询");
        onDone();
      } else {
        MessagePlugin.warning("尚未检测到授权，请打开链接完成扫码授权后再试");
      }
    } catch {
      MessagePlugin.error("授权状态检查失败");
    } finally {
      setChecking(false);
    }
  };

  const defaultDescription = stale
    ? "westock 行情服务未授权，当前展示的是最近一次缓存的行情价格。完成授权后即可恢复实时行情。"
    : "westock 行情服务未授权，暂时无法获取实时行情。完成授权后自动恢复。";

  return (
    <Alert
      theme="warning"
      style={{ marginBottom: 16 }}
      title={title ?? "行情服务需要授权"}
      message={
        <div>
          <div style={{ marginBottom: 8 }}>{description ?? defaultDescription}</div>
          <Space>
            {authUrl && (
              <Button size="small" theme="primary" variant="outline" onClick={() => window.open(authUrl, "_blank")}>
                打开授权链接（扫码）
              </Button>
            )}
            <Button size="small" loading={checking} onClick={checkAuth}>
              我已完成授权
            </Button>
          </Space>
        </div>
      }
    />
  );
}
