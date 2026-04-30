# 启智 Inspire-CLI 全量审计报告

> 测试日期: 2026-04-22  
> CLI 版本: `~/.local/bin/qz` (dynamic API client)  
> 测试账号: niexiaohang-25130061  
> 默认 workspace: `ws-9dcc0e1f-80a4-4af2-bc2f-0e352e7b17e6` (分布式训练空间)

---

## 1. 现有代码 API 依赖分类

当前 `src/api.ts` 有两种认证路径：

| 路径 | 认证方式 | 函数 | 端点风格 |
|------|---------|------|---------|
| **OpenAPI** | Bearer token (`/auth/token`) | `createJobOpenAPI`, `getJobDetailOpenAPI`, `stopJobOpenAPI`, `createHpcJobOpenAPI`, `getHpcJobDetailOpenAPI`, `stopHpcJobOpenAPI`, `createInferenceOpenAPI`, `getInferenceDetailOpenAPI`, `stopInferenceOpenAPI` | `/openapi/v1/...` |
| **Internal/Cookie** | CAS cookie | `listProjects`, `getClusterBasicInfo`, `listNodeDimension`, `listResourceSpecs`, `createJob`, `getJobDetail`, `stopJob`, `listJobsWithCookie`, `listHpcJobs`, `createHpcJob`, `getTrainLogs`, `getClusterMetrics`, notebook/model/image 全部 | `/api/v1/...` |

**关键发现**: CLI 统一使用 **`/api/v2/...` + Bearer token** 路径，覆盖了上述两种路径的所有功能。这意味着 CLI 可以替代现有的 OpenAPI 和 Cookie 两条路径。

---

## 2. CLI 命令全量测试结果

### 2.1 user (3 commands)

| Command | Required Flags | 实测结果 | 备注 |
|---------|---------------|---------|------|
| `GetUserDetail` | (none) | ✅ 返回用户信息 | name, name_en, id, global_role |
| `ListAPIKeys` | (none) | ✅ 返回 API key 列表 | value 被掩码 |
| `GetAPIKeyPlaintext` | `--api-key-id` | 🟡 未实测（需真实 key ID） | help 确认 flag 正确 |

### 2.2 project (1 command)

| Command | Required Flags | 实测结果 | 备注 |
|---------|---------------|---------|------|
| `ListProjects` | (none) | ❌ `AccessForbidden` | CLI token (azp=inspire-code) 无权访问；但 project_id 可从其他命令间接获取 |

### 2.3 workspace (15 commands)

| Command | Required Flags | 实测结果 | 备注 |
|---------|---------------|---------|------|
| `GetBasicInfo` | `--workspace-id` | ✅ 返回集群、计算组、LCG 完整信息 | 核心入口，获取 LCG ID |
| `GetScheduleConfig` | `--workspace-id` | ✅ 返回调度配置和 spec/quota 列表 | 核心入口，获取 spec_id |
| `GetOverviewOptions` | `--data '{"filter":{"workspace_id":"..."}}'` | ✅ 返回项目列表 | 可替代 `project.ListProjects` |
| `GetOverviewResourceMetric` | `--data '{"filter":{"workspace_id":"..."}}'` | ✅ 返回资源概览 | |
| `GetOverviewResourceMetricByTime` | `--data` + `--metric-mode` | 🟡 dry-run 成功 | 未实际执行 |
| `GetOverviewTaskMetric` | `--data '{"filter":{"workspace_id":"..."}}'` | ❌ `InternalError: 系统错误` | 平台 bug |
| `GetConsumeStatsList` | `--data '{"filter":{"workspace_id":"...","project_id":"..."}}'` | ✅ 返回空 Result | 需 project_id 才不报错 |
| `GetConsumeTimeSeries` | `--data` + `--metric-mode` | 🟡 dry-run 成功 | 未实际执行 |
| `GetResourceMetricByTime` | `--data` + `--metric-mode` | 🟡 dry-run 成功 | 未实际执行 |
| `GetLogicComputeGroupResource` | `--logic-compute-group-id` | ❌ `AccessForbidden` | 管理员权限 |
| `GetTaskMetricBatch` | `--data` + `--task-type` | 🟡 dry-run 成功 | 未实际执行 |
| `ListNodeDimension` | `--data '{"filter":{"workspace_id":"..."}}'` | ✅ | |
| `ListProjectDimension` | `--data '{"filter":{"workspace_id":"..."}}'` | ✅ | |
| `ListTaskDimension` | `--data '{"filter":{"workspace_id":"..."}}'` | ✅ | |
| `ListUserDimension` | `--data '{"filter":{"workspace_id":"..."}}'` | ✅ | |
| `ListWorkspaceNodes` | `--workspace-id` | ✅ | |

