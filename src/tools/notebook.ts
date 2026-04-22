import z from "zod"
import { tool } from "@ericsanchezok/synergy-plugin"
import { pluginConfig } from "../ctx"
import { InspireAPI } from "../api"
import { InspireAuth } from "../auth"
import { InspireCache } from "../cache"
import { InspireResolve } from "../resolve"
import { InspireNormalize } from "../normalize"
import { STATUS_LABELS, requireWorkspace, requireProject, specNotFoundError, listAvailableSpecs, requireAuth } from "../shared"

const DESCRIPTION = `Manage interactive notebook environments on the SII 启智平台.

Supports five actions:
- **list**: List notebooks in a workspace
- **detail**: Get detailed information about a notebook
- **start**: Start a stopped notebook
- **stop**: Stop a running notebook
- **create**: Create a new notebook

Notebooks are persistent resources — they remain until explicitly stopped. Stop notebooks when not in use to avoid unnecessary costs. GPU utilization on running notebooks is monitored; instances with persistently low GPU usage may be auto-reclaimed by the platform.

Notebook spec_ids use SCHEDULE_CONFIG_TYPE_DSW (not the same as training spec_ids). Query available specs via inspire_status.

Call inspire_status first to discover resources. Use inspire_config to set defaults for repeated use.`

export const inspireNotebook = tool({
  description: DESCRIPTION,
  args: {
    action: z.enum(["list", "detail", "start", "stop", "create"]),
    workspace: z.string().optional().describe("Workspace name or ID (uses default if omitted)"),
    project: z.string().optional().describe("Filter to a specific project (name or ID)"),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
    limit: z.number().optional().describe("Max results per page (default 20, max 100)"),
    notebook_id: z.string().optional().describe("Notebook ID (required for detail/start/stop)"),
    name: z.string().optional().describe("Notebook name (required for create)"),
    image: z.string().optional().describe("Container image (use platform display domain docker.sii.shaipower.online)"),
    compute_group: z.string().optional().describe("Compute group name or ID. Use inspire_status to see available groups"),
    spec: z.string().optional().describe("Spec/quota ID for notebooks (SCHEDULE_CONFIG_TYPE_DSW). Query available specs via inspire_status"),
    priority: z.number().optional().describe("Task priority"),
    command: z.string().optional().describe("Startup command"),
    description: z.string().optional().describe("Notebook description"),
    gpu_count: z.number().optional().describe("Number of GPUs"),
    cpu_count: z.number().optional().describe("Number of CPUs"),
    memory_size: z.number().optional().describe("Memory in GB"),
  },
  async execute(params, ctx) {
    const authErr = await requireAuth()
    if (authErr) return authErr

    if (params.action === "list") return handleList(params)
    if (params.action === "detail") return handleDetail(params)
    if (params.action === "start") return handleOperate(params, "START")
    if (params.action === "stop") return handleOperate(params, "STOP")
    if (params.action === "create") return handleCreate(params)
    return { title: "参数错误", output: "无效的 action", metadata: { error: "invalid_action" } }
  },
})

