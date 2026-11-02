# 1Panel / yklx-update

此分支基于 OpenClaw **2026.10.8**，插件版本 **1.1.0**。不升级 OpenClaw 宿主，不调用收费接口。

## 首次接入

现有容器必须由 `/opt/openclaw-xiaoai/compose.yaml` 管理，项目名 `openclaw-xiaoai`、服务名 `openclaw-gateway`、容器名 `openclaw-xiaoai`，网关监听 18789，已有健康检查。安装器核对现有 Compose 哈希和运行容器；配置不一致时停止，不覆盖。需要 root、Git、Python 3.9+、Docker Compose 2.20+ 和已有 yklx-update 注册表。

在服务器执行：

```sh
git clone --branch main https://github.com/hekun0311/Xiaoai-Claw-Addon.git /opt/openclaw-xiaoai/source
cd /opt/openclaw-xiaoai/source
sh deploy/1panel/install.sh
```

若 source 已存在，不重复 clone；先确认 origin 和干净的 main 分支，再执行 `git pull --ff-only origin main` 和安装命令。

安装器从当前运行镜像读取版本和官方 RepoDigest，固定在 runtime/base.json；派生镜像持久包含 ffmpeg、Python、requests。宿主机安装 ffmpeg 不代表容器内可用。插件从构建镜像提取到 releases，按版本只读挂载；原有 `.openclaw` 和 auth-secrets 挂载、账号、配置、数据库保持原位置。Compose 入口转向私有 runtime/compose.json，勿再使用旧 Compose 覆盖它。

构建时旧服务继续运行；构建成功后停止服务，备份挂载数据及部署配置再切换。启动失败恢复旧镜像和部署配置，不自动覆盖数据库。首次迁移保留旧镜像；容器由 Compose 重建，旧容器不额外保留。备份和旧版本不自动清理，请预留足够磁盘空间。

成功后原菜单前三项不变，新增第 4 项 OpenClaw 小爱。重复 install 只核对健康与注册，不重复注册。以后执行 `yklx-update` 并选择 OpenClaw 小爱，更新器也可直接运行 `sh deploy/1panel/update.sh main`。

构建失败查看仅管理员可读的 `/opt/openclaw-xiaoai/build.log`，分享前脱敏；安装器不直接打印原始日志或配置。服务健康不代表音箱听感验收通过。

## 火山音色

打开原小爱控制台 → 控制 → 语音音色。默认小爱原声；选择火山，填写自己的新版 API Key、模型服务和完整音色 ID，复刻默认标准版。保存不收费，后续回答立即使用新设置。API Key 留空保留，清除需要点击清除、选择小爱原声并保存。

点击测试音色使用已保存设置，由当前音箱播放固定句子，不加入对话历史；会发生实际合成费用。普通回答、xiaoai_speak 和控制台文本播报使用所选引擎；显式 xiaoai_tts_bridge 仍使用官方 TTS。火山失败不会回退原声或自动重试。火山模式跳过过渡提示，但不删除保存内容；切回原声恢复过渡提示。

配置单独保存到插件状态目录下 speech-settings.json，权限 0600。音频走现有 relay，不依赖 MiGPT。切换配置、新问题或停止服务取消未完成的合成；不会把旧合成结果发给音箱。

## 验证边界

本地：`npm ci && npm run build`，`node --test tests/speech.mjs tests/xiaomi-rate-limit.mjs tests/manual-device-list.mjs tests/openclaw-agent-entries.mjs`，`python3 deploy/1panel/test_deploy.py`。模拟测试不访问火山、小米或收费模型。

服务器由用户验证容器健康、原域名、登录态、手动设备列表、两类音色、连续提问和停止服务。首次点击测试前确认音箱已连接；不要让 MiGPT 和该插件同时接管同一音箱。
