import z from "zod"
import { tool } from "@ericsanchezok/synergy-plugin"
import { InspireHarbor } from "../harbor"
import { InspireAuth } from "../auth"
import { InspireTypes } from "../types"

const DESCRIPTION = `Push a Docker image to the SII 启智平台 Harbor registry. ALWAYS use this tool instead of running docker push via bash.

Why this tool instead of bash docker push:
- Automatically logs in to Harbor with the correct credentials (no manual docker login needed)
- Handles the inspire-studio/ project path prefix automatically
- Returns the display-domain address (docker.sii.shaipower.online) needed by inspire_submit and inspire_notebook
- Provides the exact 镜像名称 and 版本号 values needed for platform registration after push
- Falls back automatically across docker → podman → buildah → skopeo if the primary tool is unavailable

Running docker push via bash will fail without Harbor authentication and will not guide the user through the required registration step.

Two registries:
- 七宝 (default, registry="qb"): serves all spaces except SJ资源空间
- 松江 (registry="sj"): serves SJ资源空间 only

Prerequisites: at least one of docker / podman / buildah / skopeo installed locally, insecure-registry configured if the tool requires it, VPN or campus network.

After pushing, the user MUST register the image on the platform (镜像管理 → 新建镜像) with the 镜像名称 and 版本号 shown in the output. Without registration, the image cannot be used for task submission or notebook creation.`

