import { InspireCrypto } from "./crypto"
import { InspireTypes } from "./types"
import { pluginAuth, pluginCache } from "./ctx"

/**
 * OpenAPI token endpoint — the only auth path that APISIX gateway accepts
 * for /api/v2/* calls (as of 2026-05). Keycloak password-grant tokens
 * (admin-cli client, inf-internal realm) are rejected with 401.
 *
 * Response: { code: 0, data: { access_token: "eyJ..." } }
 * No refresh token — re-login when expired.
 */
const OPENAPI_TOKEN_URL = "https://qz.sii.edu.cn/auth/token"

/** Slippage: refresh access_token this many ms before actual expiry */
const REFRESH_SLIPPAGE_MS = 60_000

interface TokenSet {
  access_token: string
  access_expires_at: number
}

export namespace InspireAuth {
  let cachedToken: string | undefined

  // ── Credential management ──────────────────────────────────────

  export async function getInspireCredentials(): Promise<InspireTypes.InspireAuth | undefined> {
    try {
      const username = await pluginAuth().get("inspire-username")
      const password = await pluginAuth().get("inspire-password")
      if (!username || !password) return undefined
      return { username, password, saved_at: 0 }
    } catch {
      return undefined
    }
  }

  export async function saveInspireCredentials(username: string, password: string): Promise<void> {
    await pluginAuth().set("inspire-username", username)
    await pluginAuth().set("inspire-password", password)
  }

  export async function getHarborCredentials(
    target: InspireTypes.HarborTarget = "qb",
  ): Promise<InspireTypes.HarborAuth | undefined> {
    const suffix = target === "sj" ? "-sj" : ""
    try {
      const username = await pluginAuth().get(`harbor${suffix}-username`)
      const password = await pluginAuth().get(`harbor${suffix}-password`)
      if (!username || !password) return undefined
      return { username, password, registry: InspireTypes.harborRegistry(target), saved_at: 0 }
    } catch {
      return undefined
    }
  }

  export async function saveHarborCredentials(
    username: string,
    password: string,
    target: InspireTypes.HarborTarget = "qb",
  ): Promise<void> {
    const suffix = target === "sj" ? "-sj" : ""
    await pluginAuth().set(`harbor${suffix}-username`, username)
    await pluginAuth().set(`harbor${suffix}-password`, password)
  }

  // ── OpenAPI token acquisition ──────────────────────────────────

  export async function requireToken(): Promise<string> {
    if (cachedToken) return cachedToken

    // Try persisted token
    try {
      const raw = await pluginCache().get("inspire-openapi-token")
      if (raw && raw !== "") {
        const cache: TokenSet = typeof raw === "string" ? JSON.parse(raw) : raw
        if (cache.access_expires_at > Date.now() + REFRESH_SLIPPAGE_MS) {
          cachedToken = cache.access_token
          return cache.access_token
        }
      }
    } catch {}

    // Full login via OpenAPI /auth/token
    const creds = await getInspireCredentials()
    if (!creds) throw new TokenUnavailableError("inspire_not_authenticated", "not_authenticated")

    const result = await openapiTokenGrant(creds.username, creds.password)
    await persistTokenSet(result)
    cachedToken = result.access_token
    return result.access_token
  }

  /**
   * Force-authenticate with the given credentials, bypassing ALL caches.
   *
   * Unlike `requireToken()`, this never reads in-memory or persisted tokens —
   * it calls the OpenAPI /auth/token endpoint directly. On success, the newly
   * acquired token overwrites both caches so subsequent calls use it.
   * On failure, all caches are invalidated to prevent stale tokens from
   * masking the failure.
   *
   * Used by the login tool to validate new credentials before persisting
   * them, which prevents the credential-validation-bypass bug where a
   * cached token made the login tool report success even when the new
   * password was wrong.
   */
  export async function loginWithFreshCredentials(username: string, password: string): Promise<void> {
    try {
      const result = await openapiTokenGrant(username, password)
      await persistTokenSet(result)
      cachedToken = result.access_token
    } catch (err) {
      await invalidateAllTokens()
      throw err
    }
  }

  export function clearToken(): void {
    cachedToken = undefined
  }

