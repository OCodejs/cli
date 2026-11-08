export type AuthErrorCode =
  | "NETWORK_OFFLINE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "AUTH_REQUIRED"
  | "TOKEN_EXPIRED"
  | "CSRF_REFRESH_REQUIRED"
  | "OAUTH_FAILED"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "BAD_RESPONSE";

export class WorkerAuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "WorkerAuthError";
  }
}

export interface GithubUser {
  id: number | string;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

export interface SessionUser {
  id: string;
  login: string;
  method: "oauth";
  scopes: string[];
}

export interface AuthSession {
  connected: boolean;
  user?: SessionUser;
  csrfToken?: string;
}

type ErrorPayload = { error?: string; message?: string };

export class WorkerAuthClient {
  private readonly apiOrigin: string;
  private readonly csrfStorageKey = "ocode_worker_csrf";
  private csrfToken: string | null;

  constructor(apiOrigin: string) {
    this.apiOrigin = apiOrigin.replace(/\/$/, "");
    this.csrfToken = this.readStorage(this.csrfStorageKey);
  }

  startGithubLogin(): void {
    window.location.assign(`${this.apiOrigin}/auth/github`);
  }

  async getSession(options: { signal?: AbortSignal } = {}): Promise<AuthSession> {
    const response = await this.request("/auth/session", {
      signal: options.signal,
      retry: true,
    });
    const session = await this.readJson<AuthSession>(response);
    this.setCsrfToken(session.connected ? session.csrfToken ?? null : null);
    return session;
  }

  async getGithubUser(options: { signal?: AbortSignal; refreshCsrf?: boolean } = {}): Promise<GithubUser> {
    await this.ensureCsrf();
    try {
      const response = await this.request("/api/github/user", {
        signal: options.signal,
        headers: this.csrfHeaders(),
        retry: true,
      });
      return await this.readJson<GithubUser>(response);
    } catch (error) {
      // The Worker rotates CSRF on /auth/session. Refresh once for a stale CSRF.
      if (options.refreshCsrf !== false && this.isCode(error, "CSRF_REFRESH_REQUIRED")) {
        await this.getSession({ signal: options.signal });
        return this.getGithubUser({ ...options, refreshCsrf: false });
      }
      throw error;
    }
  }

  async logout(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.ensureCsrf();
    const response = await this.request("/auth/logout", {
      method: "POST",
      signal: options.signal,
      headers: this.csrfHeaders(),
      retry: false,
    });
    await this.readJson<{ disconnected: boolean }>(response);
    this.setCsrfToken(null);
  }

  /** Retry a read-only request after the UI has shown a retry action. */
  async retrySession(): Promise<AuthSession> {
    return this.getSession();
  }

  private async ensureCsrf(): Promise<void> {
    if (!this.csrfToken) {
      const session = await this.getSession();
      if (!session.connected || !this.csrfToken) {
        throw new WorkerAuthError("AUTH_REQUIRED", "Bạn cần đăng nhập GitHub trước.");
      }
    }
  }

  private async request(path: string, init: RequestInit & { retry?: boolean } = {}): Promise<Response> {
    const { retry = false, ...fetchInit } = init;
    const maxAttempts = retry && (fetchInit.method ?? "GET") === "GET" ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(path, fetchInit);
        if (response.ok) return response;

        const payload = await this.readErrorPayload(response);
        const mapped = this.mapHttpError(response.status, payload, response.headers);
        if (this.shouldRetryStatus(response.status) && attempt + 1 < maxAttempts) {
          await this.delay(this.backoff(attempt));
          continue;
        }
        throw mapped;
      } catch (error) {
        lastError = error;
        if (error instanceof WorkerAuthError && !this.isRetryable(error)) throw error;
        if (attempt + 1 < maxAttempts) {
          await this.delay(this.backoff(attempt));
          continue;
        }
      }
    }