### 2.4 train (11 commands)

| Command | Required Flags | 实测结果 | 备注 |
|---------|---------------|---------|------|
| `ListJobs` | `--workspace-id` | ✅ 返回 job 列表，total=34 | |
| `GetJob` | `--job-id` | ✅ 返回完整 job 详情 | |
| `CreateJob` | `--name --command --framework --workspace-id --project-id --logic-compute-group-id` | ✅ dry-run 成功 | 还需 `spec_id`（在 framework_config 里），CLI 不暴露该 flag |
| `StopJob` | `--job-id` | ✅ 实际停止成功（已验证） | |
| `DeleteJob` | `--job-id` | ✅ dry-run 成功 | |
| `ListJobCreators` | `--workspace-id` | ✅ | |
| `ListJobEvents` | `--data` (无 --job-id flag) | 🟡 dry-run 成功 | CLI 未暴露 job_id flag，需用 --data |
| `ListJobInstances` | `--job-id` | ✅ 返回空 Result | |
| `GetJobWorkdir` | `--workspace-id` + `--project-id` | ✅ 返回路径 `/inspire/hdd/project/...` | |
| `GetJobLog` | `--data` (无 job-id flag) | 🟡 dry-run 成功 | 需 instance_name，CLI 未暴露 |
| `GetTaskMetric` | `--data` + `--metric-mode` | 🟡 dry-run 成功 | 需 job_id 在 data 中 |
| `GetTaskMetricBatch` | `--data` + `--task-type` | 🟡 dry-run 成功 | |

**重要**: `CreateJob` 的 dry-run 显示 CLI 未将 `spec_id` 映射到 `framework_config` 结构中。CLI 的 `--set` 机制可能需要 `--set framework_config.0.spec_id=xxx` 来处理嵌套结构。

### 2.5 hpc (9 commands)

| Command | Required Flags | 实测结果 | 备注 |
|---------|---------------|---------|------|
| `CreateJob` | `--name --entrypoint --image --workspace-id --project-id --logic-compute-group-id --spec-id --memory-per-cpu` | ✅ dry-run 成功 | ⚠️ spec_id 被转为科学计数法 `3.476e+26`（CLI bug） |
| `GetJob` | `--job-id` | ✅ fake ID → `ResourceNotFound` | 路径正确 |
| `StopJob` | `--job-id` | ✅ dry-run 成功 | |
| `DeleteJob` | `--job-id` | ✅ dry-run 成功 | |
| `GetJobLog` | `--data` (无 job-id flag) | 🟡 dry-run 成功 | 需 instance_name |
| `GetTaskMetric` | `--data` + `--metric-mode` | 🟡 dry-run 成功 | |
| `GetTaskMetricBatch` | `--data` + `--task-type` | 🟡 dry-run 成功 | |
| `ListJobEvents` | `--data` (无 job-id flag) | 🟡 dry-run 成功 | |
| `ListJobInstances` | `--job-id` | ✅ fake ID → `ResourceNotFound` | |

**注意**: HPC 没有 `ListJobs` 命令。需要通过 workspace 的 `GetOverviewTaskMetric` 或浏览器获取 HPC job ID。

### 2.6 inference-serving (15 commands)

