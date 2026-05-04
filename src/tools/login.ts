import z from "zod"
import { tool } from "@ericsanchezok/synergy-plugin"
import { InspireAuth } from "../auth"
import { InspireTypes } from "../types"

const DESCRIPTION = `Authenticate with the SII 启智平台 or Harbor container registry.

Two authentication targets:
- inspire: Your 启智平台 account (学工号 + password). Required for GPU/HPC task submission, job monitoring, and most platform operations.
- harbor: Your Harbor container registry credentials. Required for pushing Docker images. These are NOT the same as your 启智平台 account — find them at 启智平台「镜像管理 → 本地推送」.

This tool saves credentials and validates the connection. If validation fails (e.g. no VPN), credentials are still saved and will work once network access is restored.

Typical flow:
1. User provides their 启智平台 学工号 and password → call inspire_login(target="inspire", username="...", password="...")
2. When pushing images, user provides Harbor credentials → call inspire_login(target="harbor", username="...", password="...", registry="qb")
3. After login, other inspire_* tools will authenticate automatically using the saved credentials.`

export const inspireLogin = tool({
  description: DESCRIPTION,
  args: {
    target: z
      .enum(["inspire", "harbor"])
      .describe("Authentication target: 'inspire' for 启智平台 account (学工号), 'harbor' for container registry"),
    username: z.string().describe("Username (学工号 for inspire, robot$inspire-studio+user-... for harbor)"),
    password: z.string().describe("Password"),
    registry: z
      .enum(["qb", "sj"])
      .optional()
      .describe("Harbor registry target: 'qb' for 七宝 (default), 'sj' for 松江. Only used when target='harbor'."),
  },
  async execute(params): Promise<InspireTypes.ToolResult> {
    if (params.target === "inspire") {
      // IMPORTANT: validate the new credentials BEFORE persisting them.
      // Previously we saved first, then called requireToken() — but
      // requireToken() reads cached tokens first, so a valid cached
      // token would make login report success even when the new
      // password was wrong. That caused the new (possibly wrong)
      // password to silently overwrite the stored password, breaking
      // all subsequent inspire_* calls once the cache eventually expired.
      try {
        await InspireAuth.loginWithFreshCredentials(params.username, params.password)
      } catch (err: any) {
        // Do NOT save credentials on failure — keep existing stored
        // credentials intact so the user isn't locked out by a typo.
        const reason = err?.reason ?? "unknown"
        if (reason === "credentials_invalid") {
          return {
            title: "认证失败",
            output: "❌ 用户名或密码错误，请确认学工号和密码后重试。已保存的凭证未被修改。",
            metadata: { target: "inspire", status: "invalid_credentials" },
          }
        }
        // Network / VPN / platform down — save credentials anyway so
        // they can be used when connectivity returns.
        await InspireAuth.saveInspireCredentials(params.username, params.password)
        return {
          title: "凭证已保存",
          output: [
            "⚠️ 凭证已保存，但连接验证失败。",
            "常见原因：不在校园网或未连接 VPN。",
            "凭证将在网络恢复后自动生效。",
          ].join("\n"),
          metadata: { target: "inspire", status: "saved_unverified" },
        }
      }

      // Validation passed → persist credentials.
      await InspireAuth.saveInspireCredentials(params.username, params.password)
      return {
        title: "认证成功",
        output: "✅ 启智平台认证成功，凭证已保存。后续 inspire_* 工具将自动使用此认证。",
        metadata: { target: "inspire", status: "ok" },
      }
    }

    // Harbor login
    const harborTarget: InspireTypes.HarborTarget = params.registry === "sj" ? "sj" : "qb"
    await InspireAuth.saveHarborCredentials(params.username, params.password, harborTarget)

    const ok = await InspireAuth.testHarborConnection(harborTarget)
    const registryName = harborTarget === "sj" ? "docker-t.sii.edu.cn (松江)" : "docker-qb.sii.edu.cn (七宝)"

    if (ok) {
      return {
        title: "认证成功",
        output: `✅ Harbor 认证成功 (${registryName})，凭证已保存。`,
        metadata: { target: "harbor", registry: harborTarget, status: "ok" },
      }
    }

    return {
      title: "凭证已保存",
      output: [
        `⚠️ Harbor 凭证已保存 (${registryName})，但连接验证失败。`,
        "常见原因：不在校园网或未连接 VPN。",
        "凭证将在网络恢复后自动生效。",
      ].join("\n"),
      metadata: { target: "harbor", registry: harborTarget, status: "saved_unverified" },
    }
  },
})
