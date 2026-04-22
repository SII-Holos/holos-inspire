import { InspireTypes } from "./types"
import { InspireAuth } from "./auth"

export namespace InspireAPI {

  // ── v2 request infrastructure ──────────────────────────────────

  const V2_HEADERS: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-inspire-client-source": "inspire-cli/5294f02",
  }

  async function postV2<T = any>(
    service: string,
    action: string,
    body: Record<string, any>,
    token: string,
  ): Promise<T> {
    const url = `${InspireTypes.PLATFORM_URL}/api/v2/${service}?Action=${action}`
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...V2_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (resp.status === 401 || resp.status === 302) {
      throw Object.assign(new Error("Authentication expired"), { code: -1, status: resp.status })
    }
    if (resp.status === 403) {
      const errData = await resp.json().catch(() => ({}))
      throw new Error(errData.message ?? `AccessForbidden`)
    }
    const data = await resp.json().catch(async () => {
      throw new Error(`API returned non-JSON (HTTP ${resp.status})`)
    })
    const metadata = data.ResponseMetadata
    if (metadata?.Error) {
      throw Object.assign(new Error(metadata.Error.Message ?? metadata.Error.Code ?? `API error`), {
        code: metadata.Error.Code,
      })
    }
    return data.Result ?? data.data ?? data
  }

  // ── v1 cookie fallback (for endpoints without v2 coverage) ─────

  function cookieHeaders(cookie: string, workspaceId?: string): Record<string, string> {
    return {
      ...InspireTypes.BROWSER_HEADERS,
      cookie,
      referer: workspaceId
        ? `${InspireTypes.PLATFORM_URL}/jobs/spacesOverview?spaceId=${workspaceId}`
        : `${InspireTypes.PLATFORM_URL}/`,
    }
  }

  async function postInternal<T = any>(
    endpoint: string,
    body: Record<string, any>,
    cookie: string,
    workspaceId?: string,
  ): Promise<T> {
    const resp = await fetch(`${InspireTypes.PLATFORM_URL}${endpoint}`, {
      method: "POST",
      headers: cookieHeaders(cookie, workspaceId),
      body: JSON.stringify(body),
    })
    if (resp.status === 401) throw Object.assign(new Error("Session expired"), { status: 401 })
    if (!resp.ok) {
      let detail = ""
      try {
        const errData = (await resp.json()) as any
        detail = errData.message ?? errData.msg ?? JSON.stringify(errData)
      } catch {
        try { detail = await resp.text() } catch {}
      }
      throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`)
    }
    const data = (await resp.json()) as any
    if (data.code !== 0) throw new Error(data.message ?? `API error code ${data.code}`)
    return data.data ?? data
  }

  // ── Projects (v1 cookie — no v2 equivalent with full data) ─────

  export async function listProjects(cookie: string): Promise<any[]> {
    const data = await postInternal("/api/v1/project/list", { page: 1, page_size: 100, filter: {} }, cookie)
    return data.items ?? []
  }

  // ── Workspace (v2) ────────────────────────────────────────────

  export async function getClusterBasicInfo(token: string, workspaceId: string): Promise<any> {
    return postV2("workspace", "GetBasicInfo", { workspace_id: workspaceId }, token)
  }

  export async function listNodeDimension(
    token: string,
    workspaceId: string,
    computeGroupId?: string,
  ): Promise<any[]> {
    const filter: Record<string, any> = { workspace_id: workspaceId }
    if (computeGroupId) filter.logic_compute_group_id = computeGroupId
    const data = await postV2("workspace", "ListNodeDimension", { filter }, token)
    return data.node_dimensions ?? []
  }

  export interface ResourceSpec {
    quota_id: string
    gpu_count: number
    cpu_count: number
    memory_size_gib: number
    total_price_per_hour: number
    gpu_info?: { gpu_type_display?: string; gpu_product_simple?: string; gpu_memory_size_gb?: number }
  }

  export async function listResourceSpecs(
    token: string,
    workspaceId: string,
    computeGroupId: string,
    scheduleType: string = "SCHEDULE_CONFIG_TYPE_TRAIN",
  ): Promise<ResourceSpec[]> {
    try {
      const data = await postV2(
        "workspace",
        "GetScheduleConfig",
        { workspace_id: workspaceId, logic_compute_group_id: computeGroupId, schedule_config_type: scheduleType },
        token,
      )

      // quota / predef_train_spec / serving_quota are JSON strings in the response
      const rawKey = scheduleType === "SCHEDULE_CONFIG_TYPE_TRAIN"
        ? (data.use_predef_train_spec ? "predef_train_spec" : "quota")
        : scheduleType === "SCHEDULE_CONFIG_TYPE_DSW" ? "quota" : "serving_quota"
      const raw = typeof data[rawKey] === "string" ? JSON.parse(data[rawKey]) : data[rawKey] ?? []

      return (Array.isArray(raw) ? raw : []).map((s: any) => ({
        quota_id: s.id ?? s.quota_id ?? "",
        gpu_count: s.gpu_count ?? 0,
        cpu_count: s.cpu_count ?? 0,
        memory_size_gib: s.memory_size ?? s.memory_size_gib ?? 0,
        total_price_per_hour: s.total_price_per_hour ?? 0,
        gpu_info: s.gpu_info,
      }))
    } catch {
      return []
    }
  }

  // ── Train (v2) ────────────────────────────────────────────────

  export async function listJobs(
    token: string,
    workspaceId: string,
    opts?: { pageNum?: number; pageSize?: number; createdBy?: string; status?: string },
  ): Promise<{ jobs: any[]; total: number }> {
    const payload: Record<string, any> = {
      page_num: opts?.pageNum ?? 1,
      page_size: opts?.pageSize ?? 100,
      workspace_id: workspaceId,
    }
    if (opts?.createdBy) payload.created_by = opts.createdBy
    if (opts?.status) payload.status = opts.status
    const data = await postV2("train", "ListJobs", payload, token)
    return { jobs: data.jobs ?? [], total: data.total ?? 0 }
  }

  export async function getJobDetail(token: string, jobId: string): Promise<any> {
    return postV2("train", "GetJob", { job_id: jobId }, token)
  }

  export async function createJob(
    token: string,
    config: {
      name: string
      workspace_id: string
      project_id: string
      logic_compute_group_id: string
      command: string
      task_priority: number
      spec_id: string
      image: string
      image_type?: ImageType
      instance_count: number
      shm_gi: number
      framework?: string
      auto_fault_tolerance?: boolean
      fault_tolerance_max_retry?: number
    },
  ): Promise<any> {
    const body: Record<string, any> = {
      name: config.name,
      workspace_id: config.workspace_id,
      project_id: config.project_id,
      logic_compute_group_id: config.logic_compute_group_id,
      command: config.command,
      task_priority: config.task_priority,
      framework: config.framework ?? "pytorch",
      auto_fault_tolerance: config.auto_fault_tolerance ?? false,
      framework_config: [
        {
          image: config.image,
          image_type: config.image_type ?? "SOURCE_PRIVATE",
          instance_count: config.instance_count,
          shm_gi: config.shm_gi,
          spec_id: config.spec_id,
        },
      ],
    }
    if (config.auto_fault_tolerance && config.fault_tolerance_max_retry) {
      body.fault_tolerance_max_retry = config.fault_tolerance_max_retry
    }
    return postV2("train", "CreateJob", body, token)
  }

  export async function stopJob(token: string, jobId: string): Promise<void> {
    await postV2("train", "StopJob", { job_id: jobId }, token)
  }

  // ── HPC (v2 for create/detail/stop, v1 cookie for list) ────────

  export async function createHpcJob(token: string, config: Record<string, any>): Promise<any> {
    return postV2("hpc", "CreateJob", config, token)
  }

  export async function getHpcJobDetail(token: string, jobId: string): Promise<any> {
    return postV2("hpc", "GetJob", { job_id: jobId }, token)
  }

  export async function stopHpcJob(token: string, jobId: string): Promise<void> {
    await postV2("hpc", "StopJob", { job_id: jobId }, token)
  }

  /** v2 has no HPC ListJobs — falls back to v1 cookie path */
  export async function listHpcJobs(
    cookie: string,
    workspaceId: string,
    opts?: { status?: string; pageNum?: number; pageSize?: number },
  ): Promise<{ jobs: any[]; total: number }> {
    const payload: Record<string, any> = {
      workspace_id: workspaceId,
      page_num: opts?.pageNum ?? 1,
      page_size: opts?.pageSize ?? 100,
    }
    if (opts?.status) payload.status = opts.status
    const data = await postInternal("/api/v1/hpc_jobs/list", payload, cookie, workspaceId)
    return { jobs: data.jobs ?? data.list ?? [], total: data.total ?? 0 }
  }

  // ── Inference Serving (v2) ─────────────────────────────────────

  export type ImageType = "SOURCE_PUBLIC" | "SOURCE_PRIVATE" | "SOURCE_OFFICIAL"

  export async function createInference(
    token: string,
    config: {
      name: string
      workspace_id: string
      project_id: string
      logic_compute_group_id: string
      command: string
      image: string
      image_type?: ImageType
      model_id: string
      model_version: number
      port: number
      replicas: number
      node_num_per_replica: number
      task_priority: number
      spec_id: string
      custom_domain?: string
    },
  ): Promise<any> {
    const body: Record<string, any> = {
      name: config.name,
      workspace_id: config.workspace_id,
      project_id: config.project_id,
      logic_compute_group_id: config.logic_compute_group_id,
      command: config.command,
      image: config.image,
      image_type: config.image_type ?? "SOURCE_PUBLIC",
      model_id: config.model_id,
      model_version: config.model_version,
      port: config.port,
      replicas: config.replicas,
      node_num_per_replica: config.node_num_per_replica,
      task_priority: config.task_priority,
      spec_id: config.spec_id,
    }
    if (config.custom_domain) {
      body.custom_domain = config.custom_domain
    }
    return postV2("inference_serving", "CreateServing", body, token)
  }

  export async function getInferenceDetail(token: string, servingId: string): Promise<any> {
    return postV2("inference_serving", "GetServing", { inference_serving_id: servingId }, token)
  }

  export async function stopInference(token: string, servingId: string): Promise<void> {
    await postV2("inference_serving", "StopServing", { inference_serving_id: servingId }, token)
  }

  // ── Notebook (v2 for detail/operate, v1 cookie for list/create) ──

  export type NotebookOperation = "START" | "STOP"

  export async function listNotebooks(
    cookie: string,
    workspaceId: string,
    opts?: { page?: number; pageSize?: number },
  ): Promise<{ items: any[]; total: number }> {
    const data = await postInternal("/api/v1/notebook/list", {
      workspace_id: workspaceId,
      page_size: opts?.pageSize ?? 100,
      page: opts?.page ?? 1,
    }, cookie, workspaceId)
    return { items: data.list ?? [], total: data.total ?? 0 }
  }

  export async function getNotebookDetail(token: string, notebookId: string): Promise<any> {
    return postV2("notebook", "GetNotebook", { notebook_id: notebookId }, token)
  }

  export async function operateNotebook(
    token: string,
    notebookId: string,
    operation: NotebookOperation,
  ): Promise<void> {
    const action = operation === "START" ? "StartNotebook" : "StopNotebook"
    await postV2("notebook", action, { notebook_id: notebookId }, token)
  }

  export async function createNotebook(cookie: string, config: Record<string, any>): Promise<any> {
    return postInternal("/api/v1/notebook/create", config, cookie, config.workspace_id)
  }

  // ── Logs & Metrics (v2) ───────────────────────────────────────

  export interface TrainLogEntry {
    log_id: string
    message: string
    node: string
    pod_name: string
    time: string
    timestamp_ms: string
    timestamp_str: string
  }

  export async function getTrainLogs(
    token: string,
    opts: {
      jobId: string
      instanceCount?: number
      pageSize?: number
      startTimestampMs?: string
      endTimestampMs?: string
    },
  ): Promise<{ logs: TrainLogEntry[]; total: number }> {
    const podNames: string[] = []
    const count = opts.instanceCount ?? 1
    for (let i = 0; i < count; i++) {
      podNames.push(`${opts.jobId}-worker-${i}`)
    }

    const filter: Record<string, any> = { podNames }
    if (opts.startTimestampMs) filter.start_timestamp_ms = opts.startTimestampMs
    if (opts.endTimestampMs) filter.end_timestamp_ms = opts.endTimestampMs

    const body: Record<string, any> = {
      page_size: opts.pageSize ?? 200,
      filter,
      sorter: [
        { field: "time", sort: "descend" },
        { field: "log-id.keyword", sort: "descend" },
      ],
    }

    const data = await postV2("train", "GetJobLog", body, token)
    return { logs: data.logs ?? [], total: data.total ?? 0 }
  }

  export type MetricType =
    | "gpu_usage_rate"
    | "gpu_memory_usage_rate"
    | "cpu_usage_rate"
    | "memory_usage_rate"
    | "disk_io_read"
    | "disk_io_write"
    | "network_io_read"
    | "network_io_write"
    | "network_storage_io_read"
    | "network_storage_io_write"

  export interface MetricTimeSeries {
    group_name: string
    metric_type: string
    resource_name: string
    time_series: Array<{ data: number; timestamp: string }>
  }

  export async function getClusterMetrics(
    token: string,
    opts: {
      computeGroupId: string
      taskId: string
      metricTypes: MetricType[]
      startTimestamp: number
      endTimestamp: number
      intervalSecond?: number
      taskType?: string
      runningRound?: number
    },
  ): Promise<MetricTimeSeries[]> {
    const filter: Record<string, any> = {
      logic_compute_group_id: opts.computeGroupId,
      task_type: opts.taskType ?? "distributed_training",
      task_id: opts.taskId,
    }
    if (opts.runningRound) filter.running_round = opts.runningRound

    const body: Record<string, any> = {
      metric_types: opts.metricTypes,
      filter,
      time_range: {
        start_timestamp: opts.startTimestamp,
        end_timestamp: opts.endTimestamp,
        interval_second: opts.intervalSecond ?? 60,
      },
    }

    const data = await postV2("train", "GetTaskMetric", body, token)
    return data.time_seris_metric_groups ?? data.time_series_metric_groups ?? []
  }

  // ── Model (v1 cookie — no v2 model service) ────────────────────

  export async function listModels(
    cookie: string,
    workspaceId: string,
    opts?: { page?: number; pageSize?: number },
  ): Promise<{ items: any[]; total: number }> {
    const body: Record<string, any> = {
      workspace_id: workspaceId,
      page_size: opts?.pageSize ?? 100,
      page: opts?.page ?? 1,
    }
    const data = await postInternal("/api/v1/model/list", body, cookie, workspaceId)
    return { items: data.list ?? [], total: data.total ?? 0 }
  }

  export async function getModelDetail(cookie: string, modelId: string): Promise<any> {
    const data = await postInternal("/api/v1/model/detail", { model_id: modelId }, cookie)
    return data.model ?? data
  }

  export async function createModel(cookie: string, config: Record<string, any>): Promise<any> {
    return postInternal("/api/v1/model/create", config, cookie, config.workspace_id)
  }

  export async function deleteModel(cookie: string, modelId: string): Promise<void> {
    await postInternal("/api/v1/model/delete", { model_id: modelId }, cookie)
  }

  // ── Image (v1 cookie — v2 returns AccessForbidden) ─────────────

  export async function listPlatformImages(
    cookie: string,
    workspaceId: string,
    opts?: { search?: string; imageType?: string },
  ): Promise<{ images: any[]; total: number }> {
    const filter: Record<string, any> = {
      registry_hint: { workspace_id: workspaceId },
    }
    if (opts?.imageType) filter.source = opts.imageType
    const payload: Record<string, any> = {
      page_size: -1,
      page: 0,
      filter,
    }
    const data = await postInternal("/api/v1/image/list", payload, cookie, workspaceId)
    return { images: data.images ?? [], total: data.total ?? 0 }
  }

  // ── Utility helpers ────────────────────────────────────────────

  export function extractSpecId(job: any): string | undefined {
    const fc = job.framework_config ?? []
    const first = fc[0] ?? {}
    return first.instance_spec_price_info?.quota_id ?? first.spec_id ?? undefined
  }

  export function extractGpuInfo(job: any): { gpu_count: number; instance_count: number; image: string } {
    const fc = job.framework_config ?? []
    const first = fc[0] ?? {}
    return {
      gpu_count: first.instance_spec_price_info?.gpu_count ?? first.gpu_count ?? 0,
      instance_count: first.instance_count ?? 1,
      image: first.image ?? "",
    }
  }

  export function buildJobUrl(jobId: string, workspaceId: string, type: "gpu" | "hpc" | "inference" = "gpu"): string {
    if (type === "hpc") return `${InspireTypes.PLATFORM_URL}/jobs/hpc?spaceId=${workspaceId}`
    if (type === "inference") return `${InspireTypes.PLATFORM_URL}/deploy/inference?spaceId=${workspaceId}`
    return `${InspireTypes.PLATFORM_URL}/jobs/distributedTrainingDetail/${jobId}?spaceId=${workspaceId}`
  }

  export function buildNotebookUrl(notebookId: string, workspaceId: string): string {
    return `${InspireTypes.PLATFORM_URL}/develop/notebook/${notebookId}?spaceId=${workspaceId}`
  }
}