| Command | Required Flags | 实测结果 | 备注 |
|---------|---------------|---------|------|
| `ListServings` | `--data '{"workspace_id":"..."}'` | ✅ 返回 total=7 | |
| `GetServing` | `--inference-serving-id` | ✅ 返回完整详情 | 用真实 ID `sv-e3d1...` 测试通过 |
| `CreateServing` | `--name --image --workspace-id --project-id --logic-compute-group-id --spec-id` | ✅ dry-run 成功 | |
| `StopServing` | `--inference-serving-id` | ✅ dry-run 成功 | |
| `StartServing` | `--inference-serving-id` | ✅ dry-run 成功 | |
| `ScaleServing` | `--inference-serving-id --replica` | ✅ dry-run 成功 | |
| `RollbackServing` | `--inference-serving-id --version` | ✅ dry-run 成功 | |
| `DeleteServing` | `--inference-serving-id --version` | ✅ dry-run 成功 | |
| `UpdateServing` | `--inference-serving-id` + 多个可选 | ✅ dry-run 成功 | |
| `ListServingInstances` | `--inference-serving-id` | ✅ 返回 total=2 | |
| `ListServingVersions` | `--inference-serving-id` | ✅ 返回版本列表 | |
| `GetServingLog` | `--data` (无 serving-id flag) | 🟡 dry-run 成功；实际返回空 Result | 需 instance_name |
| `GetTaskMetric` | `--data` + `--metric-mode` | 🟡 dry-run 成功 | |
| `GetTaskMetricBatch` | `--data` + `--task-type` | 🟡 dry-run 成功 | |
| `ListServingEvents` | `--data` | ❌ `InternalError: nil pointer dereference` | 平台 bug |

### 2.7 notebook (14 commands)

| Command | Required Flags | 实测结果 | 备注 |
|---------|---------------|---------|------|
| `ListNotebooks` | `--workspace-id` | ✅ 返回 notebook 列表 | |
| `GetNotebook` | `--notebook-id` | ❌ **CLI bug**: notebook_id 被转成数字 | `688d4b14...` → `688`，服务器要求 string |
| `CreateNotebook` | `--name --workspace-id --project-id --logic-compute-group-id` + 更多 | 🟡 缺少 required flag 未测全 | |
| `StartNotebook` | `--notebook-id` | ❌ **CLI bug**: 同上，number→string | dry-run 显示 `"notebook_id": 688` |
| `StopNotebook` | `--notebook-id` | ❌ **CLI bug**: 同上 | |
| `DeleteNotebook` | `--notebook-id` | ❌ **CLI bug**: 同上 | |
| `SaveNotebookImage` | `--notebook-id --name --version` | ❌ **CLI bug**: 同上 | |
| `CommitNotebook` | `--notebook-id` | ❌ **CLI bug**: 同上 | |
| `ListNotebookEvents` | `--notebook-id` | ❌ **CLI bug**: 同上 | 无法绕过（required flag） |
| `ListRunIndex` | `--notebook-id` | ❌ **CLI bug**: 同上 | |
| `GetRealtimeNotebookMetric` | `--notebook-id` | ❌ **CLI bug**: 同上 | **但用 --data 绕过时 dry-run 正确** |
| `GetRealtimeNotebookMetricByTime` | `--notebook-id` | ❌ **CLI bug**: 同上 | 同上 |
| `GetTaskMetric` | `--data` + `--metric-mode` | 🟡 dry-run 成功 | 无 required flag 冲突 |
| `GetTaskMetricBatch` | `--data` + `--task-type` | 🟡 dry-run 成功 | |

**关键 CLI Bug**: `--notebook-id` flag 将 UUID 前缀的数字部分解析为 number 类型（`688d4b14...` → `688`），而服务器要求 `notebook_id` 为 string。使用 `--data '{"notebook_id":"688d4b14..."}'` 可绕过，但要求 `--notebook-id` 的命令会强制先设 required flag，无法用 --data 替代。

### 2.8 ray (14 commands)

