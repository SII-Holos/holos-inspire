# holos-inspire

A [Synergy](https://github.com/ericsanchezok/synergy) plugin for SII 启智平台 (qz.sii.edu.cn) — an academic GPU cluster for AI research. Gives the Synergy agent direct control over GPU/HPC job submission, Docker image management, resource monitoring, notebook environments, and inference deployment.

## Tools

| Tool | Purpose |
|------|---------|
| `inspire_status` | Discover projects, workspaces, compute groups, and available resource specs |
| `inspire_config` | Read/write plugin defaults (project, workspace, image, priority, etc.) |
| `inspire_submit` | Submit GPU training tasks |
| `inspire_submit_hpc` | Submit HPC/CPU tasks (Slurm scheduling) |
| `inspire_inference` | Deploy and manage model inference services |
| `inspire_jobs` | List tasks with status filtering, spec_id, and compute group info |
| `inspire_job_detail` | Detailed task info with failure diagnostics |
| `inspire_logs` | Query or download job logs |
| `inspire_metrics` | GPU utilization metrics with health assessment |
| `inspire_stop` | Stop tasks (single or batch) |
| `inspire_images` | Browse platform-registered images or raw Harbor registry |
| `inspire_image_push` | Push local Docker images to Harbor (七宝 or 松江) |
| `inspire_notebook` | Manage interactive notebook environments |
| `inspire_models` | Manage the platform model repository |

Includes a built-in skill (`sii-inspire`) with platform guide, troubleshooting reference, and distributed training documentation.

## Installation

Add to your Synergy config:

```jsonc
// synergy.jsonc
{
  "plugin": ["github:SII-Holos/holos-inspire"]
}
```

Synergy will install the plugin automatically on startup.

## Authentication

Platform credentials (学工号 + password) are required. Log in via CLI:

```bash
synergy inspire login
```

For Docker image push, Harbor credentials are separate (find them under 镜像管理 → 本地推送):

```bash
synergy inspire harbor-login                  # 七宝 (default, all spaces except SJ)
synergy inspire harbor-login --registry sj    # 松江 (SJ资源空间 only)
```

## Configuration

Set defaults to simplify repeated tool calls:

```jsonc
// synergy.jsonc
{
  "pluginConfig": {
    "inspire": {
      "defaultProject": "your-project-name",
      "defaultWorkspace": "分布式训练空间",
      "defaultImage": "docker.sii.shaipower.online/inspire-studio/your-image:tag",
      "defaultPriority": 9,
      "defaultShm": 1200,
      "commandPrefix": "source /opt/conda/etc/profile.d/conda.sh && conda activate myenv && cd /inspire/hdd/project/xxx/code"
    }
  }
}
```

`commandPrefix` eliminates repetitive environment setup — `inspire_submit` automatically prepends it to every command.

Note: `spec_id` and `compute_group` are **not** stored as defaults because they vary by workspace and task type. Use `inspire_status` to see available options, then pass them directly.

## Platform Essentials

### Image Registries

Two independent registries (push domain → display domain):

| Registry | Push Domain | Display Domain | Spaces |
|----------|------------|---------------|--------|
| Main | `docker-qb.sii.edu.cn` | `docker.sii.shaipower.online` | All except SJ |
| SJ | `docker-t.sii.edu.cn` | `docker-t.sii.shaipower.online` | SJ资源空间 only |

After `docker push`, you **must** register the image on the platform: 镜像管理 → 新建镜像 → fill 镜像名称 + 版本号. Submit tasks using the **display domain**, not the push domain.

### Resource Specs

Each task type has its own spec list. Omit the `spec` parameter in any submit tool to see available specs:

| Task Type | Schedule Type |
|-----------|--------------|
| GPU Training | `SCHEDULE_CONFIG_TYPE_TRAIN` |
| HPC/Slurm | `SCHEDULE_CONFIG_TYPE_HPC` |
| Notebook | `SCHEDULE_CONFIG_TYPE_DSW` |

### Workspace Network

| Has Internet | Spaces |
|-------------|--------|
| ✅ | 可上网GPU资源, CPU资源空间, 国产卡, PPU, 专属资源开发空间, SJ资源空间 |
| ❌ | 分布式训练空间, 高性能计算, 整节点任务空间 |

Offline spaces: no `pip install`, `git clone`, or `wget` in commands. All dependencies must be in the Docker image. Storage (`/inspire/hdd/project/`) is shared across all spaces in the same project.

### Distributed Training

The platform auto-injects environment variables: `MASTER_ADDR`, `MASTER_PORT`, `PET_NNODES`, `PET_NODE_RANK`, `PET_NPROC_PER_NODE`. Use them directly in `torchrun` / `deepspeed` commands.

## Development

```bash
bun install
bun run typecheck    # or: bunx tsc --noEmit
```

Branch protection: `main` requires `typecheck` CI to pass. Use PRs for changes.

Release: trigger the Release workflow in GitHub Actions with a version number.

## License

MIT
