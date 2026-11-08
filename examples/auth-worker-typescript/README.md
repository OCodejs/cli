# GitHub OAuth + Cloudflare Worker + D1 (TypeScript)

Mẫu này triển khai OAuth web flow của GitHub trong Cloudflare Worker. Token GitHub được mã hóa AES-GCM trước khi lưu vào D1; session ID, CSRF token và OAuth state chỉ lưu dưới dạng hash.

## Cài đặt

```bash
npm install
cp .dev.vars.example .dev.vars
```

Tạo khóa mã hóa 32 byte dạng base64:

```bash
openssl rand -base64 32
```

Tạo secret session:

```bash
openssl rand -hex 48
```

Điền các giá trị vào `.dev.vars`. File này không được commit.

## Tạo D1 và cập nhật Wrangler

```bash
npx wrangler login
npx wrangler d1 create ocodejs-auth-ts-example
```

Copy `database_id` từ output vào `wrangler.jsonc`, rồi chạy migration local:

```bash
npx wrangler d1 execute ocodejs-auth-ts-example --local --file=./migrations/0001_init.sql
```

Khi đã sẵn sàng cho production:

```bash
npx wrangler d1 execute ocodejs-auth-ts-example --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute ocodejs-auth-ts-example --remote --file=./migrations/0002_refresh_tokens.sql
```

## Tạo GitHub OAuth App

Đăng ký tại GitHub → Settings → Developer settings → OAuth Apps.

- Homepage URL: `https://zskbot.github.io/ocodejs-cli/`
- Authorization callback URL: giá trị của `GITHUB_REDIRECT_URI` trong môi trường tương ứng
- Scope mẫu: `read:user`

Không dùng Client Secret trong frontend hoặc `vars`.

## Cấu hình secrets bằng Wrangler

Production:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

Mỗi lệnh sẽ yêu cầu nhập giá trị bí mật. Không đưa secret trực tiếp vào shell history.

Để kiểm tra tên secret mà không in giá trị:

```bash
npx wrangler secret list
```

Nếu cần xóa một secret:

```bash
npx wrangler secret delete GITHUB_CLIENT_SECRET
```

## Local development

Local callback phải trỏ đến Worker dev URL hoặc URL local được bạn đăng ký trong OAuth App riêng. Cách đơn giản là tạo OAuth App local riêng, chạy:

```bash
npx wrangler dev --local
```

Cập nhật `.dev.vars` và `wrangler.jsonc` để `GITHUB_REDIRECT_URI` khớp URL callback thực tế. Sau đó mở `http://localhost:8787/auth/github` hoặc URL mà Wrangler in ra.

## Unit tests

Unit test dùng Vitest và mock D1/fetch để không gọi GitHub hoặc Cloudflare thật:

```bash
npm test
npm run test:worker
npm run test:frontend
```

Bộ test kiểm tra health/CORS, tạo OAuth state và callback URL, từ chối state sai, đổi code lấy token, lưu credential/session, cấp CSRF token, chặn request thiếu CSRF, gọi GitHub user API sau khi session hợp lệ và refresh access token hết hạn.

OAuth request dùng `read:user offline_access`. Khi GitHub trả về access token hết hạn, Worker dùng refresh token đã mã hóa để lấy token mới, cập nhật D1 và thử lại request GitHub một lần. Refresh token hết hạn hoặc refresh thất bại sẽ không lặp vô hạn.

## Preview và production

Nên tách OAuth App và D1 database cho preview. Có thể dùng Wrangler environment riêng, ví dụ:

```bash
npx wrangler d1 create ocodejs-auth-preview
npx wrangler secret put GITHUB_CLIENT_ID --env preview
npx wrangler secret put GITHUB_CLIENT_SECRET --env preview
npx wrangler secret put SESSION_SECRET --env preview
npx wrangler secret put TOKEN_ENCRYPTION_KEY --env preview
npx wrangler d1 execute ocodejs-auth-preview --remote --file=./migrations/0001_init.sql --env preview
npx wrangler deploy --env preview
```

Trong `wrangler.jsonc`, thêm `env.preview` với `name`, `vars`, `d1_databases` và callback preview riêng. Không dùng credential production cho preview.

Deploy production:

```bash
npm run test
npx wrangler deploy
```

Kiểm tra:

```bash
curl -i https://auth.example.com/health
```

Các endpoint mẫu:

- `GET /auth/github`: bắt đầu OAuth
- `GET /auth/github/callback`: đổi code lấy token, lưu user/session
- `GET /auth/session`: trả trạng thái session và CSRF token mới
- `GET /api/github/user`: gọi GitHub API bằng token đã giải mã trong Worker
- `POST /auth/logout`: cần header `Origin` đúng và `X-Ocode-CSRF`

## GitHub Actions CI/CD

File `.github/workflows/auth-worker-deploy.yml` chạy test trên mọi push vào `main` có thay đổi Worker, vì một Pull Request merge vào `main` sẽ tạo push event. Sau khi test thành công, job deploy chạy `npx wrangler deploy`.

Trong **Settings → Environments → production**, tạo hai GitHub Actions secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

API token nên chỉ có quyền tối thiểu để deploy Worker và quản lý D1 trong đúng Cloudflare account. Các secret runtime của Worker như `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` và `TOKEN_ENCRYPTION_KEY` phải được đặt trước trong Cloudflare bằng `wrangler secret put`; không truyền chúng qua GitHub Actions.

Đổi `https://auth.example.com` trong workflow thành hostname production thật. Có thể chạy thủ công bằng `workflow_dispatch` để kiểm tra pipeline, nhưng production deploy vẫn chờ job test hoàn tất.

## Lưu ý

Mẫu này dùng cookie `SameSite=None; Secure` cho frontend/API khác origin. CORS chỉ cho phép `APP_ORIGIN`. Hãy dùng HTTPS, custom domain ổn định, rate limit, cleanup các state/session hết hạn và kiểm thử trình duyệt mục tiêu trước khi đưa vào production.