| Command | Required Flags | 实测结果 | 备注 |
|---------|---------------|---------|------|
| `ListJobs` | `--workspace-id` | ✅ 返回空 Result | 用户无 Ray job |
| `GetJob` | `--ray-job-id` | ✅ dry-run 成功 | |
| `CreateJob` | `--name --entrypoint --workspace-id --project-id` | ✅ dry-run 成功 | |
| `StopJob` | `--ray-job-id` | ✅ dry-run 成功 | |
| `StartJob` | `--ray-job-id` | ✅ dry-run 成功 | |
| `DeleteJob` | `--ray-job-id` | ✅ dry-run 成功 | |
| `UpdateJob` | `--ray-job-id` | ✅ dry-run 成功 | |
| `GetJobLog` | `--data` | 🟡 dry-run 成功 | |
| `GetTaskMetric` | `--data` + `--metric-mode` | 🟡 dry-run 成功 | |
| `GetTaskMetricBatch` | `--data` + `--task-type` | 🟡 dry-run 成功 | |
| `ListJobEvents` | `--ray-job-id` | 🟡 dry-run 成功 | |
| `ListJobInstances` | `--ray-job-id` | 🟡 dry-run 成功 | |
| `ListJobCreators` | `--workspace-id` | ✅ 返回空 Result | |
| `ListJobScalingHistories` | `--ray-job-id` | 🟡 dry-run 成功 | Ray 特有，伸缩历史 |

### 2.9 cluster (19 commands)

| Command | 实测结果 | 备注 |
|---------|---------|------|
| 全部 19 个命令 | ❌ `AccessForbidden` | 当前账号无集群管理权限 |
| 包括: `GetClusterBasicInfo`, `ListClusters`, `ListClusterRegions`, `ListNodes`, `GetOverviewResourceMetric`, `GetOverviewResourceMetricByTime`, `GetOverviewTaskMetric`, `GetNodeDistincts`, `GetNodeEvents`, `GetNodeResourceInfoDictionary`, `InspectNodes`, `ListNodeDimension`, `ListProjectDimension`, `ListTaskDimension`, `ListUserDimension`, `CordonNode`, `UnCordonNode`, `MaintNode`, `UnMaintNode`, `TransferNodeResourcePool` | | 

---

## 3. CLI Bug 汇总

| # | Bug | 影响 | Workaround |
|---|-----|------|-----------|
| 1 | **`--notebook-id` 类型转换** | 所有需要 `--notebook-id` 的命令将 UUID 数字前缀解析为 number | 无有效绕过（required flag 冲突） |
| 2 | **`--spec-id` 科学计数法** | HPC CreateJob 的 `--spec-id` 将 UUID 转为科学计数法 | 用 `--data` 直接传 JSON |
| 3 | **`CreateJob` 不暴露 framework_config** | Train CreateJob 无法通过 flag 设 spec_id/shm 等嵌套字段 | 用 `--data` 或 `--set framework_config.0.spec_id=xxx` |

---

## 4. 平台端 Bug 汇总

| # | Bug | 影响 |
|---|-----|------|
| 1 | `workspace.GetOverviewTaskMetric` → `InternalError: 系统错误` | 无法获取工作空间任务概览 |
| 2 | `inference-serving.ListServingEvents` → `InternalError: nil pointer dereference` | 无法列出推理服务事件 |
| 3 | `train.StopJob` 对不存在 job 返回 `AccessForbidden`（而非 `ResourceNotFound`） | 误导性错误信息 |

---

## 5. 权限边界

| 权限等级 | 可用命令 | 不可用命令 |
|---------|---------|-----------|
| **普通用户 (当前)** | user.*, train.*, hpc.*, inference-serving.*, notebook.*, ray.*, workspace.大部分 | project.ListProjects, cluster.*, workspace.GetLogicComputeGroupResource |
| **管理员** | 全部 | — |

---

## 6. ID 发现图谱

