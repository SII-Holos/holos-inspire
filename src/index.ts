import type { Plugin } from "@ericsanchezok/synergy-plugin"
import { initContext } from "./ctx"
import SKILL_CONTENT from "../skills/sii-inspire/content.txt"
import PLATFORM_GUIDE from "../skills/sii-inspire/references/platform-guide.txt"
import TROUBLESHOOTING from "../skills/sii-inspire/references/troubleshooting.txt"
import DISTRIBUTED_TRAINING from "../skills/sii-inspire/references/distributed-training.txt"

import { inspireConfig } from "./tools/config"
import { inspireStatus } from "./tools/status"
import { inspireSubmit } from "./tools/submit"
import { inspireSubmitHpc } from "./tools/submit-hpc"
import { inspireInference } from "./tools/inference"
import { inspireJobs } from "./tools/jobs"
import { inspireJobDetail } from "./tools/job-detail"
import { inspireLogs } from "./tools/logs"
import { inspireMetrics } from "./tools/metrics"
import { inspireStop } from "./tools/stop"
import { inspireImages } from "./tools/images"
import { inspireImagePush } from "./tools/image-push"
import { inspireNotebook } from "./tools/notebook"
import { inspireModels } from "./tools/models"

export const InspirePlugin: Plugin = {
  id: "inspire",
  name: "SII Inspire Platform",

  async init(input) {
    initContext(input.config, input.auth, input.cache)

    return {
      tool: {
        inspire_config: inspireConfig,
        inspire_status: inspireStatus,
        inspire_submit: inspireSubmit,
        inspire_submit_hpc: inspireSubmitHpc,
        inspire_inference: inspireInference,
        inspire_jobs: inspireJobs,
        inspire_job_detail: inspireJobDetail,
        inspire_logs: inspireLogs,
        inspire_metrics: inspireMetrics,
        inspire_stop: inspireStop,
        inspire_images: inspireImages,
        inspire_image_push: inspireImagePush,
        inspire_notebook: inspireNotebook,
        inspire_models: inspireModels,
      },

      skills: [
        {
          name: "sii-inspire",
          description:
            "SII 启智平台 GPU cluster tools for autonomous research. Covers: task submission (GPU/HPC), image management (Harbor), resource monitoring, and platform troubleshooting. Triggers: '启智', 'inspire', 'submit job', 'GPU training', '提交任务', '训练任务', 'docker image', '镜像', 'HPC', 'check GPU', '查看资源'.",
          content: SKILL_CONTENT,
          references: {
            "references/platform-guide.txt": PLATFORM_GUIDE,
            "references/troubleshooting.txt": TROUBLESHOOTING,
            "references/distributed-training.txt": DISTRIBUTED_TRAINING,
          },
        },
      ],

      cli: {
        login: {
          description: "Login to Inspire platform",
          options: {
            username: { type: "string", description: "学工号" },
            password: { type: "string", description: "密码" },
          },
          async execute(args) {
            const { InspireAuth } = await import("./auth")
            await InspireAuth.saveInspireCredentials(args.username, args.password)
            const ok = await InspireAuth.testInspireConnection()
            return ok
              ? "✅ 启智平台认证成功"
              : "⚠️ 凭证已保存，但连接验证失败（可能需要 VPN 或校园网环境）"
          },
        },
        "harbor-login": {
          description: "Login to Harbor registry",
          options: {
            username: { type: "string", description: "Harbor username" },
            password: { type: "string", description: "Harbor password" },
          },
          async execute(args) {
            const { InspireAuth } = await import("./auth")
            await InspireAuth.saveHarborCredentials(args.username, args.password)
            const ok = await InspireAuth.testHarborConnection()
            return ok
              ? "✅ Harbor 镜像仓库认证成功 (docker-qb.sii.edu.cn)"
              : "⚠️ 凭证已保存，但连接验证失败（可能需要 VPN 或校园网环境）"
          },
        },
      },

      async dispose() {
      },
    }
  },
}

export default InspirePlugin
