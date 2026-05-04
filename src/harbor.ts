import { InspireAuth } from "./auth"
import { InspireTypes } from "./types"

export namespace InspireHarbor {
  const log = { info: (..._args: any[]) => {} }

  const BASE = `https://${InspireTypes.HARBOR_REGISTRY}/api/v2.0`
  const PROJECT = InspireTypes.HARBOR_PROJECT

  export interface HarborRepoInfo {
    name: string
    short_name: string
    description: string
    artifact_count: number
    pull_count: number
    update_time: string
  }

  export interface HarborArtifactInfo {
    tags: string[]
    size_bytes: number
    size_gb: number
    push_time: string
    digest: string
  }

  async function authHeader(): Promise<string> {
    const creds = await InspireAuth.getHarborCredentials()
    if (!creds) throw new Error("harbor_not_authenticated")
    return "Basic " + btoa(`${creds.username}:${creds.password}`)
  }

  function stripProjectPrefix(name: string): string {
    const prefix = `${PROJECT}/`
    return name.startsWith(prefix) ? name.slice(prefix.length) : name
  }

  export async function listRepositories(opts?: {
    search?: string
    limit?: number
    page?: number
  }): Promise<{ total: number; repositories: HarborRepoInfo[] }> {
    const limit = opts?.limit ?? 20
    const page = opts?.page ?? 1
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(limit),
      sort: "-update_time",
    })
    if (opts?.search) params.set("q", `name=~${opts.search}`)

    const url = `${BASE}/projects/${PROJECT}/repositories?${params}`
    log.info("listing repositories", { url })

    const resp = await fetch(url, {
      headers: { Authorization: await authHeader() },
    })
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Harbor API error ${resp.status}: ${body}`)
    }

    const total = parseInt(resp.headers.get("X-Total-Count") ?? "0", 10)
    const raw = (await resp.json()) as any[]

    const repositories: HarborRepoInfo[] = raw.map((r) => ({
      name: r.name,
      short_name: stripProjectPrefix(r.name),
      description: r.description ?? "",
      artifact_count: r.artifact_count ?? 0,
      pull_count: r.pull_count ?? 0,
      update_time: r.update_time ?? "",
    }))

    return { total, repositories }
  }

  export async function listArtifacts(repoName: string, opts?: { limit?: number }): Promise<HarborArtifactInfo[]> {
    const bare = stripProjectPrefix(repoName)
    const limit = opts?.limit ?? 50
    const url = `${BASE}/projects/${PROJECT}/repositories/${encodeURIComponent(bare)}/artifacts?page_size=${limit}`
    log.info("listing artifacts", { repo: bare })

    const resp = await fetch(url, {
      headers: { Authorization: await authHeader() },
    })
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Harbor API error ${resp.status}: ${body}`)
    }

    const raw = (await resp.json()) as any[]
    return raw.map((a) => {
      const sizeBytes = a.size ?? 0
      return {
        tags: (a.tags ?? []).map((t: any) => t.name),
        size_bytes: sizeBytes,
        size_gb: Math.round((sizeBytes / 1024 ** 3) * 10) / 10,
        push_time: a.push_time ?? "",
        digest: a.digest ?? "",
      }
    })
  }

  export async function setDescription(repoName: string, description: string): Promise<void> {
    const bare = stripProjectPrefix(repoName)
    const url = `${BASE}/projects/${PROJECT}/repositories/${encodeURIComponent(bare)}`
    log.info("updating description", { repo: bare })

    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: await authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description }),
    })
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Harbor API error ${resp.status}: ${body}`)
    }
  }

  // ── Push error taxonomy ────────────────────────────────────────

  export type PushErrorKind =
    | "auth_failed"
    | "permission_denied"
    | "image_missing"
    | "daemon_down"
    | "size_limit"
    | "tls"
    | "network"
    | "harbor_unavailable"
    | "unknown"

  export interface PushErrorContext {
    fullPath?: string
    registry?: string
    image?: string
    attempts?: PushError[]
  }

  export class PushError extends Error {
    context: PushErrorContext = {}

    constructor(
      public readonly kind: PushErrorKind,
      public readonly tool: string,
      public readonly raw: string,
    ) {
      super(`[${tool}] ${kind}: ${raw.slice(0, 200)}`)
      this.name = "PushError"
    }

    /** Whether trying a different tool might succeed. */
    get retriable(): boolean {
      return this.kind === "image_missing" || this.kind === "daemon_down" || this.kind === "unknown"
    }
  }

  // Pattern matchers are ordered — first match wins. Reasoning:
  //   • `auth_failed` precedes `network`: some tools phrase 401 via "connection closed"
  //   • `image_missing` precedes `daemon_down`: "image not known" can ride alongside daemon text
  //   • `daemon_down` precedes `network`: the docker-specific signal is more actionable
  //     than the generic "connection refused" it may echo
  const PUSH_ERROR_RULES: Array<{ kind: PushErrorKind; match: RegExp }> = [
    { kind: "auth_failed", match: /unauthorized|invalid credentials|invalid username|authentication required|401 unauthorized/i },
    { kind: "permission_denied", match: /denied: requested access|403 forbidden|insufficient_scope/i },
    { kind: "image_missing", match: /no such image|not found locally|image not known|reference does not exist|not in containers-storage|no image found/i },
    { kind: "daemon_down", match: /cannot connect to the docker daemon|is the docker daemon running|daemon is not running/i },
    { kind: "size_limit", match: /413 payload too large|blob upload invalid|manifest invalid|max size exceeded/i },
    { kind: "tls", match: /x509:|tls:|certificate|insecure-registry|server gave http response to https client/i },
    { kind: "network", match: /connection refused|etimedout|no route to host|no such host|i\/o timeout|network is unreachable/i },
    { kind: "harbor_unavailable", match: /5\d\d (internal server error|bad gateway|service unavailable|gateway timeout)|error from registry|\bunavailable\b|registry returned error/i },
  ]

  function classifyStderr(stderr: string): PushErrorKind {
    for (const rule of PUSH_ERROR_RULES) {
      if (rule.match.test(stderr)) return rule.kind
    }
    return "unknown"
  }

  // Ordered from most- to least-informative. When several tool attempts
  // each produce a different PushError, we surface the one earliest in
  // this list — it's the most likely root cause to act on.
  const AGGREGATION_PRIORITY: PushErrorKind[] = [
    "auth_failed",
    "permission_denied",
    "size_limit",
    "tls",
    "harbor_unavailable",
    "network",
    "daemon_down",
    "image_missing",
    "unknown",
  ]

  function primaryError(attempts: PushError[]): PushError {
    for (const kind of AGGREGATION_PRIORITY) {
      const hit = attempts.find((a) => a.kind === kind)
      if (hit) return hit
    }
    return attempts[attempts.length - 1]
  }

  // ── Push ───────────────────────────────────────────────────────

  const PUSH_TOOLS = ["docker", "podman", "buildah", "skopeo"] as const
  type PushTool = (typeof PUSH_TOOLS)[number]

  export async function pushImage(opts: {
    localImage: string
    remoteName: string
    remoteTag: string
    target?: InspireTypes.HarborTarget
  }): Promise<{ fullPath: string; digest?: string; warnedDuplicatePath?: boolean; tool: string }> {
    const target = opts.target ?? "qb"
    const creds = await InspireAuth.getHarborCredentials(target)
    if (!creds) {
      const registryName = target === "sj" ? "松江 (docker-t.sii.edu.cn)" : "七宝 (docker-qb.sii.edu.cn)"
      throw new Error(
        `harbor_not_authenticated: ${registryName} 未配置凭据。请运行 synergy inspire harbor-login --username <用户名> --password <密码> --registry ${target}\n⚠️ Harbor 账号不是启智平台账号，需在「镜像管理 → 本地推送」页面获取。`,
      )
    }

    // Strip project prefix if user accidentally included it
    let remoteName = opts.remoteName
    let warnedDuplicatePath = false
    const projectPrefix = `${PROJECT}/`
    if (remoteName.startsWith(projectPrefix)) {
      remoteName = remoteName.slice(projectPrefix.length)
      warnedDuplicatePath = true
    }

    const registry = InspireTypes.harborRegistry(target)
    const fullPath = `${registry}/${PROJECT}/${remoteName}:${opts.remoteTag}`
    const pushOpts = { localImage: opts.localImage, fullPath, registry, creds }

    const attempts: PushError[] = []
    let anyToolAvailable = false

    for (const tool of PUSH_TOOLS) {
      if (!(await checkTool(tool))) continue
      anyToolAvailable = true
      try {
        const digest = await pushWithTool(tool, pushOpts)
        return { fullPath, digest, warnedDuplicatePath, tool }
      } catch (err) {
        if (!(err instanceof PushError)) throw err
        err.context = { fullPath, registry, image: opts.localImage }
        attempts.push(err)
        // Only retry on errors that could differ across tools. Auth /
        // network / Harbor-side errors will reproduce everywhere — stop
        // early so the user gets a clean diagnosis, not four copies of it.
        if (!err.retriable) break
      }
    }

    if (!anyToolAvailable) throw new Error("no_push_tool")

    const primary = primaryError(attempts)
    primary.context = { ...primary.context, attempts }
    throw primary
  }

  /**
   * Execute a single tool's push. Classifies any failure into a PushError
   * before rethrowing; the outer fallback loop reads `kind` to decide whether
   * trying the next tool is worthwhile.
   */
  async function pushWithTool(
    tool: PushTool,
    opts: { localImage: string; fullPath: string; registry: string; creds: { username: string; password: string } },
  ): Promise<string | undefined> {
    try {
      switch (tool) {
        case "docker":
        case "podman": {
          // docker and podman share the same CLI surface.
          await loginWithStdin(tool, opts.registry, opts.creds)
          await exec([tool, "tag", opts.localImage, opts.fullPath])
          return extractDigest(await exec([tool, "push", opts.fullPath]))
        }
        case "buildah": {
          await loginWithStdin("buildah", opts.registry, opts.creds)
          // `buildah tag` can fail harmlessly when the local reference is
          // already fully-qualified. Any real issue with the image will
          // reappear in the subsequent push.
          try {
            await exec(["buildah", "tag", opts.localImage, opts.fullPath])
          } catch {}
          return extractDigest(
            await exec(["buildah", "push", "--format", "v2s2", opts.fullPath, `docker://${opts.fullPath}`]),
          )
        }
        case "skopeo": {
          // skopeo can read from several local stores. Try each; surface
          // the last attempt's error so the classifier sees real signal
          // (auth failure from docker-daemon, not a generic "not found").
          const destCreds = `${opts.creds.username}:${opts.creds.password}`
          const sources = [`containers-storage:${opts.localImage}`, `docker-daemon:${opts.localImage}`]
          let lastErr: unknown
          for (const src of sources) {
            try {
              return extractDigest(
                await exec(["skopeo", "copy", "--dest-creds", destCreds, src, `docker://${opts.fullPath}`]),
              )
            } catch (err) {
              lastErr = err
            }
          }
          throw lastErr
        }
      }
    } catch (err) {
      const raw = String((err as Error)?.message ?? err ?? "")
      throw new PushError(classifyStderr(raw), tool, raw)
    }
  }

  async function loginWithStdin(
    tool: string,
    registry: string,
    creds: { username: string; password: string },
  ): Promise<void> {
    const proc = Bun.spawn([tool, "login", registry, "-u", creds.username, "--password-stdin"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    })
    proc.stdin.write(creds.password)
    proc.stdin.end()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(stderr || `${tool} login failed (exit ${exitCode})`)
    }
  }

  async function exec(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if (exitCode !== 0) throw new Error(stderr || stdout || `${cmd[0]} failed (exit ${exitCode})`)
    return stdout
  }

  function extractDigest(output: string): string | undefined {
    const m = output.match(/digest:\s*(sha256:[a-f0-9]+)/i)
    return m ? m[1] : undefined
  }

  async function checkTool(tool: string): Promise<boolean> {
    try {
      const proc = Bun.spawn([tool, "--version"], { stdout: "pipe", stderr: "pipe" })
      return (await proc.exited) === 0
    } catch {
      return false
    }
  }
}