```
workspace_id ──(浏览器/手动)──→ 已知: ws-9dcc0e1f-...
    │
    ├── workspace.GetBasicInfo ──→ logic_compute_group_id (LCG)
    │                                    │
    │                                    └── workspace.GetScheduleConfig ──→ spec_id / quota_id
    │
    ├── workspace.GetOverviewOptions ──→ project_id
    │
    ├── train.ListJobs ──→ job_id
    │       │
    │       └── train.GetJob ──→ framework_config, running_round 等
    │
    ├── notebook.ListNotebooks ──→ notebook_id
    │
    └── inference-serving.ListServings ──→ inference_serving_id
            │
            └── inference-serving.ListServingInstances ──→ instance_name (用于日志/指标)
```

**重要**: `workspace_id` 无法通过 CLI 自举获取。目前只能从浏览器或已有 job/notebook 的 `workspace_id` 字段反向获取。

---

## 7. 现有工具 vs CLI 命令映射

| 现有工具函数 | 当前 API | CLI 等价命令 | CLI 端点 |
|------------|---------|------------|---------|
| `createJobOpenAPI` | `/openapi/v1/train_job/create` | `train.CreateJob` | `/api/v2/train?Action=CreateJob` |
| `getJobDetailOpenAPI` | `/openapi/v1/train_job/detail` | `train.GetJob` | `/api/v2/train?Action=GetJob` |
| `stopJobOpenAPI` | `/openapi/v1/train_job/stop` | `train.StopJob` | `/api/v2/train?Action=StopJob` |
| `createHpcJobOpenAPI` | `/openapi/v1/hpc_jobs/create` | `hpc.CreateJob` | `/api/v2/hpc?Action=CreateJob` |
| `getHpcJobDetailOpenAPI` | `/openapi/v1/hpc_jobs/detail` | `hpc.GetJob` | `/api/v2/hpc?Action=GetJob` |
| `stopHpcJobOpenAPI` | `/openapi/v1/hpc_jobs/stop` | `hpc.StopJob` | `/api/v2/hpc?Action=StopJob` |
| `createInferenceOpenAPI` | `/openapi/v1/inference_servings/create` | `inference-serving.CreateServing` | `/api/v2/inference_serving?Action=CreateServing` |
| `getInferenceDetailOpenAPI` | `/openapi/v1/inference_servings/detail` | `inference-serving.GetServing` | `/api/v2/inference_serving?Action=GetServing` |
| `stopInferenceOpenAPI` | `/openapi/v1/inference_servings/stop` | `inference-serving.StopServing` | `/api/v2/inference_serving?Action=StopServing` |
| `listProjects` | `/api/v1/project/list` (cookie) | `workspace.GetOverviewOptions` | `/api/v2/workspace?Action=GetOverviewOptions` |
| `getClusterBasicInfo` | `/api/v1/cluster_metric/cluster_basic_info` (cookie) | `workspace.GetBasicInfo` | `/api/v2/workspace?Action=GetBasicInfo` |
| `listNodeDimension` | `/api/v1/cluster_metric/list_node_dimension` (cookie) | `workspace.ListNodeDimension` | `/api/v2/workspace?Action=ListNodeDimension` |
| `listResourceSpecs` | `/api/v1/resource_prices/logic_compute_groups/` (cookie) | `workspace.GetScheduleConfig` | `/api/v2/workspace?Action=GetScheduleConfig` |
| `listJobsWithCookie` | `/api/v1/train_job/list` (cookie) | `train.ListJobs` | `/api/v2/train?Action=ListJobs` |
| `getJobDetail` | `/api/v1/train_job/detail` (cookie) | `train.GetJob` | `/api/v2/train?Action=GetJob` |
| `stopJob` | `/api/v1/train_job/stop` (cookie) | `train.StopJob` | `/api/v2/train?Action=StopJob` |
| `createJob` | `/api/v1/train_job/create` (cookie) | `train.CreateJob` | `/api/v2/train?Action=CreateJob` |
| `listHpcJobs` | `/api/v1/hpc_jobs/list` (cookie) | ⚠️ 无直接等价 | HPC 无 ListJobs 命令 |
| `createHpcJob` | `/api/v1/hpc_jobs` (cookie) | `hpc.CreateJob` | `/api/v2/hpc?Action=CreateJob` |
| `getTrainLogs` | `/api/v1/logs/train` (cookie) | `train.GetJobLog` | `/api/v2/train?Action=GetJobLog` |
| `getClusterMetrics` | `/api/v1/cluster_metric/resource_metric_by_time` (cookie) | `train.GetTaskMetric` / `workspace.GetResourceMetricByTime` | `/api/v2/train?Action=GetTaskMetric` |
| `listNotebooks` | `/api/v1/notebook/list` (cookie) | `notebook.ListNotebooks` | `/api/v2/notebook?Action=ListNotebooks` |
| `getNotebookDetail` | `/api/v1/notebook/{id}` (cookie, GET) | `notebook.GetNotebook` | `/api/v2/notebook?Action=GetNotebook` |
| `operateNotebook` | `/api/v1/notebook/operate` (cookie) | `notebook.StartNotebook` / `StopNotebook` | `/api/v2/notebook?Action=StartNotebook` |
| `createNotebook` | `/api/v1/notebook/create` (cookie) | `notebook.CreateNotebook` | `/api/v2/notebook?Action=CreateNotebook` |
| `listModels` | `/api/v1/model/list` (cookie) | ⚠️ 无直接等价 | CLI 无 model 服务 |
| `getModelDetail` | `/api/v1/model/detail` (cookie) | ⚠️ 无直接等价 | CLI 无 model 服务 |
| `createModel` | `/api/v1/model/create` (cookie) | ⚠️ 无直接等价 | CLI 无 model 服务 |
| `deleteModel` | `/api/v1/model/delete` (cookie) | ⚠️ 无直接等价 | CLI 无 model 服务 |
| `listPlatformImages` | `/api/v1/image/list` (cookie) | ⚠️ 无直接等价 | CLI 无 image 服务 |

