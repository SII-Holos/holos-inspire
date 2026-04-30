import z from "zod"
import { tool } from "@ericsanchezok/synergy-plugin"
import { pluginConfig } from "../ctx"
import { InspireAPI } from "../api"
import { InspireAuth } from "../auth"
import { InspireCache } from "../cache"
import { InspireResolve } from "../resolve"
import { InspireTypes } from "../types"
import { specNotFoundError, specInvalidError, requireAuth } from "../shared"

const DESCRIPTION = `Submit a GPU training task on the SII 启智平台.

When defaults are configured (via inspire_config), only name and command are required — everything else uses your saved preferences. If commandPrefix is set, it is automatically prepended to your command.

IMPORTANT constraints:
- Offline workspaces (分布式训练空间) have NO internet. Commands must NOT contain pip install, git clone, wget, or any network operations.
- Tasks run in non-interactive shell. ~/.bashrc is NOT loaded. You MUST initialize the environment in the command (or set commandPrefix via inspire_config to do this automatically):
    source /opt/conda/etc/profile.d/conda.sh && conda activate myenv && cd /inspire/hdd/project/{en_name}/code && python train.py
- For distributed training, the platform auto-injects: MASTER_ADDR, MASTER_PORT, PET_NNODES, PET_NODE_RANK, PET_NPROC_PER_NODE.
- Shared memory (shm): multi-GPU training requires ≥64GB (e.g. shm=65536); single-GPU tasks can use the default.
- Priority must not exceed the project's max (check via inspire_status). Priority ≥4 won't be preempted; Priority 1-3 can be killed by higher-priority tasks.
- Low-priority CPU tasks (Priority 1-3) are free and not limited by project budget — useful when budget is exhausted.
- To capture output for debugging, append: 2>&1 | tee /inspire/hdd/project/{en_name}/logs/{job_name}.log
- Images must use the platform-assigned address (docker.sii.shaipower.online/...), not the push address (docker-qb.sii.edu.cn/...).
  SJ资源空间 uses a separate registry: docker-t.sii.shaipower.online.
  Images must be registered on the platform after push (镜像管理 → 新建镜像, fill in 镜像名称 and 版本号).
- For internet-enabled workspaces, use HF mirror for faster downloads: export HF_ENDPOINT=https://hf-mirror.com

Requires platform API access. If your account has not been granted API access, this tool will return an error — contact the platform administrator to enable it.

Call inspire_status first to discover resources. Use inspire_config to set defaults for repeated use.`