async function handleList(params: any) {
  const wsResult = await requireWorkspace(params.workspace)
  if (!("ws" in wsResult)) return wsResult
  const ws = wsResult.ws

  const { items, total } = await InspireAuth.withTokenRetry((t) =>
    InspireAPI.listNotebooks(t, ws.id, {
      page: Math.floor((params.offset ?? 0) / (params.limit ?? 20)) + 1,
      pageSize: Math.min(params.limit ?? 20, 100),
    }),
  )

  let filtered = items
  if (params.project) {
    const proj = await InspireResolve.project(params.project, ws.id)
    if (proj) {
      filtered = items.filter((nb: any) => nb.project?.id === proj.id || nb.project_id === proj.id)
    }
  }

  if (filtered.length === 0) {
    return {
      title: "笔记本列表",
      output: `📋 工作空间 "${ws.name}"${params.project ? ` (项目过滤)` : ""}暂无笔记本`,
      metadata: { total: 0, workspace_id: ws.id, project: params.project },
    }
  }

  const lines = ["=== 笔记本列表 ===", ""]
  lines.push(`工作空间: ${ws.name}`)
  lines.push(
    `共 ${total} 个笔记本${params.project && filtered.length < total ? `（项目过滤: ${filtered.length}/${total}）` : ""}`,
  )
  lines.push("")

  for (let i = 0; i < filtered.length; i++) {
    const nb = filtered[i]
    const statusInfo = InspireNormalize.status(nb.status ?? "")
    const label = STATUS_LABELS[statusInfo.family] ?? statusInfo.raw
    const gpuInfo = nb.node?.gpu_info
    const gpuType = gpuInfo
      ? `${gpuInfo.gpu_product_simple ?? gpuInfo.brand_name ?? ""}${gpuInfo.gpu_memory_size_gb ? ` ${gpuInfo.gpu_memory_size_gb}G` : ""}`
      : (nb.logic_compute_group?.name ?? "")
    const createdAt = InspireNormalize.formatTimestamp(nb.created_at)
    const offset = params.offset ?? 0

    lines.push(`${offset + i + 1}. [${label}] ${nb.name ?? "未命名"}`)
    lines.push(`   ID: ${nb.notebook_id ?? "—"}`)
    if (gpuType) lines.push(`   GPU: ${gpuType}`)
    if (createdAt) lines.push(`   创建于: ${createdAt}`)
    lines.push("")
  }

  if (total > items.length + (params.offset ?? 0)) {
    lines.push(`显示 ${filtered.length}/${total}，还有更多。用 offset=${(params.offset ?? 0) + items.length} 翻页`)
  }

  return {
    title: `${filtered.length} 个笔记本`,
    output: lines.join("\n"),
    metadata: { total, filtered: filtered.length, workspace_id: ws.id, project: params.project },
  }
}

async function handleDetail(params: any) {
  if (!params.notebook_id) {
    return {
      title: "缺少笔记本 ID",
      output: "查询详情需要指定 notebook_id",
      metadata: { error: "missing_notebook_id" },
    }
  }

  let nb: any
  try {
    nb = await InspireAuth.withTokenRetry((t) => InspireAPI.getNotebookDetail(t, params.notebook_id!))
  } catch (err: any) {
    return {
      title: "查询失败",
      output: `无法获取笔记本 ${params.notebook_id} 的详情: ${err.message ?? err}`,
      metadata: { error: "detail_failed", notebook_id: params.notebook_id },
    }
  }

  const statusInfo = InspireNormalize.status(nb.status ?? "")
  const createdAt = InspireNormalize.formatTimestamp(nb.created_at)
  const url = InspireAPI.buildNotebookUrl(nb.notebook_id ?? params.notebook_id, nb.workspace_id ?? nb.workspace?.id)
  const label = STATUS_LABELS[statusInfo.family] ?? statusInfo.raw

  const lines = [
    `=== 笔记本详情: ${nb.name ?? "未命名"} ===`,
    "",
    "基本信息:",
    `  笔记本 ID: ${nb.notebook_id ?? params.notebook_id}`,
    `  状态: ${label} (${statusInfo.raw})`,
    `  创建于: ${createdAt || "—"}`,
    `  创建者: ${nb.creator?.name ?? "—"}`,
    "",
    "配置:",
    `  镜像: ${nb.image?.address ?? nb.image ?? "—"}`,
    `  计算组: ${nb.logic_compute_group?.name ?? "—"}`,
    `  启动命令: ${nb.start_config?.command ?? nb.command ?? "—"}`,
  ]

  const quota = nb.quota ?? nb.start_config?.quota
  if (quota) {
    if (quota.gpu_count) lines.push(`  GPU 数量: ${quota.gpu_count}`)
    if (quota.cpu_count) lines.push(`  CPU 数量: ${quota.cpu_count}`)
    if (quota.memory_size) lines.push(`  内存: ${quota.memory_size} GB`)
    if (quota.gpu_ram) lines.push(`  GPU 显存: ${quota.gpu_ram} GB`)
  }

  lines.push(
    "",
    "归属:",
    `  空间: ${nb.workspace?.name ?? "—"}`,
    `  项目: ${nb.project?.name ?? "—"}`,
    "",
    `笔记本页面: ${url}`,
  )

  if (nb.access_url) {
    lines.push(`访问地址: ${nb.access_url}`)
  }

  return {
    title: `${nb.name ?? "未命名"} (${label})`,
    output: lines.join("\n"),
    metadata: {
      notebook_id: nb.notebook_id ?? params.notebook_id,
      status: statusInfo.family,
      is_terminal: statusInfo.is_terminal,
    },
  }
}