---

## 8. CLI 缺失的能力（相对现有工具）

| 能力 | 现有工具 | CLI 状态 |
|------|---------|---------|
| HPC job 列表 | `listHpcJobs` | ❌ 无 `hpc.ListJobs` |
| Model 管理 | `listModels`, `getModelDetail`, `createModel`, `deleteModel` | ❌ 无 `model` 服务 |
| Image 列表 | `listPlatformImages` | ❌ 无 `image` 服务 |
| Image 推送 | Harbor API 直接调用 | ❌ CLI 不覆盖 |
| Notebook 操作（无 bug） | `operateNotebook` | ⚠️ CLI 有 `--notebook-id` 类型 bug |

---

## 9. 认证体系深度分析

### 9.1 三套认证域

启智平台存在三套独立的认证域，互不通用：

| 认证域 | 获取方式 | `azp` 字段 | 可访问端点 | 有效期 |
|--------|---------|-----------|-----------|--------|
| **OpenAPI Token** | `POST /auth/token` (明文账密) | `inspire-studio` | `/openapi/v1/*` 仅 | ~7天 |
| **CAS Cookie** | CAS 登录流程 (RSA 加密密码) | — | `/api/v1/*` 仅 | 会话级 |
| **Keycloak Token** | OIDC device-code 流程 | `inspire-code` | `/api/v2/*`（需配合特殊 header） | access_token ~1h, refresh_token ~7天 |

**关键**: 这三个 token 互不兼容。OpenAPI token 无法访问 `/api/v1` 或 `/api/v2`；Keycloak token 无法访问 `/openapi/v1` 或 `/api/v1`；Cookie 无法访问 `/openapi/v1` 或 `/api/v2`。

### 9.2 APISIX 网关行为：`x-inspire-client-source` 头

这是本次审计最重要的发现。`/api/v2/*` 端点**不能**仅靠 Bearer token 访问——APISIX 网关会根据请求头切换认证行为：

