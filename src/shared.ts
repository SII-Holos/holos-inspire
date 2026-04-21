import { InspireAPI } from "./api"
import { InspireResolve } from "./resolve"
import { InspireTypes } from "./types"
import { InspireAuth } from "./auth"
import { pluginConfig } from "./ctx"

export const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  waiting: "排队中",
  succeeded: "成功",
  failed: "失败",
  stopped: "已停止",
  unknown: "未知",
}

export function classifyJobId(id: string): "gpu" | "hpc" | "inference" {
  if (id.startsWith("sv-")) return "inference"
  if (id.startsWith("hpc-job-")) return "hpc"
  return "gpu"
}

export async function requireWorkspace(
  workspaceInput?: string,
): Promise<{ ws: { id: string; name: string } } | InspireTypes.ToolResult> {
  const sii = await pluginConfig().get()
  const wsInput = workspaceInput ?? sii.defaultWorkspace
  if (!wsInput) {
    return {
      title: "缺少工作空间",
      output:
        '未指定 workspace 且未设置 sii.defaultWorkspace。请调用 inspire_status 查看可用空间，或用 inspire_config(action="set", key="defaultWorkspace", value="...") 设置默认值。',
      metadata: { error: "missing_workspace" },
    }
  }
  const ws = await InspireResolve.workspace(wsInput)
  if (!ws) {
    return {
      title: "空间未找到",
      output: `未找到工作空间 "${wsInput}"。请调用 inspire_status 查看可用空间。`,
      metadata: { error: "workspace_not_found" },
    }
  }
  return { ws }
}

export async function requireProject(
  projectInput: string | undefined,
  workspaceId: string,
): Promise<{ proj: { id: string; name: string; en_name: string } } | InspireTypes.ToolResult> {
  const sii = await pluginConfig().get()
  const projInput = projectInput ?? sii.defaultProject
  const proj = projInput
    ? await InspireResolve.project(projInput, workspaceId)
    : await InspireResolve.firstProject(workspaceId)
  if (!proj) {
    return {
      title: "项目未找到",
      output: "未找到项目。请调用 inspire_status 查看可用项目。",
      metadata: { error: "project_not_found" },
    }
  }
  return { proj }
}

export async function listAvailableSpecs(
  workspaceId: string,
  computeGroupId: string,
  scheduleType?: string,
): Promise<InspireAPI.ResourceSpec[]> {
  try {
    return await InspireAuth.withCookieRetry((cookie: string) =>
      InspireAPI.listResourceSpecs(cookie, workspaceId, computeGroupId, scheduleType),
    )
  } catch {
    return []
  }
}

export function formatSpecTable(specs: InspireAPI.ResourceSpec[]): string[] {
  const lines = [
    "| GPU | CPU | 内存(GB) | 价格(点券/h) | spec_id |",
    "|-----|-----|----------|-------------|---------|",
  ]
  for (const s of specs) {
    lines.push(`| ${s.gpu_count} | ${s.cpu_count} | ${s.memory_size_gib} | ${s.total_price_per_hour} | ${s.quota_id} |`)
  }
  return lines
}

export async function specNotFoundError(
  workspaceId: string,
  computeGroupId: string,
  computeGroupName: string,
  scheduleType?: string,
): Promise<InspireTypes.ToolResult> {
  const specs = await listAvailableSpecs(workspaceId, computeGroupId, scheduleType)
  if (specs.length > 0) {
    return {
      title: "请选择资源规格",
      output: [
        `未指定 spec_id。当前计算组「${computeGroupName}」可用规格：`,
        "",
        ...formatSpecTable(specs),
        "",
        "请根据任务需求选择：",
        "- 多机训练建议选整节点（如 8 GPU）避免资源碎片化",
        "- 单卡调试可选最小规格",
        "- 选定后用 spec 参数传入",
      ].join("\n"),
      metadata: { error: "spec_id_required", available_specs: specs },
    }
  }
  return {
    title: "缺少规格 ID",
    output: [
      "未指定 spec_id 且无法查询可用规格。",
      "",
      "获取方式：在平台 UI 新建任务页面选择计算类型组后可看到规格 ID。",
    ].join("\n"),
    metadata: { error: "missing_spec_id" },
  }
}

export async function specInvalidError(
  specId: string,
  workspaceId: string,
  computeGroupId: string,
  computeGroupName: string,
  scheduleType?: string,
): Promise<InspireTypes.ToolResult> {
  const specs = await listAvailableSpecs(workspaceId, computeGroupId, scheduleType)
  const lines = [`spec_id "${specId}" 无效（计算组: ${computeGroupName}）。`, ""]
  if (specs.length > 0) {
    lines.push("当前计算组可用规格：", "", ...formatSpecTable(specs), "")
    lines.push("请选择正确的 spec_id 重新提交。")
  } else {
    lines.push("无法查询可用规格列表。请在平台 UI 新建任务时查看规格 ID。")
  }
  return {
    title: "提交失败: 规格 ID 无效",
    output: lines.join("\n"),
    metadata: { error: "invalid_spec_id", spec_id: specId, compute_group: computeGroupName, available_specs: specs },
  }
}
