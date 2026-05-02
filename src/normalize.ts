import type { InspireTypes } from "./types"

const FAMILY_RULES: Array<{ family: InspireTypes.StatusFamily["family"]; tokens: string[] }> = [
  { family: "running", tokens: ["running", "executing", "active", "serving", "training", "processing"] },
  { family: "creating", tokens: ["creating"] },
  { family: "starting", tokens: ["starting"] },
  { family: "stopping", tokens: ["stopping"] },
  { family: "waiting", tokens: ["queue", "queued", "queuing", "pending", "waiting", "scheduling"] },
  { family: "succeeded", tokens: ["success", "succeeded", "complete", "completed", "finish", "finished", "done"] },
  { family: "failed", tokens: ["fail", "failed", "error", "exception", "killed", "crash"] },
  { family: "stopped", tokens: ["stop", "stopped", "cancel", "cancelled", "canceled", "terminate", "terminated"] },
]

/** v2 HPC/Inference numeric status codes → human-readable string */
const V2_STATUS_MAP: Record<number, string> = {
  1: "creating",
  2: "scheduling",
  3: "waiting",
  4: "running",
  5: "succeeded",
  6: "failed",
  7: "stopped",
  8: "queued",
}

/**
 * Notebook (DSW) numeric status codes.
 * NOTE: Notebooks use a DIFFERENT numeric encoding than HPC/Inference.
 * Derived from API observation:
 *   2 = starting, 3 = running, 5 = stopped
 */
const NOTEBOOK_STATUS_MAP: Record<number, string> = {
  0: "creating",
  1: "creating",
  2: "starting",
  3: "running",
  4: "stopping",
  5: "stopped",
  6: "failed",
}

export namespace InspireNormalize {
  /** Generic status normalization (for HPC/Inference/training jobs). */
  export function status(raw: any): InspireTypes.StatusFamily {
    // Handle v2 numeric status codes first
    if (typeof raw === "number") {
      const label = V2_STATUS_MAP[raw] ?? String(raw)
      return statusFromToken(label, raw)
    }
    // Handle objects that may contain a numeric status field
    if (raw && typeof raw === "object" && typeof raw.status === "number") {
      const label = V2_STATUS_MAP[raw.status] ?? String(raw.status)
      return statusFromToken(label, raw.status)
    }
    const str = typeof raw === "string" ? raw : String(raw ?? "")
    return statusFromToken(str, raw)
  }

  /**
   * Notebook-specific status normalization.
   * Notebooks use a DIFFERENT numeric encoding than other v2 APIs.
   */
  export function notebookStatus(raw: any): InspireTypes.StatusFamily {
    if (typeof raw === "number") {
      const label = NOTEBOOK_STATUS_MAP[raw] ?? `unknown(${raw})`
      return statusFromToken(label, raw)
    }
    if (raw && typeof raw === "object" && typeof raw.status === "number") {
      const label = NOTEBOOK_STATUS_MAP[raw.status] ?? `unknown(${raw.status})`
      return statusFromToken(label, raw.status)
    }
    const str = typeof raw === "string" ? raw : String(raw ?? "")
    return statusFromToken(str, raw)
  }

  function statusFromToken(lowerable: string, raw: any): InspireTypes.StatusFamily {
    const lower = lowerable.toLowerCase().trim()
    for (const rule of FAMILY_RULES) {
      if (rule.tokens.some((t) => lower.includes(t))) {
        const is_terminal = rule.family === "succeeded" || rule.family === "failed" || rule.family === "stopped"
        return { family: rule.family, is_terminal, raw }
      }
    }
    return { family: "unknown", is_terminal: false, raw }
  }

  export function formatDuration(ms: number | string | undefined): string {
    if (ms === undefined) return ""
    const total = typeof ms === "string" ? parseInt(ms, 10) : ms
    if (isNaN(total) || total <= 0) return ""
    const hours = Math.floor(total / 3_600_000)
    const minutes = Math.floor((total % 3_600_000) / 60_000)
    const seconds = Math.floor((total % 60_000) / 1_000)
    if (hours > 0) return `${hours} 小时 ${minutes} 分`
    if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
    return `${seconds} 秒`
  }

  export function formatTimestamp(ts: string | number | undefined): string {
    if (!ts) return ""
    if (typeof ts === "string" && ts.includes("-")) return ts.replace(/T/, " ").replace(/\.\d+Z$/, "").replace(/Z$/, "")
    const n = typeof ts === "number" ? ts : parseInt(ts, 10)
    if (isNaN(n)) return String(ts)
    // Auto-detect seconds vs milliseconds: values < 1e12 are likely seconds
    const ms = n < 1e12 ? n * 1000 : n
    return new Date(ms)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "")
  }

  export interface TimelineStage {
    label: string
    value: string
  }

  export interface TimelineAnalysis {
    summary: string
    stages: TimelineStage[]
    /** Milliseconds from created to resource_prepared */
    queueMs?: number
    /** Milliseconds from run to finished */
    runMs?: number
    /** Whether the job never reached run phase */
    neverStarted: boolean
  }

  export function analyzeTimeline(timeline: any): TimelineAnalysis {
    if (!timeline || typeof timeline !== "object") {
      return { summary: "", stages: [], neverStarted: false }
    }

    const created = parseTs(timeline.created)
    const prepared = parseTs(timeline.resource_prepared)
    const run = parseTs(timeline.run)
    const finished = parseTs(timeline.finished)

    const stages: TimelineStage[] = []
    let queueMs: number | undefined
    let runMs: number | undefined
    let neverStarted = false
    const parts: string[] = []

    if (created > 0) stages.push({ label: "创建", value: fmtTs(created) })
    if (prepared > 0) stages.push({ label: "资源就绪", value: fmtTs(prepared) })
    if (run > 0) stages.push({ label: "开始运行", value: fmtTs(run) })
    if (finished > 0) stages.push({ label: "结束", value: fmtTs(finished) })

    if (created > 0 && prepared > 0) {
      queueMs = prepared - created
      parts.push(`排队 ${formatDuration(queueMs)}`)
    }
    if (prepared > 0 && run > 0) {
      parts.push(`启动 ${formatDuration(run - prepared)}`)
    }
    if (run > 0 && finished > 0) {
      runMs = finished - run
      parts.push(`运行 ${formatDuration(runMs)}`)
    }
    if (created > 0 && run === 0 && (finished > 0 || prepared > 0)) {
      neverStarted = true
      parts.push("未进入运行阶段")
    }

    return {
      summary: parts.join(" → "),
      stages,
      queueMs,
      runMs,
      neverStarted,
    }
  }
}

function parseTs(v: any): number {
  if (!v) return 0
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : 0
  return isNaN(n) || n <= 0 ? 0 : n
}

function fmtTs(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
}
