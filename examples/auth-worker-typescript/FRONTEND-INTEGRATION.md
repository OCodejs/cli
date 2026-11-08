# Tích hợp frontend với GitHub OAuth Worker

Giả sử frontend chạy tại `https://zskbot.github.io` và Worker tại `https://auth.example.com`.

Thay `https://auth.example.com` bằng domain thật của Worker trong mọi ví dụ.

## 1. Cấu hình bắt buộc

Worker phải có các giá trị:

```text
APP_ORIGIN=https://zskbot.github.io
APP_BASE_PATH=/ocodejs-cli/
GITHUB_REDIRECT_URI=https://auth.example.com/auth/github/callback
```

`APP_ORIGIN` phải khớp chính xác origin của frontend. Không thêm dấu `/` cuối, path, wildcard hoặc `*`.

GitHub OAuth App phải đăng ký callback URL giống hệt `GITHUB_REDIRECT_URI`.

## 2. Vì sao phải dùng `credentials: "include"`?

Sau callback thành công, Worker đặt cookie session cho domain API. Frontend và Worker khác origin nên mọi request cần gửi:

```ts
fetch("https://auth.example.com/auth/session", {
  credentials: "include",
});
```

Worker đồng thời trả về CORS headers cho đúng `APP_ORIGIN`. Không được thay bằng `Access-Control-Allow-Origin: *` khi dùng cookie.

## 3. Bắt đầu đăng nhập

Không gọi endpoint login bằng `fetch`, vì endpoint này phải chuyển hướng trình duyệt sang GitHub:

```ts
const API = "https://auth.example.com";

function loginWithGithub(): void {
  window.location.assign(`${API}/auth/github`);
}
```

HTML:

```html
<button id="github-login">Đăng nhập bằng GitHub</button>
<script type="module">
  document.querySelector("#github-login")?.addEventListener("click", () => {
    window.location.assign("https://auth.example.com/auth/github");
  });
</script>
```

Luồng diễn ra như sau:

1. Frontend điều hướng đến `/auth/github`.
2. Worker tạo `state`, lưu hash của state trong D1 và đặt state cookie HttpOnly.
3. Worker redirect đến GitHub với `client_id`, `redirect_uri`, `scope=read:user` và `state`.
4. Người dùng cấp quyền trên GitHub.
5. GitHub gọi `/auth/github/callback?code=...&state=...`.
6. Worker kiểm tra state, đổi code lấy access token, mã hóa token và lưu vào D1.
7. Worker tạo session cookie rồi redirect người dùng về `APP_ORIGIN + APP_BASE_PATH + ?auth=connected`.

## 4. Khôi phục session sau callback

Frontend cần gọi `/auth/session` sau mỗi lần tải trang, đặc biệt khi URL có `auth=connected`:

```ts
async function getSession() {
  const response = await fetch(`${API}/auth/session`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) throw new Error(`Session check failed: ${response.status}`);
  return response.json();
}

const session = await getSession();
if (session.connected) {
  console.log("Đã đăng nhập:", session.user);
  // Lưu CSRF token trong memory hoặc sessionStorage.
  sessionStorage.setItem("ocode_worker_csrf", session.csrfToken);
} else {
  console.log("Chưa đăng nhập");
}
```

Response thành công có dạng:

```json
{
  "connected": true,
  "user": {
    "id": "241179063",
    "login": "zskbot",
    "method": "oauth",
    "scopes": ["read:user"]
  },
  "csrfToken": "one-time-client-token"
}
```

Nên xóa query `auth=connected` khỏi thanh địa chỉ sau khi xử lý để URL sạch hơn:

```ts
const url = new URL(window.location.href);
if (url.searchParams.has("auth")) {
  url.searchParams.delete("auth");
  window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
}
```

## 5. Lấy thông tin GitHub user

Mẫu Worker yêu cầu CSRF token cho endpoint này. Dù đây là `GET`, cách này giữ cùng một quy tắc xác thực cho các API dùng session:

```ts
async function getGithubUser() {
  const csrf = sessionStorage.getItem("ocode_worker_csrf");
  if (!csrf) throw new Error("Chưa có CSRF token");

  const response = await fetch(`${API}/api/github/user`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Ocode-CSRF": csrf,
    },
  });

  if (response.status === 401) {
    sessionStorage.removeItem("ocode_worker_csrf");
    throw new Error("Session đã hết hạn");
  }
  if (!response.ok) throw new Error(`GitHub user request failed: ${response.status}`);
  return response.json();
}
```

Worker giải mã credential ở phía server rồi gọi `GET https://api.github.com/user`. Token GitHub không được gửi về frontend.

## 6. Liệt kê repository

Nếu Worker có thêm endpoint `/api/github/repos`:

```ts
async function getRepositories(page = 1) {
  const csrf = sessionStorage.getItem("ocode_worker_csrf");
  const response = await fetch(`${API}/api/github/repos?page=${page}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Ocode-CSRF": csrf ?? "",
    },
  });

  if (!response.ok) throw new Error(`Repository request failed: ${response.status}`);
  return response.json();
}
```

## 7. Logout

Logout phải là `POST`, gửi cookie và CSRF token:

```ts
async function logout() {
  const csrf = sessionStorage.getItem("ocode_worker_csrf");
  const response = await fetch(`${API}/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Ocode-CSRF": csrf ?? "",
    },
  });

  if (!response.ok) throw new Error(`Logout failed: ${response.status}`);
  sessionStorage.removeItem("ocode_worker_csrf");
}
```

Sau logout, Worker xóa session trong D1 và gửi cookie có `Max-Age=0`.

## 8. Dùng module có sẵn

File `frontend-auth.ts` trong thư mục này đóng gói các thao tác trên:

```ts
import { WorkerAuthClient } from "./frontend-auth.js";

const auth = new WorkerAuthClient("https://auth.example.com");

loginButton.addEventListener("click", () => auth.startGithubLogin());

const session = await auth.getSession();
if (session.connected) {
  const user = await auth.getGithubUser();
  console.log(user.login);
}

logoutButton.addEventListener("click", () => auth.logout());
```

## 9. Xử lý lỗi thường gặp

- `origin_not_allowed`: `APP_ORIGIN` không khớp origin frontend, hoặc request đến từ domain khác.
- `oauth_state_invalid`: state cookie không được gửi, callback URL sai, hoặc cookie bị chặn.
- `oauth_state_expired_or_used`: người dùng chờ quá lâu hoặc refresh callback.
- `not_authenticated`: cookie session không được gửi; kiểm tra `credentials: "include"`, HTTPS và cookie policy.
- `csrf_check_failed`: gọi `/api/github/user` hoặc `/auth/logout` mà thiếu CSRF token mới nhất.
- `github_oauth_exchange_failed`: Client ID/secret, callback URL hoặc code không khớp.
- `github_user_request_failed`: access token hết hạn, bị thu hồi hoặc thiếu quyền.

## 10. Kiểm thử trình duyệt

Kiểm tra bằng DevTools:

1. Request `/auth/github` trả về `302` đến GitHub.
2. Callback trả về `302` về frontend và có `Set-Cookie` session.
3. Request `/auth/session` có cookie request và trả về `connected:true`.
4. Request `/api/github/user` có `X-Ocode-CSRF` và `credentials: include`.
5. Response API có `Access-Control-Allow-Origin` đúng frontend origin và `Access-Control-Allow-Credentials: true`.

Không log cookie, CSRF token, authorization code hoặc access token trong production.