export const inspireImagePush = tool({
  description: DESCRIPTION,
  args: {
    image: z
      .string()
      .describe("Local Docker image name and tag (e.g. 'my-train:v1'). If no tag specified, defaults to 'latest'"),
    name: z
      .string()
      .optional()
      .describe("Remote 镜像名称（不含项目前缀）. E.g. use 'faro-postgres', NOT 'inspire-studio/faro-postgres'. The tool auto-prepends the project path. Defaults to the image name part"),
    tag: z.string().optional().describe("Remote 版本号. Defaults to the image tag part"),
    registry: z
      .enum(["qb", "sj"])
      .optional()
      .describe("Target registry: 'qb' (七宝, default, most spaces) or 'sj' (松江, SJ资源空间 only). Each has separate credentials"),
    description: z
      .string()
      .optional()
      .describe(
        "镜像描述（如 'PyTorch 2.9 + CUDA 12.8 + DeepSpeed'）。首次推送时设置，方便后续识别",
      ),
  },
  async execute(params, ctx) {
    try {
      const colonIdx = params.image.lastIndexOf(":")
      let parsedName: string
      let parsedTag: string
      if (colonIdx > 0) {
        parsedName = params.image.slice(0, colonIdx)
        parsedTag = params.image.slice(colonIdx + 1)
      } else {
        parsedName = params.image
        parsedTag = "latest"
      }

      const remoteName = params.name ?? parsedName
      const remoteTag = params.tag ?? parsedTag
      const target = params.registry ?? "qb"

      const result = await InspireHarbor.pushImage({
        localImage: params.image,
        remoteName,
        remoteTag,
        target,
      })

      let descriptionSet = false
      if (params.description) {
        try {
          await InspireHarbor.setDescription(remoteName, params.description)
          descriptionSet = true
        } catch {}
      }

      // Build display domain address (replace push domain with display domain)
      const displayDomain = target === "sj" ? "docker-t.sii.shaipower.online" : "docker.sii.shaipower.online"
      const displayPath = result.fullPath.replace(/^[^/]+/, displayDomain)

      const lines = ["=== 镜像推送成功 ===", "", `推送工具: ${result.tool}`, `推送地址: ${result.fullPath}`, `使用地址: ${displayPath}`]
      if (result.warnedDuplicatePath) {
        lines.push("⚠ name 参数包含了项目前缀（如 inspire-studio/），已自动去除。下次直接用镜像名称即可，如 'faro-postgres' 而非 'inspire-studio/faro-postgres'")
      }
      if (result.digest) lines.push(`Digest: ${result.digest}`)
      if (params.description && descriptionSet) lines.push(`描述: ${params.description}`)
      if (params.description && !descriptionSet) lines.push("⚠ 描述设置失败（权限不足），推送本身已成功")
      lines.push(
        "",
        "下一步（必须）:",
        "  在平台「镜像管理 → 新建镜像」中注册该镜像：",
        `    镜像名称: ${remoteName}`,
        `    版本号: ${remoteTag}`,
        `  注册后即可在 inspire_submit 中使用:`,
        `     inspire_submit(image="${displayPath}", ...)`,
      )

      return {
        title: `pushed ${result.fullPath}`,
        output: lines.join("\n"),
        metadata: { fullPath: result.fullPath, digest: result.digest, remoteName, remoteTag },
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "")

      if (msg.includes("harbor_not_authenticated") || msg.includes("not authenticated")) {
        return InspireAuth.notAuthenticatedError("harbor")
      }
      if (msg.includes("no_push_tool")) {
        return {
          title: "无可用推送工具",
          output: [
            "本地未找到任何可用的容器工具。推送需要以下任一工具：",
            "",
            "  • docker  — 最常见；需要 Docker daemon 运行",
            "  • podman  — 与 docker CLI 兼容，无需 daemon（推荐研究集群环境）",
            "  • buildah — 与 buildah bud 构建配合使用（image-build.txt 推荐的 build fallback）",
            "  • skopeo  — 最灵活，可从 containers-storage / docker-daemon 读源",
            "",
            "快速安装建议：",
            "  Ubuntu/Debian: apt install podman buildah skopeo",
            "  CentOS/RHEL:   dnf install podman buildah skopeo",
            "",
            "临时方案：用 docker/podman save 导出 .tar 文件，在平台页面手动上传。",
          ].join("\n"),
          metadata: { error: "no_push_tool" },
        }
      }
      if (msg.includes("all_push_tools_failed")) {
        return {
          title: "推送失败",
          output: [
            "已尝试所有可用的容器工具（docker/podman/buildah/skopeo），但都失败了。",
            "",
            msg,
            "",
            "常见原因：",
            "  1. 镜像不在尝试工具的 storage 里（如用 docker build 的镜像不在 buildah/skopeo 的 containers-storage 里）",
            "  2. Harbor 服务不可达（检查 VPN / 校园网）",
            "  3. Robot 账号无推送权限",
            "",
            "排查：先用 `docker images` / `buildah images` / `podman images` 确认镜像存在于哪个 storage 中。",
          ].join("\n"),
          metadata: { error: "all_push_tools_failed" },
        }
      }
      if (msg.includes("not installed") || msg.includes("not in PATH")) {
        // Legacy error path — shouldn't happen with new fallback logic
        return {
          title: "容器工具未安装",
          output: "本地未安装 docker/podman/buildah/skopeo 中的任何一个。请至少安装其中之一。",
          metadata: { error: "no_push_tool" },
        }
      }
      if (msg.includes("No such image") || msg.includes("not found locally")) {
        return {
          title: "镜像未找到",
          output: `本地找不到镜像 '${params.image}'。可通过 bash 执行 \`docker images\` 查看本地可用镜像。`,
          metadata: { error: "image_not_found", image: params.image },
        }
      }
      if (
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("connection refused")
      ) {
        return {
          title: "推送失败",
          output: "推送失败，请确认处于 VPN 或校园网环境。",
          metadata: { error: "network_error" },
        }
      }
      if (msg.includes("unavailable") || msg.includes("unknown error") || msg.includes("error from registry")) {
        const remoteName = params.name ?? params.image.split(":")[0]
        return {
          title: "推送失败",
          output: [
            "推送失败，Harbor 返回 Unavailable 或 unknown error。可能原因：",
            "",
            "1. Robot 账号没有 push 到该仓库的权限——检查账号权限范围",
            "2. Harbor 服务暂时不可用——稍后重试",
            "3. 网络不稳定——确认 VPN 或校园网连接正常",
            "",
            "提示：Harbor 支持自动创建仓库，无需预先创建。如持续失败，请联系平台管理员。",
            "临时方案：用 docker save 导出 .tar 文件，在平台页面手动上传。",
          ].join("\n"),
          metadata: { error: "harbor_unavailable", remoteName },
        }
      }

      throw err
    }
  },
})