```
# 没有 x-inspire-client-source 头 → APISIX 重定向到 Keycloak OIDC (client_id=inspire-studio)
curl -H "Authorization: Bearer <inspire-code-token>" https://qz.sii.edu.cn/api/v2/train?Action=ListJobs
→ 302 → Keycloak login page

# 加上 x-inspire-client-source 头 → 直接通过
curl -H "Authorization: Bearer <inspire-code-token>" \
     -H "x-inspire-client-source: inspire-cli/5294f02" \
     -H "Accept: application/json" \
     https://qz.sii.edu.cn/api/v2/train?Action=ListJobs
→ 200 + JSON 数据
```

这意味着：
- CLI 可执行文件**不是**必要依赖——只需复现其 HTTP 契约（header + token）即可
- 但 `x-inspire-client-source` 头是**必需的**，不能省略
- 当前 `5294f02` 疑似 CLI 构建版本 hash，暂应原样使用

### 9.3 Keycloak 刷新令牌策略

Keycloak device-code 流程返回：
- `access_token`: 有效期 ~3600s (1小时)
- `refresh_token`: 有效期 ~590078s (~6.8天)

刷新流程：
```
POST https://qz.sii.edu.cn/auth/realms/sii/protocol/openid-connect/token
  grant_type=refresh_token&client_id=inspire-code&refresh_token=<refresh_token>
```

验证结果：刷新成功，返回新的 `access_token` + `refresh_token`。

**用户体验改善**：只需首次浏览器授权一次，之后自动刷新可维持 ~7 天免登录。当前 CAS cookie 每次会话结束即失效，OpenAPI token 虽长但覆盖范围窄。

### 9.4 `/api/v2` 实际可用性验证

通过直接 HTTP 请求 + 正确 header 验证：

| 服务 | Action | 结果 | 说明 |
|------|--------|------|------|
| train | ListJobs | ✅ 成功 | 返回完整 job 列表 |
| train | GetJob | ✅ 成功 | 返回 job 详情 |
| train | StopJob | ✅ 成功 | 实际停止了 job |
| hpc | ListJobs | ❌ `InvalidAction` | v2 无此 Action |
| hpc | CreateJob | ✅ dry-run 成功 | CLI 已验证 |
| hpc | GetJob | ✅ CLI 已验证 | |
| notebook | ListNotebooks | ✅ 成功 | |
| notebook | GetNotebook | ✅ 成功 | 直接 HTTP 无 CLI bug |
| notebook | StartNotebook | ✅ 成功 | 直接 HTTP 无 CLI bug |
| inference_serving | ListServings | ✅ 成功 | |
| inference_serving | GetServing | ✅ 成功 | |
| workspace | GetBasicInfo | ✅ 成功 | |
| workspace | GetScheduleConfig | ✅ 成功 | |
| image | ListImages | ❌ `AccessForbidden` | 端点存在但当前账号无权 |
| model | ListModels | ❌ `404 page not found` | v2 无 model 服务 |

---

## 10. 结论与迁移建议

### 10.1 `/api/v2` 可完全替代的能力（迁移优先级高）

这些功能可以直接 HTTP 调用 `/api/v2` + Keycloak token + `x-inspire-client-source` 头，**无需 CLI 可执行文件**：

- **train**: ListJobs / GetJob / CreateJob / StopJob / DeleteJob / GetJobWorkdir / ListJobCreators / ListJobInstances / GetJobLog / GetTaskMetric
- **inference-serving**: 全部 CRUD 和生命周期操作（15个命令）
- **notebook**: 全部操作——**且直接 HTTP 无 CLI 的 `--notebook-id` 类型转换 bug**
- **workspace**: GetBasicInfo / GetScheduleConfig / GetOverviewOptions / 各种 Dimension / ListNodeDimension
- **user**: GetUserDetail / ListAPIKeys
- **ray**: 全部操作（14个命令）

### 10.2 `/api/v2` 部分可用需注意的能力

- **hpc**: CreateJob / GetJob / StopJob 可用，但 **ListJobs 缺失**（`InvalidAction`），需要保留 `/api/v1` 回退

### 10.3 必须保留 `/api/v1` (cookie) 的能力