  /**
   * Invalidate both the in-memory token cache AND the persisted token set.
   */
  export async function invalidateAllTokens(): Promise<void> {
    cachedToken = undefined
    try {
      await pluginCache().set("inspire-openapi-token", "", 1)
    } catch {
      // Ignore failures — the cached TTL will eventually expire.
    }
  }

  // ── Cookie auth (fallback for v1-only endpoints) ───────────────

  let cachedCookie: { value: string; obtainedAt: number } | undefined

  export async function requireCookie(): Promise<string> {
    if (cachedCookie) return cachedCookie.value
    const cookie = await performCasLogin()
    cachedCookie = { value: cookie, obtainedAt: Date.now() }
    return cookie
  }

  export function clearCookie(): void {
    cachedCookie = undefined
  }

  // ── Retry wrappers ─────────────────────────────────────────────

  /**
   * Force-acquire a new access token when the current cached one is
   * rejected by the platform (401). OpenAPI tokens have no refresh_token —
   * just re-login with saved credentials.
   */
  export async function forceRefreshToken(): Promise<string> {
    cachedToken = undefined
    await invalidateAllTokens()
    const creds = await getInspireCredentials()
    if (!creds) throw new TokenUnavailableError("inspire_not_authenticated", "not_authenticated")

    const result = await openapiTokenGrant(creds.username, creds.password)
    await persistTokenSet(result)
    cachedToken = result.access_token
    return result.access_token
  }

