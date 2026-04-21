import { InspireCrypto } from "./crypto"
import { InspireTypes } from "./types"
import { pluginAuth, pluginCache } from "./ctx"

export namespace InspireAuth {
  let cachedCookie: { value: string; obtainedAt: number } | undefined
  let cachedToken: string | undefined

  export function notAuthenticatedError(target: "inspire" | "harbor"): InspireTypes.ToolResult {
    if (target === "inspire") {
      return {
        title: "未认证",
        output: [
          "启智平台账号未配置。",
          "",
          "请通过以下方式登录：",
          "  1. CLI: synergy inspire login",
          "  2. 或直接提供学工号和密码，agent 可以帮你执行登录",
        ].join("\n"),
        metadata: { error: "inspire_not_authenticated" },
      }
    }
    return {
      title: "未认证",
      output: [
        "Harbor 镜像仓库账号未配置。",
        "",
        "请通过以下方式登录：",
        "  1. CLI: synergy inspire harbor-login (七宝, 默认)",
        "  2. CLI: synergy inspire harbor-login --registry sj (松江)",
        "",
        "Harbor 的用户名和密码可在启智平台「镜像管理 → 本地推送」页面查看。",
        "首次打开该页面时会显示用户名和密码，请妥善保存。",
        "注意：七宝和松江的密码不同，需要分别配置。",
      ].join("\n"),
      metadata: { error: "harbor_not_authenticated" },
    }
  }

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

  export async function requireToken(): Promise<string> {
    if (cachedToken) return cachedToken

    try {
      const raw = await pluginCache().get("inspire-token")
      if (raw) {
        const cache: InspireTypes.TokenCache = typeof raw === "string" ? JSON.parse(raw) : raw
        if (cache.expires_at > Date.now()) {
          cachedToken = cache.token
          return cache.token
        }
      }
    } catch {}

    const creds = await getInspireCredentials()
    if (!creds) throw new Error("inspire_not_authenticated")

    const resp = await fetch(`${InspireTypes.PLATFORM_URL}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    })
    const data = (await resp.json()) as any
    if (data.code !== 0) {
      const message = data.message ?? "unknown error"
      console.warn("[inspire.auth] token auth failed", message)
      throw new Error(message)
    }

    const tokenData = data.data ?? data
    const token = tokenData.access_token as string
    const expiresIn = parseInt(tokenData.expires_in ?? "604800", 10)

    cachedToken = token
    const ttl = expiresIn * 1000
    await pluginCache().set("inspire-token", JSON.stringify({ token, expires_at: Date.now() + ttl }), ttl)
    return token
  }

  export function clearToken(): void {
    cachedToken = undefined
  }

  export async function requireCookie(): Promise<string> {
    if (cachedCookie) return cachedCookie.value

    const cookie = await performCasLogin()
    cachedCookie = { value: cookie, obtainedAt: Date.now() }
    return cookie
  }

  export function clearCookie(): void {
    cachedCookie = undefined
  }

  export async function withTokenRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await requireToken()
    try {
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

  function isAuthError(err: any): boolean {
    if (err?.status === 401) return true
    if (err?.code === -1) return true
    const msg = String(err?.message ?? err ?? "").toLowerCase()
    return msg.includes("401") || msg.includes("unauthorized") || msg.includes("session expired") || msg.includes("authentication expired")
  }

  export class TokenUnavailableError extends Error {
    constructor(
      message: string,
      public readonly reason: "not_authenticated" | "openapi_not_enabled" | "credentials_invalid" | "unknown",
    ) {
      super(message)
      this.name = "TokenUnavailableError"
    }
  }

  export async function ensureToken(): Promise<string> {
    try {
      return await requireToken()
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "").toLowerCase()
      if (msg.includes("invalid_grant") || msg.includes("invalid client") || msg.includes("access denied")) {
        try {
          await requireCookie()
          throw new TokenUnavailableError(
            "API 认证失败，但平台登录正常。可能该账号未开通 API 权限，将尝试其他认证方式。",
            "openapi_not_enabled",
          )
        } catch (cookieErr: any) {
          if (cookieErr instanceof TokenUnavailableError) throw cookieErr
          throw new TokenUnavailableError("用户名或密码错误，平台登录失败。请检查凭据。", "credentials_invalid")
        }
      }
      if (msg.includes("inspire_not_authenticated")) {
        throw new TokenUnavailableError("启智平台账号未配置。请运行 synergy inspire login。", "not_authenticated")
      }
      throw new TokenUnavailableError(`认证失败: ${err?.message ?? err}`, "unknown")
    }
  }

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

  export async function testInspireConnection(): Promise<boolean> {
    try {
      await requireCookie()
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
}
