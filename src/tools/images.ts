import z from "zod"
import { tool } from "@ericsanchezok/synergy-plugin"
import { InspireHarbor } from "../harbor"
import { InspireAuth } from "../auth"
import { InspireTypes } from "../types"
import { InspireAPI } from "../api"
import { requireWorkspace, requireAuth } from "../shared"

const DESCRIPTION = `Search and browse Docker images available on the SII 启智平台.

Two sources:
- source="platform" (default): query images registered on the platform (镜像管理). These are the images actually usable for task submission. Shows image name, tag, type (官方/个人可见/公开可见), and full display address.
- source="harbor": query the raw Harbor registry at ${InspireTypes.HARBOR_REGISTRY}. Shows all pushed images including unregistered ones.

Usage:
- No parameters: list registered platform images
- search: find images by keyword
- repo: (harbor only) view all versions (tags) of a specific image

Two registries with separate credentials:
- 七宝 (main): push to ${InspireTypes.HARBOR_REGISTRY}, display as docker.sii.shaipower.online (all spaces except SJ)
- 松江 (SJ): push to docker-t.sii.edu.cn, display as docker-t.sii.shaipower.online (SJ资源空间 only)

Submit tasks using the display domain, not the push domain. Images must be registered on the platform after push (镜像管理 → 新建镜像).`

export const inspireImages = tool({
  description: DESCRIPTION,
  args: {
    source: z
      .enum(["platform", "harbor"])
      .optional()
      .describe('Image source: "platform" (default) for registered images, "harbor" for raw registry'),
    search: z
      .string()
      .optional()
      .describe("Keyword to search image names (e.g. 'torch', 'cuda12'). If omitted, lists recent images."),
    repo: z
      .string()
      .optional()
      .describe(
        "Repository name to view all tags/versions (e.g. 'dhyu-wan-torch29'). Can include or omit 'inspire-studio/' prefix. Harbor source only.",
      ),
    workspace: z.string().optional().describe("Workspace name or ID (platform source only, uses default if omitted)"),
    limit: z.number().optional().describe("Number of results to return (default 20, max 100)"),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
  },
  async execute(params, ctx) {
    const source = params.source ?? "platform"

    if (source === "platform") {
      return executePlatform(params)
    }

    return executeHarbor(params)
  },
})

async function executePlatform(params: {
  search?: string
  workspace?: string
  limit?: number
  offset?: number
}) {
  const authErr = await requireAuth()
  if (authErr) return authErr

  const wsResult = await requireWorkspace(params.workspace)
  if (!("ws" in wsResult)) return wsResult
  const ws = wsResult.ws

  const limit = params.limit ?? 20
  const offset = params.offset ?? 0
  const search = params.search?.toLowerCase()

  const result = await InspireAuth.withCookieRetry((cookie: string) =>
    InspireAPI.listPlatformImages(cookie, ws.id, {}),
  )

  let allImages = result.images
  let total = result.total

  if (search) {
    allImages = allImages.filter(
      (img: any) =>
        (img.name ?? "").toLowerCase().includes(search) ||
        (img.address ?? "").toLowerCase().includes(search),
    )
    total = allImages.length
  }

  const pageImages = allImages.slice(offset, offset + limit)

  const VISIBILITY_LABELS: Record<string, string> = {
    VISIBILITY_PRIVATE: "个人可见",
    VISIBILITY_PUBLIC: "公开可见",
  }

  const SOURCE_LABELS: Record<string, string> = {
    SOURCE_OFFICIAL: "官方",
    SOURCE_PRIVATE: "个人上传",
    SOURCE_PUBLIC: "公开",
  }

  const header = params.search ? `=== 平台镜像搜索: "${params.search}" ===` : `=== 平台已注册镜像 ===`
  const lines = [
    header,
    `共 ${total} 个镜像（显示 ${offset + 1}-${offset + pageImages.length}）:`,
    "",
  ]

  for (let i = 0; i < pageImages.length; i++) {
    const img = pageImages[i]
    const displayName = img.name ?? "unknown"
    const address = img.address ?? ""
    const visibility = VISIBILITY_LABELS[img.visibility] ?? img.visibility ?? ""
    const source = SOURCE_LABELS[img.source] ?? img.source ?? ""
    const region = Array.isArray(img.region) ? img.region.join(", ") : ""
    const size = img.size ?? ""

    lines.push(`${offset + i + 1}. ${displayName}`)
    lines.push(`   地址: ${address}`)
    const tags = [visibility, source, region, size].filter(Boolean).join(" | ")
    if (tags) lines.push(`   ${tags}`)
    if (img.description) lines.push(`   描述: ${img.description}`)
    lines.push("")
  }

  if (total > offset + pageImages.length) {
    lines.push(`用 offset=${offset + pageImages.length} 查看下一页`)
    lines.push("")
  }

  lines.push('提示: 平台注册的镜像可直接用于 inspire_submit。使用 source="harbor" 查看 Harbor 原始镜像。')

  return {
    title: `${pageImages.length} 个平台镜像`,
    output: lines.join("\n"),
    metadata: { source: "platform" as const, total, shown: pageImages.length, offset, limit },
  }
}

