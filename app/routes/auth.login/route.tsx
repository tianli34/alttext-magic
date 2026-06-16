import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { login } from "../../shopify.server";

interface DebugInfo {
  timestamp: string;
  url: string;
  method: string;
  referer: string | null;
  origin: string | null;
  secFetchSite: string | null;
  secFetchMode: string | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    return await login(request);
  }

  const debug: DebugInfo = {
    timestamp: new Date().toISOString(),
    url: request.url,
    method: request.method,
    referer: request.headers.get("Referer"),
    origin: request.headers.get("Origin"),
    secFetchSite: request.headers.get("Sec-Fetch-Site"),
    secFetchMode: request.headers.get("Sec-Fetch-Mode"),
  };

  return { debug };
};

export default function AuthLoginDebug() {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const data = useLoaderData<typeof loader>();

  if (!("debug" in data)) return null;

  return (
    <div style={{ padding: 20, fontFamily: "monospace", maxWidth: 800 }}>
      <h2 style={{ color: "#c33" }}>/auth/login 触发调试信息</h2>
      <p>
        请求到达了 <code>/auth/login</code> 但没有 <code>?shop</code> 参数。
        以下信息可以帮助定位触发来源：
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {(Object.entries(data.debug) as [string, string | null][]).map(([key, value]) => (
            <tr key={key}>
              <td
                style={{
                  fontWeight: 700,
                  padding: 8,
                  border: "1px solid #999",
                  verticalAlign: "top",
                  whiteSpace: "nowrap",
                }}
              >
                {key}
              </td>
              <td
                style={{
                  padding: 8,
                  border: "1px solid #999",
                  wordBreak: "break-all",
                }}
              >
                {value ?? <em style={{ color: "#999" }}>null</em>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
