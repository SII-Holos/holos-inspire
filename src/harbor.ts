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
      throw new Error(`harbor_not_authenticated: ${registryName} 未配置凭据。请运行 synergy inspire harbor-login --username <用户名> --password <密码> --registry ${target}\n⚠️ Harbor 账号不是启智平台账号，需在「镜像管理 → 本地推送」页面获取。`)
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

    // Try tools in order of preference. Each tool tries independently —
    // if the image exists in that tool's storage and push succeeds, we're done.
    // This lets users build with buildah and push without Docker installed.
    const pushOpts = {
      localImage: opts.localImage,
      fullPath,
      registry,
      username: creds.username,
      password: creds.password,
    }

    const attempts: Array<{ tool: string; error: string }> = []
    let anyToolFound = false

    for (const tool of ["docker", "podman", "buildah", "skopeo"] as const) {
      if (!(await checkTool(tool))) continue
      anyToolFound = true
      log.info(`attempting push with ${tool}`)
      try {
        const digest = await pushWithTool(tool, pushOpts)
        return { fullPath, digest, warnedDuplicatePath, tool }
      } catch (err: any) {
        const msg = String(err?.message ?? err ?? "")
        attempts.push({ tool, error: msg.slice(0, 500) })
        log.info(`${tool} push failed, trying next`, { err: msg })
      }
    }

    if (!anyToolFound) {
      throw new Error(
        "no_push_tool: 未找到任何可用的容器工具。支持的工具（按优先级）：docker, podman, buildah, skopeo。请至少安装其中之一，或使用 docker/podman save 导出 .tar 后在平台页面手动上传。",
      )
    }

    throw new Error(
      `all_push_tools_failed: 尝试了以下工具但都失败：\n${attempts.map((a) => `  [${a.tool}] ${a.error}`).join("\n")}`,
    )
  }

  // Per-tool push implementation. All tools do: login → tag/copy → push.
  async function pushWithTool(
    tool: "docker" | "podman" | "buildah" | "skopeo",
    opts: { localImage: string; fullPath: string; registry: string; username: string; password: string },
  ): Promise<string | undefined> {
    const { localImage, fullPath, registry, username, password } = opts

    if (tool === "docker" || tool === "podman") {
      // docker / podman are CLI-compatible
      await loginWithStdin(tool, registry, username, password)
      await exec([tool, "tag", localImage, fullPath])
      const pushOutput = await exec([tool, "push", fullPath])
      return extractDigest(pushOutput)
    }

    if (tool === "buildah") {
      // buildah supports --creds for single-shot push without a persistent login
      // It reads images from containers-storage (default) which is where
      // `buildah bud` puts them.
      await loginWithStdin("buildah", registry, username, password)
      // Tag inside buildah's storage. If localImage is already fully-qualified
      // this is a no-op in terms of digest.
      try {
        await exec(["buildah", "tag", localImage, fullPath])
      } catch {
        // Tag may fail if the image isn't in buildah storage — skopeo/direct
        // push to docker:// may still work from the daemon via --tls-verify
      }
      const pushOutput = await exec(["buildah", "push", "--format", "v2s2", fullPath, `docker://${fullPath}`])
      return extractDigest(pushOutput)
    }

    if (tool === "skopeo") {
      // skopeo is the most flexible — reads from containers-storage, docker-daemon,
      // oci: directories, or .tar files. Try containers-storage first (populated
      // by buildah/podman), then docker-daemon (populated by docker pull/build).
      const destCreds = `${username}:${password}`
      const sources = [`containers-storage:${localImage}`, `docker-daemon:${localImage}`]
      let lastErr = ""
      for (const src of sources) {
        try {
          const out = await exec([
            "skopeo",
            "copy",
            "--dest-creds",
            destCreds,
            src,
            `docker://${fullPath}`,
          ])
          return extractDigest(out)
        } catch (err: any) {
          lastErr = String(err?.message ?? err)
        }
      }
      throw new Error(`skopeo: image not found in containers-storage or docker-daemon. Last error: ${lastErr}`)
    }

    throw new Error(`unknown tool: ${tool}`)
  }

  async function loginWithStdin(tool: string, registry: string, username: string, password: string): Promise<void> {
    const proc = Bun.spawn([tool, "login", registry, "-u", username, "--password-stdin"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    })
    proc.stdin.write(password)
    proc.stdin.end()
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    if (exitCode !== 0) throw new Error(`${tool} login failed: ${stderr}`)
  }

  function extractDigest(output: string): string | undefined {
    const m = output.match(/digest:\s*(sha256:[a-f0-9]+)/i)
    return m ? m[1] : undefined
  }

  async function exec(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if (exitCode !== 0) throw new Error(stderr || stdout)
    return stdout
  }

  async function checkTool(tool: string): Promise<boolean> {
    try {
      // Different tools have different version commands; --version works for
      // docker/podman/buildah/skopeo. We ignore stdout content.
      const proc = Bun.spawn([tool, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      return (await proc.exited) === 0
    } catch {
      return false
    }
  }
}
