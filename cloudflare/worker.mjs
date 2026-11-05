// PJQAQC 入口網站。靜態前端由 Static Assets 直接回應，只有 /api/* 會進到這裡。
//
// 匿名訪客（DEMO 模式）的資料全部在瀏覽器內產生，因此沒有工作階段 cookie 的請求
// 在此就結束，不會碰到 FastAPI 或 Supabase。真正的驗證仍由 FastAPI 負責，這裡只看
// cookie 是否存在，用來擋掉不必要的流量。
const SESSION_COOKIE = "__Host-pjqaqc_session";
const LOGIN_PATH = "/api/auth/login";
const SESSION_PATH = "/api/auth/session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const hasSessionCookie = (request) =>
  (request.headers.get("Cookie") || "")
    .split(";")
    .some((cookie) => cookie.trim().startsWith(`${SESSION_COOKIE}=`));

async function withinLimit(limiter, request) {
  if (!limiter) return true;
  const key = request.headers.get("CF-Connecting-IP") || "unknown";
  return (await limiter.limit({ key })).success;
}

async function proxyApi(request, env, url) {
  const isLogin = url.pathname === LOGIN_PATH;
  if (!isLogin && !hasSessionCookie(request)) {
    return url.pathname === SESSION_PATH
      ? json({ authenticated: false })
      : json({ detail: "請先登入編輯者帳號" }, 401);
  }
  if (!SAFE_METHODS.has(request.method) && request.headers.get("Origin") !== url.origin) {
    return json({ detail: "請從本站送出操作" }, 403);
  }
  if (!(await withinLimit(isLogin ? env.LOGIN_LIMIT : env.API_LIMIT, request))) {
    return json({ detail: "請求過於頻繁，請稍候再試" }, 429);
  }
  if (!env.API_ORIGIN || !env.EDGE_SHARED_SECRET) {
    return json({ detail: "編輯者後端尚未啟用" }, 503);
  }

  const upstream = new Request(new URL(url.pathname + url.search, env.API_ORIGIN), request);
  upstream.headers.set("X-PJQAQC-Edge", env.EDGE_SHARED_SECRET);
  try {
    const response = await (env.API_VPC ? env.API_VPC.fetch(upstream) : fetch(upstream));
    const proxied = new Response(response.body, response);
    proxied.headers.set("Cache-Control", "no-store");
    return proxied;
  } catch {
    return json({ detail: "目前無法連線至編輯者後端，請稍候再試" }, 502);
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    return url.pathname.startsWith("/api/")
      ? proxyApi(request, env, url)
      : env.ASSETS.fetch(request);
  },
};
