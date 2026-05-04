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
- Falls back automatically across docker → podman → buildah → skopeo if the primary tool is unavailable or can't see the image

Running docker push via bash will fail without Harbor authentication and will not guide the user through the required registration step.

Two registries:
- 七宝 (default, registry="qb"): serves all spaces except SJ资源空间
- 松江 (registry="sj"): serves SJ资源空间 only

Prerequisites: at least one of docker / podman / buildah / skopeo installed locally, insecure-registry configured if the tool requires it, VPN or campus network.

After pushing, the user MUST register the image on the platform (镜像管理 → 新建镜像) with the 镜像名称 and 版本号 shown in the output. Without registration, the image cannot be used for task submission or notebook creation.`

const PLATFORM_URL = "https://qz.sii.edu.cn"

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
      .describe("镜像描述（如 'PyTorch 2.9 + CUDA 12.8 + DeepSpeed'）。首次推送时设置，方便后续识别"),
  },
  async execute(params): Promise<InspireTypes.ToolResult> {
    const colonIdx = params.image.lastIndexOf(":")
    const parsedName = colonIdx > 0 ? params.image.slice(0, colonIdx) : params.image
    const parsedTag = colonIdx > 0 ? params.image.slice(colonIdx + 1) : "latest"
    const remoteName = params.name ?? parsedName
    const remoteTag = params.tag ?? parsedTag
    const target = params.registry ?? "qb"

    try {
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

      const displayDomain = target === "sj" ? "docker-t.sii.shaipower.online" : "docker.sii.shaipower.online"
      const displayPath = result.fullPath.replace(/^[^/]+/, displayDomain)

      const lines = [
        "=== 镜像推送成功 ===",
        "",
        `推送工具: ${result.tool}`,
        `推送地址: ${result.fullPath}`,
        `使用地址: ${displayPath}`,
      ]
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
        metadata: {
          fullPath: result.fullPath,
          digest: result.digest,
          remoteName,
          remoteTag,
          tool: result.tool,
        },
      }
    } catch (err) {
      if (err instanceof InspireHarbor.PushError) return renderPushError(err, target)
      const msg = String((err as Error)?.message ?? err ?? "")
      if (msg.startsWith("harbor_not_authenticated")) return InspireAuth.notAuthenticatedError("harbor")
      if (msg === "no_push_tool") return renderNoPushTool()
      throw err
    }
  },
})

function renderNoPushTool(): InspireTypes.ToolResult {
  return {
    title: "无可用推送工具",
    output: [
      "本地未找到任何容器工具。推送需要以下任一：",
      "",
      "  • docker  — 最常见；需要 Docker daemon 运行",
      "  • podman  — 与 docker CLI 兼容，无需 daemon（推荐研究集群环境）",
      "  • buildah — 与 buildah bud 配合使用（image-build.txt 推荐的 build fallback）",
      "  • skopeo  — 最灵活，可读 containers-storage / docker-daemon / .tar 等多种源",
      "",
      "安装建议（任一即可）:",
      "  Ubuntu/Debian: sudo apt install podman buildah skopeo",
      "  CentOS/RHEL:   sudo dnf install podman buildah skopeo",
      "",
      "临时方案: docker/podman save -o image.tar → 平台 UI「镜像管理 → 本地推送 → 上传 tar」",
    ].join("\n"),
    metadata: { error: "no_push_tool" },
  }
}

function renderPushError(err: InspireHarbor.PushError, target: InspireTypes.HarborTarget): InspireTypes.ToolResult {
  const { kind, tool, raw, context } = err
  const image = context.image ?? ""
  const registry = context.registry ?? ""
  const fullPath = context.fullPath ?? ""
  const attempts = context.attempts ?? [err]
  const imageBase = image.includes(":") ? image.slice(0, image.lastIndexOf(":")) : image
  const repoPath = fullPath.split(":")[0]

  const attemptsBlock =
    attempts.length > 1
      ? "\n尝试过的工具:\n" +
        attempts
          .map((a) => `  [${a.tool}] ${a.kind}: ${a.raw.slice(0, 200).replace(/\s+/g, " ").trim()}`)
          .join("\n")
      : ""
  const attemptsMeta = attempts.map((a) => ({ tool: a.tool, kind: a.kind, raw: a.raw.slice(0, 300) }))
  const short = (s: string, n = 300) => s.slice(0, n)

  switch (kind) {
    case "auth_failed":
      return {
        title: "Harbor 凭据失效",
        output: [
          `❌ Harbor 拒绝凭据（工具 [${tool}]）。`,
          "",
          "启智平台 Harbor 账号和平台账号是分开的；密码来自「镜像管理 → 本地推送」页面。",
          "",
          "下一步:",
          `  1. 打开 ${PLATFORM_URL} → 镜像管理 → 本地推送`,
          "  2. 复制 Robot 账号的 username 和 password",
          `  3. 运行 inspire_login(target="harbor", username="...", password="...", registry="${target}")`,
          "  4. 重试 inspire_image_push",
          "",
          `原始错误: ${short(raw)}`,
        ].join("\n"),
        metadata: { error: "auth_failed", tool, registry: target, attempts: attemptsMeta },
      }

    case "permission_denied":
      return {
        title: "无推送权限",
        output: [
          `❌ Harbor 拒绝 push 到 ${fullPath}，Robot 账号无权限（工具 [${tool}]）。`,
          "",
          "可能原因:",
          `  - Robot 账号 scope 未包含 ${repoPath}`,
          "  - 平台升级后权限被重置",
          "",
          "下一步:",
          "  - 联系平台管理员扩展 Robot 账号权限",
          "  - 临时方案: docker save -o image.tar → 平台 UI「镜像管理 → 本地推送」上传 tar",
          "",
          `原始错误: ${short(raw)}`,
        ].join("\n"),
        metadata: { error: "permission_denied", fullPath, tool, attempts: attemptsMeta },
      }

    case "image_missing":
      return {
        title: "镜像未找到",
        output: [
          `❌ 所有容器工具都找不到镜像 '${image}'。`,
          "",
          "工具间的 image storage 是隔离的:",
          "  - docker build 的镜像 → /var/lib/docker（仅 docker 可见）",
          "  - buildah bud / podman build → containers-storage（buildah/podman/skopeo 共享）",
          "",
          "排查:",
          `  1. bash: docker images | grep ${imageBase}`,
          `  2. bash: podman images | grep ${imageBase}    # 或 buildah images`,
          "",
          "解决:",
          "  - 镜像在 docker 但其他工具看不到 → 启动 dockerd；或 docker save <img> -o /tmp/img.tar && podman load -i /tmp/img.tar",
          "  - 镜像根本不存在 → 重新构建（参考 image-build.txt）",
          attemptsBlock,
        ].join("\n"),
        metadata: { error: "image_missing", image, attempts: attemptsMeta },
      }

    case "daemon_down":
      return {
        title: "Docker daemon 未运行",
        output: [
          "❌ Docker daemon 不可用，其他工具（podman/buildah/skopeo）也未能读到该镜像。",
          "",
          "通常意味着镜像只存在于 Docker daemon storage，而 daemon 没启动——其他工具无法访问。",
          "",
          "解决:",
          "  - 启动 daemon: sudo systemctl start docker （或 sudo dockerd &）",
          "  - 或改用 podman/buildah 重新构建到 containers-storage",
          attemptsBlock,
        ].join("\n"),
        metadata: { error: "daemon_down", attempts: attemptsMeta },
      }

    case "network":
      return {
        title: "网络不通",
        output: [
          `❌ 无法连接到 Harbor${registry ? ` (${registry})` : ""}。`,
          "",
          "可能原因:",
          "  1. 未连 VPN（aTrust）或不在校园网",
          "  2. DNS 解析失败（校内域名 DNS 需设为 10.11.26.11）",
          "  3. 防火墙拦截",
          "",
          `验证: curl -v https://${registry || "docker-qb.sii.edu.cn"}/v2/`,
          "",
          `原始错误: ${short(raw)}`,
        ].join("\n"),
        metadata: { error: "network", registry, attempts: attemptsMeta },
      }

    case "harbor_unavailable":
      return {
        title: "Harbor 服务不可用",
        output: [
          `❌ Harbor 返回 5xx / Unavailable（工具 [${tool}]）。`,
          "",
          "服务端问题，稍后重试。如持续 15 分钟以上，联系平台管理员。",
          "",
          `原始错误: ${short(raw)}`,
        ].join("\n"),
        metadata: { error: "harbor_unavailable", tool, attempts: attemptsMeta },
      }

    case "size_limit":
      return {
        title: "镜像过大",
        output: [
          "❌ 镜像超过 Harbor 的大小限制。",
          "",
          "减小策略:",
          "  - 用 -runtime 基础镜像替代 -devel（省 ~2GB）",
          "  - apt clean && pip cache purge && rm -rf ~/.cache 后再 commit",
          "  - 多阶段构建：builder stage 装编译依赖，final stage 只 COPY 产物",
          "  - 拆分为多个镜像：模型权重 / 代码 / 依赖分离",
          "",
          "参考: skills/sii-inspire/references/image-build.txt「Image size」一节",
          "",
          `原始错误: ${short(raw)}`,
        ].join("\n"),
        metadata: { error: "size_limit", attempts: attemptsMeta },
      }

    case "tls":
      return {
        title: "TLS / 证书错误",
        output: [
          `❌ 无法建立 HTTPS 连接到 ${registry}（证书或协议错误）。`,
          "",
          "通常是 daemon 没配 insecure-registry 或缺少 CA 证书。",
          "",
          "修复:",
          "  docker: /etc/docker/daemon.json 加",
          `    { "insecure-registries": ["${registry}"] }`,
          "    然后 sudo systemctl restart docker",
          "  podman: /etc/containers/registries.conf 加 [[registry]] 块",
          "  buildah/skopeo: 可用 --tls-verify=false（不推荐生产）",
          "",
          `原始错误: ${short(raw)}`,
        ].join("\n"),
        metadata: { error: "tls", registry, attempts: attemptsMeta },
      }

    case "unknown":
      return {
        title: "推送失败（未分类）",
        output: [
          `❌ 推送失败，错误未归类到已知类型（工具 [${tool}]）。`,
          "",
          "建议:",
          `  - 手动运行 ${tool} push ${fullPath} 查看完整输出`,
          "  - 或切换到 docker save + 平台 UI 手动上传",
          "",
          `原始错误: ${short(raw, 500)}`,
          attemptsBlock,
        ].join("\n"),
        metadata: { error: "unknown", tool, attempts: attemptsMeta },
      }
  }
}
