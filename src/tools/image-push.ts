import z from "zod"
import { tool } from "@ericsanchezok/synergy-plugin"
import { InspireHarbor } from "../harbor"
import { InspireAuth } from "../auth"
import { InspireTypes } from "../types"

const DESCRIPTION = `Push a local Docker image to the SII 启智平台 Harbor registry.

Pushes to ${InspireTypes.HARBOR_REGISTRY} which serves all spaces except SJ资源空间.
SJ资源空间 uses a separate registry: docker-t.sii.edu.cn.

Prerequisites:
- Docker must be installed and running locally
- Add insecure registry to /etc/docker/daemon.json: { "insecure-registries": ["${InspireTypes.HARBOR_REGISTRY}"] }, then restart Docker
- Harbor credentials configured (synergy inspire harbor-login). Password is separate from platform password — find it under 镜像管理 → 本地推送
- Must be on VPN or campus network

After pushing, you MUST register the image on the platform:
Go to 镜像管理 → 新建镜像, fill in 镜像名称 and 版本号, then save.
Without registration, the image cannot be used for task submission or notebook creation.

Note: the push domain (${InspireTypes.HARBOR_REGISTRY}) differs from the display domain the platform assigns after registration (docker.sii.shaipower.online). Always use the platform-assigned address when submitting tasks.`

export const inspireImagePush = tool({
  description: DESCRIPTION,
  args: {
    image: z
      .string()
      .describe("Local Docker image name and tag (e.g. 'my-train:v1'). If no tag specified, defaults to 'latest'"),
    name: z
      .string()
      .optional()
      .describe("Remote 镜像名称. Defaults to the image name part. Final path: inspire-studio/{name}"),
    tag: z.string().optional().describe("Remote 版本号. Defaults to the image tag part"),
    registry: z
      .enum(["qb", "sj"])
      .optional()
      .describe("Target registry: 'qb' (七宝, default, most spaces) or 'sj' (松江, SJ资源空间 only)"),
    description: z
      .string()
      .optional()
      .describe(
        "Repository description (e.g. 'PyTorch 2.9 + CUDA 12.8 + DeepSpeed'). Set on first push to help identify the image later",
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

      const result = await InspireHarbor.pushImage({
        localImage: params.image,
        remoteName,
        remoteTag,
        target: params.registry,
      })

      let descriptionSet = false
      if (params.description) {
        try {
          await InspireHarbor.setDescription(remoteName, params.description)
          descriptionSet = true
        } catch {}
      }

      const lines = ["=== 镜像推送成功 ===", "", `完整地址: ${result.fullPath}`]
      if (result.digest) lines.push(`Digest: ${result.digest}`)
      if (params.description && descriptionSet) lines.push(`描述: ${params.description}`)
      if (params.description && !descriptionSet) lines.push("⚠ 描述设置失败（权限不足），推送本身已成功")
      lines.push(
        "",
        "下一步:",
        "  1. 在平台「镜像管理 → 新建镜像」中注册该镜像（填写仓库名和Tag）",
        "  2. 注册后即可在 inspire_submit 中使用:",
        `     inspire_submit(image="${result.fullPath}", ...)`,
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
      if (msg.includes("not installed") || msg.includes("not in PATH")) {
        return {
          title: "Docker 未安装",
          output: "Docker 未安装或未运行。请先安装 Docker 并启动 Docker daemon。",
          metadata: { error: "docker_not_installed" },
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

      throw err
    }
  },
})
