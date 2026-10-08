# 青衡 · 本地部署包（IP监控与连接诊断修复）

完整源码和提交历史位于 [main 分支](https://github.com/sanchez0623/ashare-lab/tree/main)。

源码版本：`579c9dba81588ad95410588973295bae321fcf29`。

本包修正HTTP候选IP的标识，支持Windows系统代理识别、网页持久人工IP声明及强制刷新。BaoStock SDK连接关闭时及时结束接收，失败报告保留登录/查询阶段与传输原因，不自动重试、不重置预算，旧采集断点兼容。

安装Node.js 22或更新版本，完整解压后用 `start-local.cmd` 或 `bash start-local.sh` 启动，打开 http://127.0.0.1:8080 。自动采集另需安装Python依赖。升级先停止服务，保留 `.local-data`、`collector/.venv` 和本地密钥配置，更新代码与构建文件。

包内含1.17版详细说明书。监控IP仅用于标签和本机计数归属，未独立证明BaoStock实际TCP出口，不能修复本机网络或解除黑名单。配置保存在数据目录的 `research/traffic-monitor.json`；环境变量 `BS_MONITOR_IP` 仍优先。

SHA-256：`ff314887248179b07ea2129711f95ceda44a03498cb755715567aca916b98064`。
