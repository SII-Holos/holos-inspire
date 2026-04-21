import z from "zod"
import { tool } from "@ericsanchezok/synergy-plugin"
import { pluginConfig } from "../ctx"
import { InspireAPI } from "../api"
import { InspireAuth } from "../auth"
import { InspireCache } from "../cache"
import { InspireResolve } from "../resolve"

const DESCRIPTION = `Submit an HPC/CPU task on the SII 启智平台 (Slurm scheduling). Use for data preprocessing, evaluation, CPU-intensive computation, or auxiliary tasks.

HPC spaces (高性能计算) have NO internet. All dependencies must be pre-installed in the image.
HPC tasks must use Slurm-compatible images (images with 'slurm' in the name).
Non-interactive shell: manually source conda in the entrypoint if needed.

Typical use cases:
- Data preprocessing before GPU training
- Reading experiment results from project directories
- File operations across project directories
- Running evaluation scripts that don't need GPU`

export const inspireSubmitHpc = tool({
  description: DESCRIPTION,
  args: {
    name: z.string().describe("Task name"),
    entrypoint: z.string().describe("Shell command to execute (Slurm entrypoint)"),
    workspace: z
      .string()
      .optional()
      .describe("Workspace name or ID (e.g. '高性能计算'). Uses sii.defaultWorkspace if omitted"),
    compute_group: z.string().optional().describe("HPC compute group name or ID. Auto-detected if omitted"),
    project: z.string().optional().describe("Project name or ID. Uses default or auto-selects if omitted"),
    image: z.string().optional().describe("Container image. Uses config default if omitted"),
    image_type: z
      .enum(["SOURCE_PUBLIC", "SOURCE_PRIVATE", "SOURCE_OFFICIAL"])
      .optional()
      .describe("Image source type (default: SOURCE_PRIVATE)"),
    instances: z.number().optional().describe("Number of nodes (default 1)"),
    spec: z.string().optional().describe("Spec/quota ID. Uses sii.defaultSpecId or auto-resolves if omitted"),
    priority: z.number().optional().describe("Task priority. Uses sii.defaultPriority or project max if omitted"),
    number_of_tasks: z.number().optional().describe("Number of Slurm sub-tasks (default 1)"),
    cpus_per_task: z.number().optional().describe("CPU cores per Slurm task (default 1)"),
    memory_per_cpu: z.string().optional().describe("Memory per CPU, e.g. '4G' (default '4G')"),
    enable_hyper_threading: z.boolean().optional().describe("Enable hyper-threading (default false)"),
    ttl_after_finish_seconds: z.number().optional().describe("Keep task after finish for N seconds (default 600)"),
  },
  async execute(params, ctx) {
    const sii = await pluginConfig().get()
    const warnings: string[] = []
    const defaults: string[] = []

    const wsInput = params.workspace ?? sii.defaultWorkspace
    if (!wsInput) {
      return {
        title: "缺少工作空间",
        output: "未指定 workspace 且未设置 sii.defaultWorkspace。",
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

    const projInput = params.project ?? sii.defaultProject
    const proj = projInput ? await InspireResolve.project(projInput, ws.id) : await InspireResolve.firstProject(ws.id)
    if (!proj) {
      return {
        title: "项目未找到",
        output: "未找到项目。请调用 inspire_status 查看可用项目。",
        metadata: { error: "project_not_found" } as Record<string, any>,
      }
    }

    const cg = params.compute_group
      ? await InspireResolve.computeGroup(params.compute_group, ws.id)
      : await InspireResolve.firstComputeGroup(ws.id)
    if (!cg) {
      return {
        title: "计算组未找到",
        output: "未找到 HPC 计算组。请调用 inspire_status 确认目标空间有 HPC 资源。",
        metadata: { error: "compute_group_not_found" } as Record<string, any>,
      }
    }

    const image = params.image ?? sii.defaultImage
    if (!image) {
      return {
        title: "缺少镜像",
        output: "未指定 image 且 config 中未设置 sii.defaultImage。HPC 任务需要 Slurm 兼容镜像。",
        metadata: { error: "missing_image" } as Record<string, any>,
      }
    }

    let specId = params.spec ?? sii.defaultSpecId
    if (!specId) {
      specId = InspireCache.getCachedSpecId(ws.id, cg.id)
    }
    if (!specId) {
      const resolved = await InspireCache.resolveSpecId(ws.id, cg.id)
      if (resolved) specId = resolved
    }

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

    const number_of_tasks = params.number_of_tasks ?? 1
    const cpus_per_task = params.cpus_per_task ?? 1
    const memory_per_cpu = params.memory_per_cpu ?? "4G"
    const enable_hyper_threading = params.enable_hyper_threading ?? false
    const instances = params.instances ?? 1

    let result: any
    let usedOpenAPI = false

    try {
      const token = await InspireAuth.ensureToken()

      if (!specId) {
        let availableSpecs = await InspireCache.resolveAvailableSpecs(ws.id, cg.id, "SCHEDULE_CONFIG_TYPE_HPC")
        if (availableSpecs.length === 0) {
          availableSpecs = await InspireCache.resolveAvailableSpecs(ws.id, cg.id, "SCHEDULE_CONFIG_TYPE_TRAIN")
        }
        if (availableSpecs.length > 0) {
          const lines = [
            "未指定 spec_id。当前计算组可用的资源规格如下：",
            "",
            "| GPU | CPU | 内存(GB) | 价格(点券/h) | spec_id |",
            "|-----|-----|----------|-------------|---------|",
          ]
          for (const s of availableSpecs) {
            lines.push(`| ${s.gpu_count} | ${s.cpu_count} | ${s.memory_size_gib} | ${s.total_price_per_hour} | ${s.quota_id} |`)
          }
          lines.push(
            "",
            "请根据任务需求选择合适的规格：",
            "- HPC 任务通常选择 CPU 规格（GPU=0）",
            "- 选定后用 spec 参数传入，或用 inspire_config 设为默认值",
          )
          return {
            title: "请选择资源规格",
            output: lines.join("\n"),
            metadata: { error: "spec_id_required", available_specs: availableSpecs } as Record<string, any>,
          }
        }
        return {
          title: "缺少规格 ID",
          output: [
            "未指定 spec_id 且无法查询可用规格。",
            "",
            "获取方式：在平台 UI 新建任务页面选择计算类型组后可看到规格 ID。",
            '设置默认值: inspire_config(action="set", key="defaultSpecId", value="...")',
          ].join("\n"),
          metadata: { error: "missing_spec_id" } as Record<string, any>,
        }
      }

      result = await InspireAuth.withTokenRetry((t) =>
        InspireAPI.createHpcJobOpenAPI(t, {
          name: params.name,
          workspace_id: ws.id,
          project_id: proj.id,
          logic_compute_group_id: cg.id,
          entrypoint: params.entrypoint,
          image,
          image_type: params.image_type,
          instance_count: instances,
          spec_id: specId!,
          task_priority: priority,
          number_of_tasks,
          cpus_per_task,
          memory_per_cpu,
          enable_hyper_threading,
          ttl_after_finish_seconds: params.ttl_after_finish_seconds,
        }),
      )
      usedOpenAPI = true
      InspireCache.setCachedSpecId(ws.id, cg.id, specId)
    } catch (err: any) {
      if (err instanceof InspireAuth.TokenUnavailableError && err.reason === "not_authenticated") {
        return InspireAuth.notAuthenticatedError("inspire")
      }

      const errMsg = String(err?.message ?? err)
      if (errMsg.includes("spec_id") || errMsg.includes("SpecId") || errMsg.includes("spec not found") || errMsg.includes("predef")) {
        let availableSpecs = await InspireCache.resolveAvailableSpecs(ws.id, cg.id, "SCHEDULE_CONFIG_TYPE_HPC")
        if (availableSpecs.length === 0) {
          availableSpecs = await InspireCache.resolveAvailableSpecs(ws.id, cg.id, "SCHEDULE_CONFIG_TYPE_TRAIN")
        }
        const lines = [
          `spec_id "${specId}" 无效（计算组: ${cg.name}）。`,
          "",
        ]
        if (availableSpecs.length > 0) {
          lines.push(
            "当前计算组可用规格：",
            "",
            "| GPU | CPU | 内存(GB) | 价格(点券/h) | spec_id |",
            "|-----|-----|----------|-------------|---------|",
          )
          for (const s of availableSpecs) {
            lines.push(`| ${s.gpu_count} | ${s.cpu_count} | ${s.memory_size_gib} | ${s.total_price_per_hour} | ${s.quota_id} |`)
          }
          lines.push("", '请选择正确的 spec_id 重新提交，或用 inspire_config(action="set", key="defaultSpecId", value="...") 更新默认值。')
        } else {
          lines.push("无法查询可用规格列表。请在平台 UI 新建任务时查看规格 ID。")
        }
        return {
          title: "提交失败: 规格 ID 无效",
          output: lines.join("\n"),
          metadata: { error: "invalid_spec_id", spec_id: specId, compute_group: cg.name, available_specs: availableSpecs } as Record<string, any>,
        }
      }

      if (!specId) {
        specId = InspireCache.getCachedSpecId(ws.id, cg.id) ?? ""
      }

      const cpu = cpus_per_task
      const memGi = parseInt(memory_per_cpu, 10) || 4

      try {
        result = await InspireAuth.withCookieRetry((cookie) =>
          InspireAPI.createHpcJob(cookie, {
            job_name: params.name,
            workspace_id: ws.id,
            project_id: proj.id,
            logic_compute_group_id: cg.id,
            enable_notification: false,
            dataset_info: [],
            sbatch_script: {
              number_of_tasks,
              cpus_per_task,
              memory_per_cpu,
              enable_hyper_threading,
              max_running_time_days: 0,
              max_running_time_hours: 0,
              max_running_time_minutes: 0,
              entrypoint: params.entrypoint,
            },
            slurm_cluster_spec: {
              predef_quota_id: specId ?? "",
              cpu,
              mem_gi: memGi,
              image,
              image_type: params.image_type ?? "SOURCE_PRIVATE",
              instance_count: instances,
              spec_price: {
                cpu_type: "",
                cpu_count: cpu,
                gpu_type: "",
                gpu_count: 0,
                memory_size_gib: memGi,
                logic_compute_group_id: cg.id,
                quota_id: specId ?? "",
              },
            },
          }),
        )
        warnings.push("⚠ 使用了备用认证方式提交")
      } catch (cookieErr: any) {
        if (String(cookieErr).includes("inspire_not_authenticated")) {
          return InspireAuth.notAuthenticatedError("inspire")
        }
        return {
          title: "提交失败",
          output: `HPC 任务提交失败: ${cookieErr.message ?? cookieErr}`,
          metadata: { error: "submit_failed" } as Record<string, any>,
        }
      }
    }

    const jobId = result.job_id ?? result.id ?? ""
    const storagePath = `/inspire/hdd/project/${proj.en_name}/`

    const lines = [
      "=== HPC 任务提交成功 ===",
      "",
      `任务 ID: ${jobId}`,
      `任务名称: ${params.name}`,
      "状态: 已提交",
      "",
      "配置:",
      `  空间: ${ws.name}`,
      `  项目: ${proj.name}`,
      `  计算组: ${cg.name}`,
      `  CPU: ${cpus_per_task} 核/任务`,
      `  内存/CPU: ${memory_per_cpu}`,
      `  子任务数: ${number_of_tasks}`,
      `  节点数: ${instances}`,
      `  镜像: ${image}`,
      `  优先级: ${priority}`,
      "",
      `存储路径: ${storagePath}`,
    ]

    if (defaults.length > 0) {
      lines.push("", "📋 使用的默认配置:")
      for (const d of defaults) lines.push(`  ${d}`)
    }
    if (warnings.length > 0) {
      lines.push("")
      for (const w of warnings) lines.push(w.startsWith("⚠") ? w : `⚠ ${w}`)
    }

    return {
      title: params.name,
      output: lines.join("\n"),
      metadata: { job_id: jobId, workspace_id: ws.id, project_id: proj.id } as Record<string, any>,
    }
  },
})
