# holos-inspire

A [Synergy](https://github.com/ericsanchezok/synergy) plugin for SII 启智平台 (`qz.sii.edu.cn`) — an academic GPU/HPC cluster for AI research.

`holos-inspire` gives the Synergy agent direct control over:
- GPU training job submission
- HPC / Slurm task submission
- Docker image management and Harbor push
- resource discovery and availability inspection
- job logs and GPU metrics
- notebook environments
- inference deployment
- platform model repository management

This is the complete usage manual.

---

## What this plugin adds

### Tools

| Tool | Purpose |
|------|---------|
| `inspire_config` | Read/write plugin defaults such as project, workspace, image, priority, shm, and command prefix |
| `inspire_login` | Save and validate Inspire platform credentials or Harbor registry credentials |
| `inspire_status` | Discover projects, workspaces, compute groups, available specs, quota context, and storage paths |
| `inspire_submit` | Submit GPU training jobs |
| `inspire_submit_hpc` | Submit HPC / CPU jobs using Slurm-style scheduling |
| `inspire_inference` | Create, inspect, and stop inference services |
| `inspire_jobs` | List tasks by type and normalized status |
| `inspire_job_detail` | Read detailed task configuration and failure diagnostics |
| `inspire_logs` | Query or download task logs |
| `inspire_metrics` | Inspect GPU / system metrics with health assessment |
| `inspire_stop` | Stop a single task or batch-stop matching tasks |
| `inspire_images` | Browse platform-registered images or raw Harbor images |
| `inspire_image_push` | Push a local Docker image to Harbor and return the platform-usable display address |
| `inspire_notebook` | Create, list, inspect, start, and stop notebooks |
| `inspire_models` | List, inspect, create, and delete model-repository entries |

### Built-in skill

The plugin also ships a built-in skill:
- `sii-inspire`

It covers:
- first-time setup
- end-to-end job workflows
- platform rules and caveats
- troubleshooting
- distributed training notes

---

## Installation

Add the plugin to your Synergy config:

```jsonc
// synergy.jsonc
{
  "plugin": ["github:SII-Holos/holos-inspire"]
}
```

Synergy installs plugins automatically on startup.

---

## Authentication

The plugin has **two independent authentication targets**.

### 1. Inspire platform account

This is your 启智平台 account:
- 学工号
- password

You need it for:
- resource discovery
- job submission
- job inspection
- logs / metrics / notebooks / inference / models

### 2. Harbor registry account

This is **not** the same as your platform account.
You get it from:
- 启智平台 → 镜像管理 → 本地推送

You need it for:
- pushing local Docker images to Harbor

There are two Harbor registries:
- `qb` — 七宝 (default, used by all spaces except SJ)
- `sj` — 松江 (used only by SJ spaces)

### Login methods

#### CLI

```bash
synergy inspire login --username <学工号> --password <密码>
synergy inspire harbor-login --username <harbor-user> --password <harbor-password>
synergy inspire harbor-login --username <harbor-user> --password <harbor-password> --registry sj
```

#### Tool

```text
inspire_login(target="inspire", username="...", password="...")
inspire_login(target="harbor", username="...", password="...", registry="qb")
inspire_login(target="harbor", username="...", password="...", registry="sj")
```

### Important behavior

Credential validation is **best effort**:
- if validation succeeds, you are ready to use the platform immediately
- if validation fails because you are off-campus / off-VPN, credentials are still saved
- once the network is restored, the saved credentials will work automatically

So a failed validation does **not** necessarily mean the credentials are wrong.

---

## First-time setup

The recommended first-time setup flow is:

### Step 1: log in

```text
inspire_login(target="inspire", username="...", password="...")
```

If you plan to push images:

```text
inspire_login(target="harbor", username="...", password="...", registry="qb")
```

### Step 2: inspect available resources

```text
inspire_status()
```

This is the **entry tool** for the whole platform.
Use it before submitting anything.

It tells you:
- which projects you belong to
- which workspaces exist in those projects
- whether a workspace has internet access
- which compute groups exist
- which specs are available for each schedule type
- project budget / priority context
- shared storage path

### Step 3: set defaults

If you repeatedly use the same project / workspace / image, set defaults:

```text
inspire_config(action="set", key="defaultProject", value="你的项目名")
inspire_config(action="set", key="defaultWorkspace", value="分布式训练空间")
inspire_config(action="set", key="defaultImage", value="docker.sii.shaipower.online/inspire-studio/your-image:tag")
inspire_config(action="set", key="defaultPriority", value="9")
inspire_config(action="set", key="defaultShm", value="65536")
inspire_config(action="set", key="commandPrefix", value="source /opt/conda/etc/profile.d/conda.sh && conda activate myenv && cd /inspire/hdd/project/{en_name}/code")
```

Then inspect current defaults with:

```text
inspire_config(action="get")
```

### Why `commandPrefix` matters

The platform runs commands in a **non-interactive shell**.
That means:
- `~/.bashrc` is not loaded
- your conda environment is not activated automatically
- your working directory is not changed automatically

So in practice you almost always want:

```bash
source /opt/conda/etc/profile.d/conda.sh && conda activate myenv && cd /inspire/hdd/project/{en_name}/code
```

Putting that into `commandPrefix` saves a lot of repeated boilerplate.

### What is intentionally NOT stored as a default

These are **not** stored as defaults:
- `spec`
- `compute_group`

Because they vary by:
- workspace
- task type
- cluster

Discover them from `inspire_status`; if you pass a missing or invalid `spec`, the submit tools will surface available options for the target space and compute group.

---

## Platform essentials

### 1. Two image domains: push domain vs display domain

This is one of the most important platform rules.

### Main registry
- push domain: `docker-qb.sii.edu.cn`
- display domain: `docker.sii.shaipower.online`
- used by: all non-SJ spaces

### SJ registry
- push domain: `docker-t.sii.edu.cn`
- display domain: `docker-t.sii.shaipower.online`
- used by: SJ spaces only

### Critical rule

After pushing, **submit jobs using the display domain**, not the push domain.

Good:
```text
docker.sii.shaipower.online/inspire-studio/my-image:v1
```

Bad:
```text
docker-qb.sii.edu.cn/inspire-studio/my-image:v1
```

The plugin already knows this and returns the correct display-domain address from `inspire_image_push`.

---

### 2. Push is not enough: platform registration is mandatory

After pushing an image to Harbor, you **must** register it on the platform:
- 启智平台 → 镜像管理 → 新建镜像
- fill:
  - 镜像名称
  - 版本号

Without registration:
- `inspire_submit` cannot use the image
- `inspire_notebook` cannot use the image

`inspire_image_push` tells you exactly what values to fill in.

---

### 3. Workspace network policy

Different workspaces have different network permissions.

### Internet-enabled spaces
These can access whitelisted external network resources:
- 可上网GPU资源
- CPU资源空间
- 国产卡
- PPU
- 专属资源开发空间
- SJ资源空间

### Offline spaces
These have **no internet**:
- 分布式训练空间
- 高性能计算
- 整节点任务空间

### Consequence

In offline spaces, your command must **not** rely on network access.
Do not do this inside job commands:
- `pip install`
- `git clone`
- `wget`
- `curl`
- online model download

All dependencies must already be in:
- the Docker image, or
- the shared project storage path

---

### 4. Shared storage

The project storage path is shared across spaces in the same project:

```text
/inspire/hdd/project/{en_name}/
```

This is important because it enables a common workflow:
1. download data or models in an online space
2. train in an offline space using the same shared path

There is also a personal global directory:

```text
/inspire/hdd/global_user/{username}/
```

Be careful: deletion on the cluster is effectively irreversible.

---

### 5. Priority and budget

### Priority
- priority `>= 4`: task will not be preempted
- priority `1-3`: task may be killed by higher-priority tasks

### Budget
- advisor projects refresh quarterly
- public research projects refresh weekly
- low-priority CPU tasks (`1-3`) do not consume project budget

That means low-priority CPU jobs are a useful fallback when your budget is exhausted.

---

### 6. Shared memory (`shm`)

For multi-GPU training, shared memory is critical.

Recommended rules:
- single-GPU: default is often enough
- multi-GPU / multi-node: use at least `65536` MB (64 GB)

A too-small `shm` often causes distributed training failures.

---

### 7. Distributed training env vars

The platform auto-injects:
- `MASTER_ADDR`
- `MASTER_PORT`
- `PET_NNODES`
- `PET_NODE_RANK`
- `PET_NPROC_PER_NODE`

Use them directly in `torchrun` / `deepspeed` commands.

---

## Core workflows

### Workflow A: submit a GPU training job

### Minimal flow

```text
inspire_status()
inspire_submit(name="exp-001", command="python train.py", compute_group="...", spec="...")
inspire_jobs(status="running")
inspire_logs(job_id="job-xxx", lines=50)
inspire_metrics(job_id="job-xxx", time_range="30m")
```

### What `inspire_submit` expects

Required in practice:
- `name`
- `command`
- `compute_group`
- `spec`

Everything else can come from defaults if configured.

### Best practice

Always capture output to a file:

```bash
python train.py 2>&1 | tee /inspire/hdd/project/{en_name}/logs/exp-001.log
```

### What happens if `spec` is missing or wrong

If `spec` is missing or invalid, the tool helps you recover by surfacing available specs for the target space / compute group.

---

### Workflow B: submit an HPC / CPU job

Use `inspire_submit_hpc` for:
- preprocessing
- evaluation
- CPU-heavy scripts
- Slurm-based workflows

Example shape:

```text
inspire_submit_hpc(
  name="preprocess",
  entrypoint="python preprocess.py",
  workspace="高性能计算",
  compute_group="高性能计算",
  spec="...",
  image="docker.sii.shaipower.online/inspire-studio/slurm-xxx:tag",
  number_of_tasks=2,
  cpus_per_task=4,
  memory_per_cpu="8G"
)
```

Important:
- HPC spaces are offline
- your image must be Slurm-compatible

---

### Workflow C: check jobs, logs, and health

### List jobs

```text
inspire_jobs(status="running")
inspire_jobs(status="failed")
inspire_jobs(type="hpc", status="all")
```

Status families are normalized into:
- `running`
- `waiting`
- `succeeded`
- `failed`
- `stopped`
- `all`

### Get details and diagnostics

```text
inspire_job_detail(job_id="job-xxx")
```

Task ID prefix determines task type automatically:
- `job-xxx` → GPU training
- `hpc-job-xxx` → HPC task
- `sv-xxx` → inference serving

### Read logs

```text
inspire_logs(job_id="job-xxx", lines=100)
inspire_logs(job_id="job-xxx", download=true)
```

### Read metrics

```text
inspire_metrics(job_id="job-xxx", time_range="30m")
inspire_metrics(job_id="job-xxx", mode="raw", time_range="1h")
inspire_metrics(job_id="job-xxx", mode="download", time_range="3h")
```

`inspire_metrics` answers the practical question—*is the job actually training, or sitting idle?*—with:
- summary stats
- health hints
- stability checks
- idle-window detection

---

### Workflow D: stop tasks

```text
inspire_stop(job_id="job-xxx")
inspire_stop(job_id="sv-xxx")
```

The tool can also batch-stop matching tasks by workspace and status filter when you need to clear a queue or stop a whole class of runs.

---

### Workflow E: browse images and push a local image

### Browse images

Platform-registered images:

```text
inspire_images(search="torch")
```

Raw Harbor images:

```text
inspire_images(source="harbor", search="torch")
inspire_images(source="harbor", repo="my-image")
```

### Push a local image

```text
inspire_image_push(image="my-train:v1")
```

Optional parameters:
- `name`
- `tag`
- `registry` (`qb` or `sj`)
- `description`

### Why use `inspire_image_push` instead of raw `docker push`

Because it:
- handles Harbor auth more cleanly
- normalizes the target path
- returns the correct display-domain image address
- tells you the exact 镜像名称 / 版本号 needed for platform registration

### Important prerequisites

Before using it, make sure:
- Docker is installed and running locally
- the machine can reach Harbor (campus network or VPN)
- Harbor credentials have been saved

---

### Workflow F: create or manage notebooks

Use `inspire_notebook` for interactive environments.

```text
inspire_notebook(action="create", name="dev-env", compute_group="...", spec="...", image="...")
inspire_notebook(action="list")
inspire_notebook(action="detail", notebook_id="...")
inspire_notebook(action="start", notebook_id="...")
inspire_notebook(action="stop", notebook_id="...")
```

Notebook specs are different from training specs.
Always get notebook specs from `inspire_status` rather than reusing a training spec ID.

---

### Workflow G: deploy inference

### First find a model

```text
inspire_models(action="list")
```

### Then create a serving

```text
inspire_inference(
  action="create",
  name="llama-serving",
  model_id="...",
  model_version=1,
  image="docker.sii.shaipower.online/inspire-studio/vllm:tag",
  command="python -m vllm.entrypoints.openai.api_server",
  port=2400,
  replicas=1,
  compute_group="...",
  spec="..."
)
```

Then inspect or stop it:

```text
inspire_inference(action="detail", serving_id="sv-xxx")
inspire_inference(action="stop", serving_id="sv-xxx")
```

---

### Workflow H: manage the model repository

```text
inspire_models(action="list")
inspire_models(action="detail", model_id="...")
inspire_models(action="create", name="...", model_source_path="...")
inspire_models(action="delete", model_id="...")
```

This is mainly useful for inference deployment, because `inspire_inference` needs `model_id` and `model_version`.

---

## Recommended end-to-end patterns

## Pattern 1: first real training run

1. `inspire_login(target="inspire", ...)`
2. `inspire_status()`
3. `inspire_config(action="set", ...)` for defaults
4. `inspire_submit(...)`
5. `inspire_jobs(status="running")`
6. `inspire_metrics(...)`
7. `inspire_logs(...)`
8. `inspire_job_detail(...)` if failure occurs

## Pattern 2: offline training with online preparation

1. use an internet-enabled workspace to download models / datasets into `/inspire/hdd/project/{en_name}/...`
2. wait until download completes
3. submit the real training in an offline workspace
4. point the training job at the shared storage path

## Pattern 3: custom image workflow

1. build a local Docker image
2. login to Harbor
3. use `inspire_image_push`
4. manually register the image on the platform
5. use the returned display-domain address in `inspire_submit` or `inspire_notebook`

---

## Common mistakes to avoid

### 1. Using the push domain instead of the display domain

Wrong:
```text
docker-qb.sii.edu.cn/inspire-studio/...
```

Right:
```text
docker.sii.shaipower.online/inspire-studio/...
```

### 2. Forgetting platform image registration after push

A successful Harbor push does **not** mean the image is usable by jobs.
You must register it in 镜像管理.

### 3. Running network-dependent commands in offline spaces

Do not use:
- `pip install`
- `git clone`
- `wget`
- `curl`

in offline spaces.

### 4. Forgetting conda/env initialization

The platform shell is non-interactive.
If you do not set `commandPrefix`, your command must initialize the environment manually.

### 5. Reusing the wrong spec type

Training, HPC, and notebook specs are different.
Do not assume a quota ID from one task type works for another.

### 6. Using too-small `shm` for multi-GPU work

For multi-GPU jobs, `65536` MB is the safe baseline.

### 7. Treating Harbor credentials as platform credentials

They are separate.
A successful Inspire login does not mean Harbor push will work.

---

## Troubleshooting guide

## Auth succeeds but API use still fails

Possibilities:
- your account lacks API access
- you are off-campus / off-VPN
- the platform endpoint changed or is partially down

Start with:
- `inspire_status()`
- `inspire_job_detail(...)`
- `inspire_logs(...)`

## Submit fails immediately

Common causes:
- wrong `spec`
- wrong `compute_group`
- image not registered on the platform
- image domain is the push domain instead of display domain
- priority exceeds project max
- project budget exhausted

## Job starts but does nothing useful

Check:
- `inspire_metrics(...)` for low utilization / idle windows
- `inspire_logs(...)` for environment setup failures
- whether `commandPrefix` or manual conda init is missing

## Harbor push fails

Check:
- Harbor credentials are correct for the right registry (`qb` vs `sj`)
- Docker is running locally
- network can reach Harbor
- the target registry matches the target workspace family

## Notebook spec not accepted

Notebook uses `SCHEDULE_CONFIG_TYPE_DSW`, not training specs.
Discover notebook specs explicitly.

---

## Source map

If you need to inspect implementation details, these files matter most:

- `src/index.ts` — plugin entry, tool registration, CLI registration
- `src/auth.ts` — Inspire and Harbor authentication behavior
- `src/api.ts` — platform API layer
- `src/resolve.ts` — name/ID resolution
- `src/cache.ts` — cache layer
- `src/shared.ts` — shared validation and helper flows
- `src/tools/status.ts` — entry-point discovery tool
- `src/tools/submit.ts` — GPU training submission
- `src/tools/submit-hpc.ts` — HPC submission
- `src/tools/metrics.ts` — metrics and health assessment
- `src/tools/image-push.ts` — image push flow
- `skills/sii-inspire/content.txt` — built-in skill guidance

---

## Development

```bash
bun install
bun run typecheck
```

Release is handled through the GitHub Release workflow.

---

## License

MIT