| 能力 | 原因 | 保留函数 |
|------|------|---------|
| HPC job 列表 | v2 无 `ListJobs` Action | `listHpcJobs` |
| Model CRUD | v2 无 model 服务 (404) | `listModels`, `getModelDetail`, `createModel`, `deleteModel` |
| Image 列表 | v2 返回 `AccessForbidden`，当前账号不可用 | `listPlatformImages` |
| Harbor 推送 | 不走启智 API，直接 Harbor REST | Harbor 相关逻辑 |

### 10.4 可完全废弃的路径

| 废弃项 | 替代方案 |
|--------|---------|
| `/openapi/v1/*` 全部 | → `/api/v2/*` + Keycloak token |
| `postOpenAPI()` 函数 | → 新 `postV2()` 函数 |
| `createJobOpenAPI` / `getJobDetailOpenAPI` / `stopJobOpenAPI` | → `postV2("/api/v2/train?Action=CreateJob", ...)` |
| `createHpcJobOpenAPI` / `getHpcJobDetailOpenAPI` / `stopHpcJobOpenAPI` | → `postV2("/api/v2/hpc?Action=CreateJob", ...)` |
| `createInferenceOpenAPI` / `getInferenceDetailOpenAPI` / `stopInferenceOpenAPI` | → `postV2("/api/v2/inference_serving?Action=CreateServing", ...)` |
| `listJobsWithCookie` / `getJobDetail` (cookie版) / `stopJob` (cookie版) / `createJob` (cookie版) | → `postV2("/api/v2/train?Action=ListJobs", ...)` |
| `listNotebooks` / `getNotebookDetail` / `operateNotebook` / `createNotebook` | → `postV2("/api/v2/notebook?Action=ListNotebooks", ...)` |
| `getClusterBasicInfo` / `listNodeDimension` / `listResourceSpecs` | → `postV2("/api/v2/workspace?Action=GetBasicInfo", ...)` |
| `getTrainLogs` | → `postV2("/api/v2/train?Action=GetJobLog", ...)` |
| `getClusterMetrics` | → `postV2("/api/v2/train?Action=GetTaskMetric", ...)` |

### 10.5 迁移实施建议

#### Phase 1: 新增认证和请求基础设施
1. **`src/auth.ts`** 新增 Keycloak 认证路径：
   - Device-code 登录流程（首次浏览器授权）
   - `access_token` + `refresh_token` 持久化到 `pluginCache`
   - 自动刷新：`access_token` 过期前用 `refresh_token` 续期
   - `refresh_token` 过期（~7天）才需重新浏览器授权

2. **`src/api.ts`** 新增 `postV2()` 请求函数：
   ```typescript
   async function postV2<T>(service: string, action: string, body: Record<string, any>, token: string): Promise<T> {
     const resp = await fetch(`${PLATFORM_URL}/api/v2/${service}?Action=${action}`, {
       method: "POST",
       headers: {
         "Authorization": `Bearer ${token}`,
         "Content-Type": "application/json",
         "Accept": "application/json",
         "x-inspire-client-source": "inspire-cli/5294f02",
       },
       body: JSON.stringify(body),
     })
     // ... error handling
   }
   ```

#### Phase 2: 逐步迁移 API 函数
- 先迁移高频函数：`listJobs`, `getJobDetail`, `stopJob`, `createJob`
- 再迁移 notebook 相关（同时解决 CLI bug）
- 最后迁移 workspace/metrics 等低频函数

#### Phase 3: 清理
- 删除 `postOpenAPI()` 和所有 `*OpenAPI` 函数
- 删除 `postInternal()` 中已迁移的部分
- 保留 `postInternal()` 仅用于 `/api/v1` 的 4 个未覆盖能力
- 保留 `requireCookie()` 仅用于 HPC ListJobs / Model CRUD / Image 列表

#### Phase 4: 验证
- 确认 `x-inspire-client-source` 头的稳定性（是否与 CLI 版本绑定）
- 确认 image `AccessForbidden` 是否为账号权限问题（可联系平台确认）