  export async function withTokenRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      const token = await requireToken()
      return await fn(token)
    } catch (err: any) {
      if (isAuthError(err)) {
        // Don't just clear the in-memory cache — the persisted cache
        // likely holds the same revoked token. Force a fresh login.
        const freshToken = await forceRefreshToken()
        return await fn(freshToken)
      }
      throw err
    }
  }

  export async function withCookieRetry<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
    const cookie = await requireCookie()
    try {
      return await fn(cookie)
    } catch (err: any) {
      if (isAuthError(err)) {
        clearCookie()
        const freshCookie = await requireCookie()
        return await fn(freshCookie)
      }
      throw err
    }
  }

  // ── Error types ────────────────────────────────────────────────

  export class TokenUnavailableError extends Error {
    constructor(
      message: string,
      public readonly reason: "not_authenticated" | "credentials_invalid" | "refresh_expired" | "unknown",
    ) {
      super(message)
      this.name = "TokenUnavailableError"
    }
  }

  export function notAuthenticatedError(target: "inspire" | "harbor"): InspireTypes.ToolResult {
    if (target === "inspire") {
      return {
        title: "未认证",
        output: [
          "启智平台账号未配置。",
          "",
          "请告诉 agent 你的学工号和密码，agent 会通过 inspire_login 工具帮你完成登录。",
          "例如：\"帮我登录启智平台，学工号 xxx，密码 yyy\"",
          "",
          "也可以通过 CLI 登录：synergy inspire login --username <学工号> --password <密码>",
        ].join("\n"),
        metadata: { error: "inspire_not_authenticated" },
      }
    }
    return {
      title: "未认证",
      output: [
        "Harbor 镜像仓库账号未配置。",
        "",
        "请告诉 agent 你的 Harbor 用户名和密码，agent 会通过 inspire_login 工具帮你完成登录。",
        "例如：\"帮我登录 Harbor，用户名 xxx，密码 yyy\"",
        "",
        "也可以通过 CLI 登录：synergy inspire harbor-login --username <用户名> --password <密码>",
        "",
        "⚠️ Harbor 账号不是你的启智平台账号！",
        "Harbor 的用户名和密码需在启智平台「镜像管理 → 本地推送」页面查看。",
        "首次打开该页面时会显示用户名（形如 robot$inspire-studio+user-...）和密码，请妥善保存。",
        "七宝和松江的密码不同，需要分别配置。",
      ].join("\n"),
      metadata: { error: "harbor_not_authenticated" },
    }
  }

  // ── Token with semantic error classification ───────────────────

  export async function ensureToken(): Promise<string> {
    try {
      return await requireToken()
    } catch (err: any) {
      if (err instanceof TokenUnavailableError) throw err
      const msg = String(err?.message ?? err ?? "").toLowerCase()
      if (msg.includes("invalid_grant") || msg.includes("credentials_invalid")) {
        throw new TokenUnavailableError("用户名或密码错误，请重新运行 synergy inspire login --username <学工号> --password <密码>", "credentials_invalid")
      }
      if (msg.includes("inspire_not_authenticated") || msg.includes("not_authenticated")) {
        throw new TokenUnavailableError("启智平台账号未配置。请运行 synergy inspire login --username <学工号> --password <密码>", "not_authenticated")
      }
      throw new TokenUnavailableError(`认证失败: ${err?.message ?? err}`, "unknown")
    }
  }

  // ── Connection tests ───────────────────────────────────────────

  export async function testInspireConnection(): Promise<boolean> {
    try {
      await requireToken()
      return true
    } catch {
      return false
    }
  }

  export async function testHarborConnection(target: InspireTypes.HarborTarget = "qb"): Promise<boolean> {
    const creds = await getHarborCredentials(target)
    if (!creds) return false
    try {
      const registry = InspireTypes.harborRegistry(target)
      const resp = await fetch(`https://${registry}/api/v2.0/projects?page_size=1`, {
        headers: { Authorization: "Basic " + btoa(`${creds.username}:${creds.password}`) },
      })
      return resp.ok
    } catch {
      return false
    }
  }

  // ── Internal: OpenAPI token grant ──────────────────────────────

  async function openapiTokenGrant(username: string, password: string): Promise<TokenSet> {
    const resp = await fetch(OPENAPI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })

    if (!resp.ok) {
      throw new TokenUnavailableError(
        `OpenAPI 登录失败: HTTP ${resp.status}`,
        "unknown",
      )
    }

    const data = await resp.json()
    // Response: { code: 0, message: "", data: { access_token: "eyJ..." } }
    const token = data?.data?.access_token ?? data?.access_token
    if (!token) {
      throw new TokenUnavailableError(
        `OpenAPI 登录失败: 响应中无 access_token (code=${data?.code})`,
        "credentials_invalid",
      )
    }

    return parseTokenResponse(token)
  }

  function parseTokenResponse(accessToken: string): TokenSet {
    // Decode JWT to get exp
    let exp = Date.now() + 3600 * 1000 // default 1h
    try {
      const payload = accessToken.split(".")[1]
      // Fix base64url padding
      const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4)
      const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"))
      if (decoded.exp) {
        exp = decoded.exp * 1000
      }
    } catch {
      // Fall back to default expiry
    }

    return {
      access_token: accessToken,
      access_expires_at: exp,
    }
  }

  async function persistTokenSet(tokenSet: TokenSet): Promise<void> {
    const ttl = Math.max(tokenSet.access_expires_at - Date.now(), 60_000)
    await pluginCache().set("inspire-openapi-token", JSON.stringify(tokenSet), ttl)
  }

  // ── Internal: error classification ─────────────────────────────

  function isAuthError(err: any): boolean {
    if (err?.status === 401) return true
    if (err?.code === -1) return true
    const msg = String(err?.message ?? err ?? "").toLowerCase()
    return (
      msg.includes("401") ||
      msg.includes("unauthorized") ||
      msg.includes("session expired") ||
      msg.includes("authentication expired")
    )
  }

  // ── Internal: CAS cookie login ─────────────────────────────────

  async function performCasLogin(): Promise<string> {
    const creds = await getInspireCredentials()
    if (!creds) throw new Error("inspire_not_authenticated")

    const session = {
      cookies: new Map<string, Map<string, string>>(),
      addCookies(domain: string, setCookieHeaders: string[]) {
        if (!this.cookies.has(domain)) this.cookies.set(domain, new Map())
        const jar = this.cookies.get(domain)!
        for (const header of setCookieHeaders) {
          const [pair] = header.split(";")
          const eqIdx = pair.indexOf("=")
          if (eqIdx > 0) {
            jar.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim())
          }
        }
      },
      getCookieString(domain: string): string {
        const entries: string[] = []
        for (const [d, jar] of this.cookies) {
          if (domain.includes(d) || d.includes(domain)) {
            for (const [k, v] of jar) entries.push(`${k}=${v}`)
          }
        }
        return entries.join("; ")
      },
    }

    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"

    let currentUrl = InspireTypes.PLATFORM_URL
    let html = ""

    for (let i = 0; i < 10; i++) {
      const resp = await fetch(currentUrl, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: session.getCookieString(new URL(currentUrl).hostname),
        },
        redirect: "manual",
      })

      const setCookies = resp.headers.getSetCookie?.() ?? []
      session.addCookies(new URL(currentUrl).hostname, setCookies)

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location")
        if (!location) break
        currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).toString()
        continue
      }

      html = await resp.text()
      break
    }

    const hostname = new URL(currentUrl).hostname
    if (hostname === "qz.sii.edu.cn") {
      const cookieStr = session.getCookieString("qz.sii.edu.cn")
      if (cookieStr.includes("session")) return cookieStr
    }

    if (currentUrl.includes("keycloak")) {
      const casMatch = html.match(/"loginUrl":\s*"([^"]*broker\/cas\/login[^"]*)"/)
      if (!casMatch) throw new Error("Keycloak 页面中未找到 CAS 登录链接")
      let casUrl = casMatch[1].replace(/\\\//g, "/")
      if (!casUrl.startsWith("http")) {
        const parsed = new URL(currentUrl)
        casUrl = `${parsed.protocol}//${parsed.host}${casUrl}`
      }

      currentUrl = casUrl
      for (let i = 0; i < 10; i++) {
        const resp = await fetch(currentUrl, {
          headers: {
            "User-Agent": ua,
            Cookie: session.getCookieString(new URL(currentUrl).hostname),
          },
          redirect: "manual",
        })
        const setCookies = resp.headers.getSetCookie?.() ?? []
        session.addCookies(new URL(currentUrl).hostname, setCookies)

        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get("location")
          if (!location) break
          currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).toString()
          continue
        }
        html = await resp.text()
        break
      }
    }

    if (!currentUrl.includes("cas.sii.edu.cn")) {
      throw new Error(`未能到达 CAS 登录页面，当前 URL: ${currentUrl}`)
    }

    const encrypted = InspireCrypto.encryptPassword(creds.password)
    const ltMatch = html.match(/name="lt"\s+value="([^"]+)"/)
    const execMatch = html.match(/name="execution"\s+value="([^"]+)"/)

    const formData = new URLSearchParams()
    formData.set("username", creds.username)
    formData.set("password", encrypted)
    formData.set("_eventId", "submit")
    formData.set("submit", "登 录")
    formData.set("loginType", "1")
    formData.set("encrypted", "true")
    if (ltMatch) formData.set("lt", ltMatch[1])
    if (execMatch) formData.set("execution", execMatch[1])

    currentUrl = currentUrl
    for (let i = 0; i < 15; i++) {
      const isPost = i === 0
      const resp = await fetch(currentUrl, {
        method: isPost ? "POST" : "GET",
        headers: {
          "User-Agent": ua,
          ...(isPost
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: "https://cas.sii.edu.cn",
                Referer: currentUrl,
              }
            : {}),
          Cookie: session.getCookieString(new URL(currentUrl).hostname),
        },
        ...(isPost ? { body: formData.toString() } : {}),
        redirect: "manual",
      })

      const setCookies = resp.headers.getSetCookie?.() ?? []
      session.addCookies(new URL(currentUrl).hostname, setCookies)

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location")
        if (!location) break
        currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).toString()
        continue
      }

      html = await resp.text()

      if (new URL(currentUrl).hostname === "qz.sii.edu.cn") break

      if (currentUrl.includes("cas.sii.edu.cn") && currentUrl.includes("login")) {
        if (html.includes("用户名或密码错误") || html.includes("账号或密码错误")) {
          throw new Error("用户名或密码错误")
        }
        if (html.includes("验证码")) {
          throw new Error("需要输入验证码，请在浏览器中登录后手动获取 cookie")
        }
        throw new Error("登录失败，请检查用户名和密码")
      }

      break
    }

    if (new URL(currentUrl).hostname !== "qz.sii.edu.cn") {
      const resp = await fetch(InspireTypes.PLATFORM_URL, {
        headers: { "User-Agent": ua, Cookie: session.getCookieString("qz.sii.edu.cn") },
        redirect: "manual",
      })
      const setCookies = resp.headers.getSetCookie?.() ?? []
      session.addCookies("qz.sii.edu.cn", setCookies)
    }

    const cookieStr = session.getCookieString("qz.sii.edu.cn")
    if (!cookieStr.includes("session")) {
      throw new Error("登录成功但未建立会话，请重试或检查网络环境")
    }

    return cookieStr
  }
}
