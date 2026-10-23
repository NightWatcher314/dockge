# 栈状态

列表、轮询、详情与 MCP 使用同一容器状态判定。原有编号 0–4 保持兼容：

| 编号 | 状态 | 颜色 | 含义 |
| --- | --- | --- | --- |
| 0 | unknown | 灰 | 状态未知、读取失败或无法解析所需配置 |
| 1 | draft | 灰 | 本地 Compose 文件存在，尚无容器 |
| 2 | created_stack | 灰 | 保留旧编号 |
| 3 | running | 绿 | 常驻容器运行，明确任务可以已成功完成 |
| 4 | exited | 灰 | 常驻容器已停止 |
| 5 | completed | 绿 | 全部为明确任务，均已成功退出 |
| 6 | partial | 黄 | 部分常驻服务停止、暂停，或缺少所需服务/副本 |
| 7 | unhealthy | 红 | unhealthy、restarting、dead、OOM、非零退出或 Docker 创建错误 |
| 8 | starting | 黄 | created 或 health starting |

一次性任务只认两种声明：被 `depends_on.condition: service_completed_successfully` 依赖，或 Compose/容器有 `dockge.task=true` label。`restart: "no"` 和退出码 0 都不能独立证明任务身份。常驻服务退出 0 仍为已停止；失败任务为异常。暂停不会显示绿色。明确任务仍在运行时显示 starting，退出 0 后才算完成。正常服务加成功任务仍是 running；成功任务加全部已停止的常驻服务为 exited。

每次列表刷新执行一次按 Compose project label 筛选的 `docker ps -aq`，再每批最多 100 个容器执行带 `--format` 的 inspect。只读取 project/service/oneoff/task labels、容器名和必要 State 字段；不读取 Env、完整 inspect、健康检查输出或 Docker 错误原文。`docker compose ls` 仅发现项目；删除竞态、输出不完整或读取失败清空原有绿色缓存。`compose run` 的 oneoff 容器不参与栈状态。

本地管理的 Compose 文件提供默认服务、依赖、任务和副本数。未出现的 profile 服务、`replicas: 0` / `scale: 0` 服务不算缺失；已出现的 profile 服务照常参与判定。默认服务的必要依赖仍需存在，`required: false` 依赖除外。MCP `stack_verify` 接受正常运行和明确任务的 completed，拒绝启动中、异常、常驻服务退出、缺少默认服务或副本。显式 `services` 可缩小验证范围。

`hasActiveContainers` 独立描述运行、重启或暂停容器。页面停止/重启按钮与镜像更新后的重建据此判断；部分停止或异常栈也可启动以恢复服务。

界限：状态不是应用可用性证明，业务连通性需另行验证。未管理项目只能依据现有容器与显式容器任务 label，无法发现缺少的 Compose 服务。为避免每栈启动 Compose 配置进程，不展开环境变量、include、extends 或多文件覆盖；include、extends 和无法确定的副本数保守显示 unknown。profile 依据默认服务与实际已出现的容器推断，不追踪外部命令历史或 `COMPOSE_PROFILES` 激活状态。轮询反映采样时刻，不保证 Docker 后续状态不变。
