import { InspireCrypto } from "./crypto"
import { InspireTypes } from "./types"
import { pluginAuth, pluginCache } from "./ctx"

const KEYCLOAK_BASE = "https://keycloak-inspire-prod.sii.edu.cn"
const KEYCLOAK_REALM = "inf-internal"
const KEYCLOAK_ROPC_CLIENT = "admin-cli"

const TOKEN_ENDPOINT = `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`

/** Slippage: refresh access_token this many ms before actual expiry */
const REFRESH_SLIPPAGE_MS = 60_000

interface KeycloakTokenSet {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_expires_in: number
  access_expires_at: number
  refresh_expires_at: number
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

  // ── Keycloak token acquisition ─────────────────────────────────

  export async function requireToken(): Promise<string> {
    if (cachedToken) return cachedToken

    // Try persisted token set (access + refresh)
    try {
      const raw = await pluginCache().get("inspire-keycloak-token")
      if (raw && raw !== "") {
        const cache: KeycloakTokenSet = typeof raw === "string" ? JSON.parse(raw) : raw

        // Access token still valid
        if (cache.access_expires_at > Date.now() + REFRESH_SLIPPAGE_MS) {
          cachedToken = cache.access_token
          return cache.access_token
        }

        // Access expired but refresh still valid → auto-renew
        if (cache.refresh_token && cache.refresh_expires_at > Date.now() + REFRESH_SLIPPAGE_MS) {
          try {
            const refreshed = await refreshTokenGrant(cache.refresh_token)
            await persistTokenSet(refreshed)
            cachedToken = refreshed.access_token
            return refreshed.access_token
          } catch {
            // Refresh failed (revoked / network), fall through to full login
          }
        }
      }
    } catch {}

    // Full ROPC login
    const creds = await getInspireCredentials()
    if (!creds) throw new TokenUnavailableError("inspire_not_authenticated", "not_authenticated")

    const result = await passwordGrant(creds.username, creds.password)
    await persistTokenSet(result)
    cachedToken = result.access_token
    return result.access_token
  }

  /**
   * Force-authenticate with the given credentials, bypassing ALL caches.
   *
   * Unlike `requireToken()`, this never reads in-memory or persisted tokens —
   * it calls Keycloak's password grant directly. On success, the newly
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
      const result = await passwordGrant(username, password)
      await persistTokenSet(result)
      cachedToken = result.access_token
    } catch (err) {
      // Invalidate all caches on failure so no stale token can be returned later.
      await invalidateAllTokens()
      throw err
    }
  }

  export function clearToken(): void {
    cachedToken = undefined
  }

  /**
   * Invalidate both the in-memory token cache AND the persisted Keycloak
   * token set. Writes a short-TTL empty value rather than relying on a
   * `delete` API that may not exist on all PluginCacheStore implementations.
   */
  export async function invalidateAllTokens(): Promise<void> {
    cachedToken = undefined
    try {
      await pluginCache().set("inspire-keycloak-token", "", 1)
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

  export async function withTokenRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      const token = await requireToken()
      return await fn(token)
    } catch (err: any) {
      if (isAuthError(err)) {
        clearToken()
        const freshToken = await requireToken()
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

  // ── Internal: Keycloak grant helpers ───────────────────────────

  async function passwordGrant(username: string, password: string): Promise<KeycloakTokenSet> {
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: KEYCLOAK_ROPC_CLIENT,
        username,
        password,
      }).toString(),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      if (err.error === "invalid_grant") {
        throw new TokenUnavailableError("用户名或密码错误", "credentials_invalid")
      }
      throw new TokenUnavailableError(
        `Keycloak 登录失败: ${err.error_description ?? err.error ?? resp.status}`,
        "unknown",
      )
    }

    return parseTokenResponse(await resp.json())
  }

  async function refreshTokenGrant(refreshToken: string): Promise<KeycloakTokenSet> {
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: KEYCLOAK_ROPC_CLIENT,
        refresh_token: refreshToken,
      }).toString(),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      if (err.error === "invalid_grant") {
        throw new TokenUnavailableError("登录已过期，请重新运行 synergy inspire login --username <学工号> --password <密码>", "refresh_expired")
      }
      throw new Error(`refresh_failed: ${err.error_description ?? err.error ?? resp.status}`)
    }

    return parseTokenResponse(await resp.json())
  }

  function parseTokenResponse(data: any): KeycloakTokenSet {
    const now = Date.now()
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in ?? 3600,
      refresh_expires_in: data.refresh_expires_in ?? 604800,
      access_expires_at: now + (data.expires_in ?? 3600) * 1000,
      refresh_expires_at: now + (data.refresh_expires_in ?? 604800) * 1000,
    }
  }

  async function persistTokenSet(tokenSet: KeycloakTokenSet): Promise<void> {
    const ttl = tokenSet.refresh_expires_in * 1000
    await pluginCache().set("inspire-keycloak-token", JSON.stringify(tokenSet), ttl)
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
