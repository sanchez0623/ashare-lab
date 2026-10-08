# 青衡 · 本地部署包

本分支存放已构建的完整本地部署包。[完整源码和提交历史位于 main 分支](https://github.com/sanchez0623/ashare-lab/tree/main)。

源码版本：`5f66f32e33df42b51ac2dc6cc8593470204c9267`。

下载 `ashare-lab-local.zip` 并完整解压。安装 Node.js 22 或更新版本后，Windows 双击 `start-local.cmd`，macOS / Linux 运行 `bash start-local.sh`，打开 http://127.0.0.1:8080 。自动采集需要按包内 `LOCAL_DEPLOY.md` 安装 Python 依赖。

升级时先停止旧服务，保留 `.local-data`、`collector/.venv` 和本地密钥配置，再更新代码与构建文件。包内含详细说明书，不包含个人行情仓库、任务数据或密钥。

SHA-256：`8edb3f1c347c8ec1604f99d17ad98f36baf7e06aeab2796eee33c32c5cf8a77c`。
