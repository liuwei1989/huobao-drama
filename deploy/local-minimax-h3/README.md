# 本地 MiniMax-H3 视频通道（local-minimax-h3）

在云端视频 key 余额耗尽时，把 huobao-drama 的视频生成切换到**本地自部署的 MiniMax-H3**（GPU 盒子上的 ComfyUI），补齐缺失镜头后正常走合成流程。

> 本目录文件里的服务器地址、路径、域名均为生产环境实例值，复用时应替换为自己的。

## 架构

```
huobao-drama 容器 (172.20.0.2)
   │  POST /v2/video_generation  (minimax 协议)
   ▼
minimax_shim.js  (宿主机, 双绑定 127.0.0.1:9001 + 172.20.0.1:9001)
   │  构造 ComfyUI 工作流 (MiniMaxH3ImageToVideo, 首/尾帧)
   ▼
ComfyUI  (宿主机 127.0.0.1:8188)
   │  SSH 本地转发 (-L 127.0.0.1:8188:127.0.0.1:8188)
   ▼
GPU 盒子 ComfyUI (AutoDL, RTX 4080 SUPER 32G, 127.0.0.1:8188)
```

shim 把 huobao 的 minimax-video 适配器协议（`POST /v2/video_generation` + `GET /v2/query/video_generation/{task_id}`）翻译成 ComfyUI 的 `/prompt` + `/history` 轮询，成片下载到 huobao 静态目录并返回公网 URL，对 huobao 完全透明。

## 文件清单

| 文件 | 作用 |
|---|---|
| `minimax_shim.js` | 协议兼容层（零依赖 Node 脚本）。提交工作流、轮询、下载成片，**落盘前自动 ffmpeg 归一化**（见下方「已知坑」） |
| `comfy_tunnel.sh` | SSH 隧道管理脚本（start/stop/status/restart），保活参数已内置 |
| `comfy-tunnel.service` | 隧道开机自启 + 自动重启 |
| `minimax-shim.service` | shim 开机自启 + 自动重启，依赖隧道先就绪 |

## 部署步骤

1. **SSH 免密**：huobao 宿主机生成 `/root/.ssh/id_ed25519`，公钥写入 GPU 盒子 `/root/.ssh/authorized_keys`（不要用 expect/密码，宿主机没有 expect）。
2. **放行 iptables**（关键，见下方「已知坑」）：
   ```bash
   iptables -I INPUT <REJECT规则行号> -p tcp -s 172.20.0.0/16 --dport 9001 -j ACCEPT
   iptables-save > /etc/sysconfig/iptables   # CentOS 7 持久化
   ```
3. **装 ffmpeg**（宿主机没有）：从 huobao 容器拷静态二进制，不动系统包管理：
   ```bash
   docker cp huobao-drama:/app/backend/node_modules/ffmpeg-static/ffmpeg /usr/local/bin/ffmpeg
   docker cp huobao-drama:/app/backend/node_modules/ffprobe-static/bin/linux/x64/ffprobe /usr/local/bin/ffprobe
   chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
   ```
4. **安装服务**：两个 `.service` 放 `/etc/systemd/system/`，`minimax_shim.js` 和 `comfy_tunnel.sh` 放 `/home/huobao_drama/`，然后 `systemctl enable --now comfy-tunnel minimax-shim`。
5. **huobao 配置**：管理界面新增视频 AI 配置——
   - provider = `minimax`
   - base_url = `http://172.20.0.1:9001`（**不要用 127.0.0.1**，容器内回环≠宿主机）
   - api_key 任意占位串（如 `local-shim`），model 任意（如 `MiniMax-H3`）
   - 优先级调高，确保视频任务走这条通道

## 已知坑（都踩过）

1. **Docker 网络隔离 + iptables REJECT**：容器访问宿主机要用网桥网关 IP（`172.20.0.1`）而非 `127.0.0.1`；且宿主机 INPUT 链末尾常有 `REJECT icmp-host-prohibited`，容器经网桥进来的包只要端口不在白名单就被拒——**客户端表现为 `EHOSTUNREACH` 而非连接被拒**，极易误判。判据：白名单端口（443/3306/6379）通、目标端口不通。
2. **ffmpeg 混流丢包（无错误码）**：H3 原生输出是 1344x768/24fps/32kHz，与 Wan 系列片段（1280x720/30fps/44.1kHz）直接 concat，音频轨被整个丢弃、视频缺约 20% 帧，**ffmpeg 不报错**，只有时长暴露问题（25s vs 应有的 30s）。修复：H3 输出先归一化到 1280x720/30fps/44.1kHz 再拼接。shim 已在落盘前自动归一化（`SHIM_FFMPEG`/`SHIM_NORM_W/H/FPS` 可调，失败则保留原文件降级）。
3. **ComfyUI DynamicCombo API 格式**：值直接是选项 key 字符串（`"format":"mp4"`），嵌套子输入用 `父.子` 键名（`"format.codec":"h264"`），不要传嵌套 dict。
4. **模型目录看似为空**：GPU 盒子的权重是软链进 ComfyUI `models/` 的，`du` 不跟随软链，用 `ls -la` 确认。

## 环境变量（minimax-shim.service）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SHIM_PORT` | `9001` | shim 监听端口（双绑定 127.0.0.1 + docker 网关） |
| `COMFY_URL` | `http://127.0.0.1:8188` | 宿主机侧 ComfyUI |
| `SHIM_OUT_DIR` | `/home/huobao_drama/data/static/videos` | 成片落盘目录 |
| `SHIM_PUBLIC_BASE` | `https://drama.crayfish.cloud/static/videos` | 返回给 huobao 的公网 URL 前缀 |
| `SHIM_UNET` / `SHIM_CLIP` / `SHIM_LORA` | H3 权重文件名 | ComfyUI models 下的权重 |
| `SHIM_STEPS` | `8` | 采样步数（配 8step turbo LoRA） |
| `SHIM_FFMPEG` | `/usr/local/bin/ffmpeg` | 归一化用 ffmpeg 路径 |
| `SHIM_NORM_W/H/FPS` | `1280`/`720`/`30` | 归一化目标参数 |

## 性能参考

5s / 124 帧 / 1344x768 在 RTX 4080 SUPER 上约 5 分钟出片（约 1.2MB MP4）。