async function handleOperate(params: any, operation: "START" | "STOP") {
  if (!params.notebook_id) {
    return {
      title: "缺少笔记本 ID",
      output: `${operation === "START" ? "启动" : "停止"}笔记本需要指定 notebook_id`,
      metadata: { error: "missing_notebook_id" },
    }
  }

  const opLabel = operation === "START" ? "启动" : "停止"

  try {
    await InspireAuth.withTokenRetry((t) => InspireAPI.operateNotebook(t, params.notebook_id!, operation))
    return {
      title: `已${opLabel} ${params.notebook_id}`,
      output: `✅ 笔记本 ${params.notebook_id} 已${opLabel}`,
      metadata: { notebook_id: params.notebook_id, action: operation.toLowerCase() },
    }
  } catch (err: any) {
    return {
      title: `${opLabel}失败`,
      output: `无法${opLabel}笔记本 ${params.notebook_id}: ${err.message ?? err}`,
      metadata: { error: "operate_failed", notebook_id: params.notebook_id },
    }
  }
}

async function handleCreate(params: any) {
  const sii = await pluginConfig().get()
  const defaults: string[] = []

  if (!params.name) {
    return {
      title: "缺少名称",
      output: "创建笔记本需要指定 name",
      metadata: { error: "missing_name" },
    }
  }

  const wsResult = await requireWorkspace(params.workspace)
  if (!("ws" in wsResult)) return wsResult
  const ws = wsResult.ws
  if (!params.workspace && sii.defaultWorkspace) defaults.push(`空间: ${ws.name} (默认)`)

  const projResult = await requireProject(params.project, ws.id)
  if (!("proj" in projResult)) return projResult
  const proj = projResult.proj

  const cg = params.compute_group
    ? await InspireResolve.computeGroup(params.compute_group, ws.id)
    : await InspireResolve.firstComputeGroup(ws.id)
  if (!cg) {
    return {
      title: "计算组未找到",
      output: "未找到计算组。请调用 inspire_status 查看目标空间的可用计算组。",
      metadata: { error: "compute_group_not_found" },
    }
  }

  const specId = params.spec
  if (!specId) {
    return specNotFoundError(ws.id, cg.id, cg.name, "SCHEDULE_CONFIG_TYPE_DSW")
  }

  const specs = await listAvailableSpecs(ws.id, cg.id, "SCHEDULE_CONFIG_TYPE_DSW")
  const matchedSpec = specs.find((s) => s.quota_id === specId)

  const image = params.image ?? sii.defaultImage
  if (!image) {
    return {
      title: "缺少镜像",
      output: "未指定 image 且未设置默认镜像。请用 inspire_images 查找可用镜像。",
      metadata: { error: "missing_image" },
    }
  }
  if (!params.image && sii.defaultImage) defaults.push(`镜像: ${image} (默认)`)

  let mirrorId: string | undefined
  try {
    const { images } = await InspireAuth.withCookieRetry((c: string) =>
      InspireAPI.listPlatformImages(c, ws.id, {}),
    )
    const match = images.find((img: any) => img.address === image || img.name === image)
    if (match) mirrorId = match.image_id
  } catch {}

  const projects = await InspireCache.getProjects()
  const projFull = projects.find((p: any) => p.id === proj.id)
  const maxPriority = projFull ? parseInt(projFull.priority_name ?? "4") : 4
  const priority = params.priority ?? sii.defaultPriority ?? maxPriority
  if (priority > maxPriority) {
    return {
      title: "优先级超限",
      output: `优先级 ${priority} 超过项目 "${proj.name}" 最大值 ${maxPriority}。`,
      metadata: { error: "priority_exceeded", max: maxPriority },
    }
  }

  let token: string
  try {
    token = await InspireAuth.ensureToken()
  } catch {
    return InspireAuth.notAuthenticatedError("inspire")
  }

  const body: Record<string, any> = {
    workspace_id: ws.id,
    project_id: proj.id,
    name: params.name,
    logic_compute_group_id: cg.id,
    quota_id: specId,
    mirror_url: image,
    task_priority: priority,
    runtime: "standard",
    enable_notification: true,
  }

  if (matchedSpec) {
    body.resource_spec_price = {
      quota_id: specId,
      cpu_type: "",
      cpu_count: matchedSpec.cpu_count,
      gpu_type: (matchedSpec.gpu_info as any)?.gpu_type ?? "",
      gpu_count: matchedSpec.gpu_count,
      memory_size_gib: matchedSpec.memory_size_gib,
    }
    body.cpu_count = matchedSpec.cpu_count
    body.gpu_count = matchedSpec.gpu_count
    body.memory_size = matchedSpec.memory_size_gib
  } else {
    body.resource_spec_price = {
      quota_id: specId,
      cpu_type: "",
      gpu_type: "",
    }
  }

  if (params.command) body.command = params.command
  if (params.description) body.description = params.description
  if (params.gpu_count) { body.gpu_count = params.gpu_count }
  if (params.cpu_count) { body.cpu_count = params.cpu_count }
  if (params.memory_size) { body.memory_size = params.memory_size }
  if (sii.defaultShm) body.shared_memory_size = sii.defaultShm / 1024
  if (mirrorId) body.mirror_id = mirrorId

  let result: any
  try {
    result = await InspireAPI.createNotebook(token, body)
  } catch (err: any) {
    return {
      title: "创建失败",
      output: `笔记本创建失败: ${err.message ?? err}`,
      metadata: { error: "create_failed" },
    }
  }

  const notebookId = result.notebook_id ?? result.id ?? ""
  InspireCache.setCachedSpecId(ws.id, cg.id, specId)

  const url = InspireAPI.buildNotebookUrl(notebookId, ws.id)

  const lines = [
    "=== 笔记本创建成功 ===",
    "",
    `笔记本 ID: ${notebookId}`,
    `名称: ${params.name}`,
    "状态: 已创建（等待启动）",
    "",
    "配置:",
    `  空间: ${ws.name}`,
    `  项目: ${proj.name}`,
    `  计算组: ${cg.name}`,
    `  规格 ID: ${specId}`,
    `  镜像: ${image}`,
    `  优先级: ${priority}`,
  ]

  if (params.command) lines.push(`  启动命令: ${params.command}`)
  if (params.gpu_count) lines.push(`  GPU 数量: ${params.gpu_count}`)
  if (params.cpu_count) lines.push(`  CPU 数量: ${params.cpu_count}`)
  if (params.memory_size) lines.push(`  内存: ${params.memory_size} GB`)

  lines.push("", `笔记本页面: ${url}`)

  if (defaults.length > 0) {
    lines.push("", "📋 使用的默认配置:")
    for (const d of defaults) lines.push(`  ${d}`)
  }

  return {
    title: params.name,
    output: lines.join("\n"),
    metadata: { notebook_id: notebookId, workspace_id: ws.id, project_id: proj.id },
  }
}