    if (lastError instanceof WorkerAuthError) throw lastError;
    if (!navigator.onLine) {
      throw new WorkerAuthError("NETWORK_OFFLINE", "Thiết bị đang ngoại tuyến. Hãy kiểm tra mạng rồi thử lại.");
    }
    throw new WorkerAuthError("NETWORK_ERROR", "Không thể kết nối đến dịch vụ xác thực. Hãy thử lại.");
  }

  private async fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${this.apiOrigin}${path}`, {
        ...init,
        signal: this.mergeSignals(init.signal ?? undefined, controller.signal),
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new WorkerAuthError("TIMEOUT", "Dịch vụ phản hồi quá lâu. Hãy thử lại.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  private mapHttpError(status: number, payload: ErrorPayload, headers: Headers): WorkerAuthError {
    const apiCode = payload.error ?? "";
    const retryAfter = Number(headers.get("Retry-After")) || undefined;

    if (apiCode === "github_token_invalid" || apiCode === "github_user_request_failed" || apiCode === "github_token_refresh_failed") {
      this.setCsrfToken(null);
      return new WorkerAuthError("TOKEN_EXPIRED", "Token GitHub đã hết hạn hoặc bị thu hồi. Vui lòng đăng nhập lại.", status);
    }
    if (status === 401 || apiCode === "not_authenticated") {
      this.setCsrfToken(null);
      return new WorkerAuthError("AUTH_REQUIRED", "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", status);
    }
    if (status === 403 && apiCode === "csrf_check_failed") {
      return new WorkerAuthError("CSRF_REFRESH_REQUIRED", "Phiên bảo mật đã thay đổi; đang làm mới phiên.", status);
    }
    if (status === 429) {
      return new WorkerAuthError("RATE_LIMITED", "Bạn đang gửi quá nhiều yêu cầu. Hãy chờ rồi thử lại.", status, retryAfter);
    }
    if (status >= 500) {
      return new WorkerAuthError("SERVER_ERROR", "Dịch vụ xác thực đang gặp sự cố. Hãy thử lại sau.", status);
    }
    if (apiCode.startsWith("oauth_")) {
      return new WorkerAuthError("OAUTH_FAILED", "Đăng nhập GitHub không hoàn tất. Hãy thử lại.", status);
    }
    return new WorkerAuthError("BAD_RESPONSE", payload.message || apiCode || `Yêu cầu thất bại (${status}).`, status);
  }

  private async readErrorPayload(response: Response): Promise<ErrorPayload> {
    try {
      return await response.json() as ErrorPayload;
    } catch {
      return {};
    }
  }

  private async readJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new WorkerAuthError("BAD_RESPONSE", "Dịch vụ trả về dữ liệu không hợp lệ.", response.status);
    }
  }

  private csrfHeaders(): HeadersInit {
    if (!this.csrfToken) throw new WorkerAuthError("AUTH_REQUIRED", "Bạn cần đăng nhập GitHub trước.");
    return { "X-Ocode-CSRF": this.csrfToken };
  }

  private setCsrfToken(token: string | null): void {
    this.csrfToken = token;
    try {
      if (token) sessionStorage.setItem(this.csrfStorageKey, token);
      else sessionStorage.removeItem(this.csrfStorageKey);
    } catch {
      // Private browsing/storage-disabled mode: keep the token in memory only.
    }
  }

  private readStorage(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private isCode(error: unknown, code: AuthErrorCode): boolean {
    return error instanceof WorkerAuthError && error.code === code;
  }

  private isRetryable(error: WorkerAuthError): boolean {
    return ["NETWORK_OFFLINE", "NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR", "RATE_LIMITED"].includes(error.code);
  }

  private shouldRetryStatus(status: number): boolean {
    return [408, 425, 429, 502, 503, 504].includes(status);
  }

  private backoff(attempt: number): number {
    return Math.min(4_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
    const controller = new AbortController();
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  }
}