export const inspireSubmit = tool({
  description: DESCRIPTION,
  args: {
    name: z.string().describe("Task name"),
    command: z
      .string()
      .describe(
        "Training command. If commandPrefix is configured, this is appended after it. Otherwise must be self-contained including env init",
      ),
    workspace: z.string().optional().describe("Workspace name or ID. Uses sii.defaultWorkspace if omitted"),
    compute_group: z
      .string()
      .optional()
      .describe("Compute group name or ID. Use inspire_status to see available groups"),
    project: z.string().optional().describe("Project name or ID. Uses sii.defaultProject or auto-selects if omitted"),
    spec: z.string().optional().describe("Spec/quota ID for training (SCHEDULE_CONFIG_TYPE_TRAIN). Query available specs via inspire_status"),
    image: z.string().optional().describe("Docker image (use platform display domain docker.sii.shaipower.online, or docker-t.sii.shaipower.online for SJ). Uses sii.defaultImage if omitted"),
    image_type: z
      .enum(["SOURCE_PUBLIC", "SOURCE_PRIVATE", "SOURCE_OFFICIAL"])
      .optional()
      .describe("Image source type (default: SOURCE_PRIVATE)"),
    instances: z.number().optional().describe("Number of nodes (default 1)"),
    shm: z
      .number()
      .optional()
      .describe("Shared memory in MB. Multi-GPU training requires ≥65536. Uses sii.defaultShm or 1200 if omitted"),
    priority: z.number().optional().describe("Task priority. Uses sii.defaultPriority or project max if omitted"),
    auto_fault_tolerance: z
      .boolean()
      .optional()
      .describe("Enable auto fault tolerance (auto-restart on failure). Default: false"),
  },
  async execute(params, ctx) {
    const authErr = await requireAuth()
    if (authErr) return authErr

    const sii = await pluginConfig().get()
    const warnings: string[] = []
    const defaults: string[] = []

    const wsInput = params.workspace ?? sii.defaultWorkspace
    if (!wsInput) {
      return {
        title: "缺少工作空间",
        output:
          '未指定 workspace 且未设置 sii.defaultWorkspace。请调用 inspire_status 查看可用空间，或用 inspire_config(action="set", key="defaultWorkspace", value="...") 设置默认值。',
        metadata: { error: "missing_workspace" } as Record<string, any>,
      }
    }
    const ws = await InspireResolve.workspace(wsInput)
    if (!ws) {
      return {
        title: "空间未找到",
        output: `未找到工作空间 "${wsInput}"。请调用 inspire_status 查看可用空间。`,
        metadata: { error: "workspace_not_found" } as Record<string, any>,
      }
    }
    if (!params.workspace && sii.defaultWorkspace) defaults.push(`空间: ${ws.name} (默认)`)

    const projInput = params.project ?? sii.defaultProject
    const proj = projInput ? await InspireResolve.project(projInput, ws.id) : await InspireResolve.firstProject(ws.id)
    if (!proj) {
      return {
        title: "项目未找到",
        output: "未找到项目。请调用 inspire_status 查看可用项目。",
        metadata: { error: "project_not_found" } as Record<string, any>,
      }
    }
    if (!params.project && sii.defaultProject) defaults.push(`项目: ${proj.name} (默认)`)

    const cg = params.compute_group
      ? await InspireResolve.computeGroup(params.compute_group, ws.id)
      : await InspireResolve.firstComputeGroup(ws.id)
    if (!cg) {
      return {
        title: "计算组未找到",
        output: "未找到计算组。请调用 inspire_status 查看目标空间的可用计算组。",
        metadata: { error: "compute_group_not_found" } as Record<string, any>,
      }
    }
    if (!params.compute_group) warnings.push(`自动选择计算组: ${cg.name}`)

    const specId = params.spec

    const image = params.image ?? sii.defaultImage
    if (!image) {
      return {
        title: "缺少镜像",
        output: "未指定 image 且未设置 sii.defaultImage。请用 inspire_images 查找或 inspire_config 设置默认镜像。",
        metadata: { error: "missing_image" } as Record<string, any>,
      }
    }
    if (!params.image && sii.defaultImage) defaults.push(`镜像: ${image} (默认)`)

    const instances = params.instances ?? 1
    const shm = params.shm ?? sii.defaultShm ?? 1200
    if (!params.shm && sii.defaultShm) defaults.push(`共享内存: ${shm} MB (默认)`)

    const projects = await InspireCache.getProjects()
    const projFull = projects.find((p: any) => p.id === proj.id)
    const maxPriority = projFull ? parseInt(projFull.priority_name ?? "4") : 4
    const priority = params.priority ?? sii.defaultPriority ?? maxPriority
    if (priority > maxPriority) {
      return {
        title: "优先级超限",
        output: `优先级 ${priority} 超过项目 "${proj.name}" 最大值 ${maxPriority}。`,
        metadata: { error: "priority_exceeded", max: maxPriority } as Record<string, any>,
      }
    }
    if (!params.priority && sii.defaultPriority) defaults.push(`优先级: ${priority} (默认)`)

    const remainBudget = projFull?.remain_budget ?? undefined
    if (remainBudget !== undefined && remainBudget <= 0) {
      warnings.push(
        `⚠ 项目点券已耗尽（剩余 ${Math.round(remainBudget)}）。任务可能无法创建。低优先级(1-3)的 CPU 任务不受点券限制。`,
      )
    }

    const isSjImage = image.includes("docker-t.sii.shaipower.online")
    const isPushDomain = image.includes("docker-qb.sii.edu.cn") || image.includes("docker-t.sii.edu.cn")
    const isSjSpace = ws.name.includes("SJ") || ws.name.includes("松江")
    if (isSjImage && !isSjSpace) {
      warnings.push(
        "⚠ 镜像地址为 SJ 资源空间专用仓库(docker-t.sii.shaipower.online)，但目标空间不在松江集群。请使用 docker.sii.shaipower.online 的镜像。",
      )
    } else if (!isSjImage && isSjSpace && !isPushDomain) {
      warnings.push(
        "⚠ 目标空间为 SJ 资源空间（松江集群），但镜像地址不是松江仓库。SJ 空间请使用 docker-t.sii.shaipower.online 的镜像。",
      )
    } else if (isPushDomain) {
      warnings.push(
        "⚠ 镜像地址使用了推送域名，请使用平台注册后的显示地址（docker.sii.shaipower.online/... 或 docker-t.sii.shaipower.online/...）。",
      )
    }

    let finalCommand = params.command
    if (sii.commandPrefix) {
      finalCommand = `${sii.commandPrefix} && ${params.command}`
      defaults.push(`命令前缀: ${sii.commandPrefix}`)
    }

    let token: string
    try {
      token = await InspireAuth.ensureToken()
    } catch (err: any) {
      if (err instanceof InspireAuth.TokenUnavailableError) {
        if (err.reason === "not_authenticated") {
          return InspireAuth.notAuthenticatedError("inspire")
        }
        return {
          title: "提交失败",
          output: `平台 API 认证失败: ${err.message}`,
          metadata: { error: "token_unavailable", reason: err.reason } as Record<string, any>,
        }
      }
      return {
        title: "认证失败",
        output: `平台认证失败: ${err.message ?? err}`,
        metadata: { error: "token_error" } as Record<string, any>,
      }
    }

    if (!specId) {
      return specNotFoundError(ws.id, cg.id, cg.name)
    }

    let result: any
    try {
      result = await InspireAuth.withTokenRetry((t) =>
        InspireAPI.createJob(t, {
          name: params.name,
          workspace_id: ws.id,
          project_id: proj.id,
          logic_compute_group_id: cg.id,
          command: finalCommand,
          task_priority: priority,
          spec_id: specId!,
          image,
          image_type: params.image_type,
          instance_count: instances,
          shm_gi: shm,
          auto_fault_tolerance: params.auto_fault_tolerance ?? false,
        }),
      )
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (msg.includes("spec_id") || msg.includes("SpecId") || msg.includes("spec not found") || msg.includes("predef_train_spec")) {
        return specInvalidError(specId!, ws.id, cg.id, cg.name)
      }
      return {
        title: "提交失败",
        output: `任务提交失败: ${msg}\n\n常见原因: 镜像不存在、计算组已满、点券不足、spec_id 不匹配`,
        metadata: { error: "submit_failed" } as Record<string, any>,
      }
    }

    const jobId = result.job_id ?? result.id ?? ""
    InspireCache.setCachedSpecId(ws.id, cg.id, specId)

    const lines = [
      "=== 任务提交成功 ===",
      "",
      `任务 ID: ${jobId}`,
      `任务名称: ${params.name}`,
      "状态: 已提交（等待调度）",
      "",
      "配置:",
      `  空间: ${ws.name}`,
      `  项目: ${proj.name}`,
      `  计算组: ${cg.name}`,
      `  规格 ID: ${specId}`,
      `  镜像: ${image}`,
      `  优先级: ${priority}`,
      `  节点数: ${instances}`,
      `  共享内存: ${shm} MB`,
    ]

    if (params.auto_fault_tolerance) lines.push(`  容错重启: 已开启`)

    lines.push(
      "",
      `存储路径: /inspire/hdd/project/${proj.en_name}/`,
      `任务页面: ${InspireAPI.buildJobUrl(jobId, ws.id)}`,
    )

    if (defaults.length > 0) {
      lines.push("", "📋 使用的默认配置:")
      for (const d of defaults) lines.push(`  ${d}`)
    }
    if (warnings.length > 0) {
      lines.push("")
      for (const w of warnings) lines.push(w.startsWith("⚠") ? w : `⚠ ${w}`)
    }

    if (instances > 1 && shm < 65536) {
      lines.push("", `⚠ 多机/多卡训练建议共享内存 ≥64GB (当前 ${shm} MB)，可能遇到 NCCL 共享内存错误`)
    }

    const network = InspireTypes.WORKSPACE_NETWORK_MAP[ws.name]
    if (network === "offline" && /pip install|git clone|wget |curl /i.test(finalCommand)) {
      lines.push("", "⚠ 警告: 命令中包含联网操作，但目标空间无外网。任务可能会失败。")
    }

    return {
      title: params.name,
      output: lines.join("\n"),
      metadata: { job_id: jobId, workspace_id: ws.id, project_id: proj.id } as Record<string, any>,
    }
  },
})