async function executeHarbor(params: {
  search?: string
  repo?: string
  limit?: number
  offset?: number
}) {
  try {
    if (params.repo) {
      let repoName = params.repo
      if (repoName.startsWith("inspire-studio/")) repoName = repoName.slice("inspire-studio/".length)

      const artifacts = await InspireHarbor.listArtifacts(repoName, { limit: params.limit ?? 20 })

      const fullName = `${InspireTypes.HARBOR_PROJECT}/${repoName}`
      const lines = [
        `=== 镜像详情: ${fullName} ===`,
        `完整地址: ${InspireTypes.HARBOR_REGISTRY}/${fullName}`,
        "",
        "版本列表:",
      ]

      if (artifacts.length === 0) {
        lines.push("  (无版本)")
      } else {
        for (const a of artifacts) {
          const tags = a.tags.length ? a.tags.join(", ") : "(无 tag)"
          lines.push(`  Tag: ${tags.padEnd(16)} 大小: ${a.size_gb} GB   推送于: ${a.push_time.split("T")[0]}`)
        }
      }

      lines.push(
        "",
        "使用方式:",
        `  在 inspire_submit 的 image 参数中使用: ${InspireTypes.HARBOR_REGISTRY}/${fullName}:{tag}`,
      )

      return {
        title: fullName,
        output: lines.join("\n"),
        metadata: { source: "harbor" as const, repo: repoName, artifact_count: artifacts.length },
      }
    }

    const limit = Math.min(params.limit ?? 20, 100)
    const page = Math.floor((params.offset ?? 0) / limit) + 1
    const result = await InspireHarbor.listRepositories({ search: params.search, limit, page })

    const header = params.search ? `=== Harbor 镜像搜索: "${params.search}" ===` : `=== Harbor 最近推送的镜像 ===`
    const offset = params.offset ?? 0

    const lines = [
      header,
      `共 ${result.total} 个仓库（显示 ${offset + 1}-${offset + result.repositories.length}）:`,
      "",
    ]

    for (let i = 0; i < result.repositories.length; i++) {
      const r = result.repositories[i]
      lines.push(`${offset + i + 1}. ${r.name}`)
      if (r.description) lines.push(`   描述: ${r.description}`)
      lines.push(
        `   版本数: ${r.artifact_count} | 拉取次数: ${r.pull_count} | 更新于: ${r.update_time.split("T")[0]}`,
      )
      lines.push("")
    }

    if (result.total > offset + result.repositories.length) {
      lines.push(`用 offset=${offset + result.repositories.length} 查看下一页`)
      lines.push("")
    }

    lines.push('使用 repo 参数查看某个镜像的所有版本: inspire_images(source="harbor", repo="{name}")')

    return {
      title: `${result.repositories.length} 个镜像`,
      output: lines.join("\n"),
      metadata: { source: "harbor" as const, total: result.total, shown: result.repositories.length, offset, limit },
    }
  } catch (err: any) {
    if (String(err).includes("harbor_not_authenticated") || String(err).includes("not authenticated")) {
      return InspireAuth.notAuthenticatedError("harbor")
    }
    throw err
  }
}
