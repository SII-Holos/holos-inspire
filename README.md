# holos-inspire

A [Synergy](https://github.com/ericsanchezok/synergy) plugin that connects to SII 启智平台 (qz.sii.edu.cn) — an academic GPU cluster for AI research. Gives the Synergy agent direct control over GPU/HPC job submission, image management, resource monitoring, and inference deployment.

## Tools

| Tool | Purpose |
|------|---------|
| `inspire_status` | Query projects, workspaces, GPU resources, and constraints |
| `inspire_config` | Read/write plugin defaults (project, workspace, image, etc.) |
| `inspire_submit` | Submit GPU training tasks via OpenAPI |
| `inspire_submit_hpc` | Submit HPC/CPU tasks (Slurm) |
| `inspire_inference` | Deploy and manage inference services |
| `inspire_jobs` | List tasks with status filtering and pagination |
| `inspire_job_detail` | Get detailed task info with failure diagnostics |
| `inspire_logs` | Query or download training job logs |
| `inspire_metrics` | GPU utilization metrics with health assessment |
| `inspire_stop` | Stop tasks (single or batch) |
| `inspire_images` | Browse Docker images in Harbor registry |
| `inspire_image_push` | Push local Docker images to Harbor |
| `inspire_notebook` | Manage Jupyter notebook environments |
| `inspire_models` | Manage the platform model repository |

The plugin also provides a built-in skill (`sii-inspire`) with a platform guide, troubleshooting reference, and distributed training documentation.

## Installation

Install the package, then register it in your Synergy config:

```bash
bun add holos-inspire
```

```jsonc
// synergy.jsonc
{
  "plugin": ["holos-inspire"]
}
```

## Authentication

The platform requires CAS credentials (学工号 + password). Log in through the Synergy CLI:

```bash
synergy inspire login
```

If you need to push Docker images to Harbor, authenticate separately:

```bash
synergy inspire harbor-login
```

Both commands will prompt for credentials interactively. Credentials are stored locally and encrypted.

## Configuration

Set defaults to avoid repeating parameters on every tool call. These can be configured in `synergy.jsonc` or at runtime via `inspire_config`:

```jsonc
// synergy.jsonc
{
  "pluginConfig": {
    "inspire": {
      "defaultProject": "your-project-name",
      "defaultWorkspace": "分布式训练空间",
      "defaultComputeGroup": "cuda12.8版本H100",
      "defaultImage": "docker-qb.sii.edu.cn/inspire-studio/your-image:tag",
      "defaultSpecId": "quota-id-from-platform",
      "defaultPriority": 5,
      "defaultShm": 1200,
      "commandPrefix": "source /opt/conda/etc/profile.d/conda.sh && conda activate myenv && cd /inspire/hdd/project/xxx/code"
    }
  }
}
```

The `commandPrefix` is particularly useful — it eliminates repetitive environment setup in every job command. With it set, `inspire_submit` only needs a task name and the training command itself.

A typical first-time setup: run `inspire_status` to discover available projects and resources, then configure defaults based on what it returns.

## Platform Notes

- **Offline workspaces**: 分布式训练空间 has no internet access. All dependencies must be pre-installed in the Docker image.
- **Non-interactive shell**: `~/.bashrc` is not loaded. Initialize your environment explicitly in the command or via `commandPrefix`.
- **Distributed training**: The platform injects `MASTER_ADDR`, `PET_NNODES`, `PET_NODE_RANK`, and `PET_NPROC_PER_NODE` automatically.
- **Network requirement**: Most API calls require campus network or VPN access.

## Development

```bash
bun install
bun run typecheck
```

## License

MIT
