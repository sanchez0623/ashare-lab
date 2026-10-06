# 本地部署与 BaoStock 采集

这个包包含完整源码、已构建网页、本地文件仓库和 Python 采集器。默认资金100万元，五项费用、波段加仓和正反T与已发布版相同；不对接交易。打开网页不需要登录 Sites / Cloudflare，也不需要云端数据库。数据采集另用 Python，BaoStock 为匿名免费接口，无需 API Key 或 Token。

## 1. 安装并启动网页

安装 [Node.js 24 LTS](https://nodejs.org/en/download)（最低22），解压到有写权限的文件夹，例如 `D:\ashare-lab-local` 或用户文档目录。安装 Node 后重新打开终端。

- Windows：双击 `start-local.cmd`，保持打开启动窗口。
- macOS / Linux：在解压目录运行 `bash start-local.sh`。
- 各平台也可运行 `node scripts/local-server.mjs` 或 `npm start`。

浏览器打开 **http://127.0.0.1:8080**。部署包已有构建输出，第一次启动无需 `npm install`、Python 或云平台账号。默认演示为合成行情，不是历史盈利证明。按 Ctrl+C 停止；重新启动会保留已上传行情。

端口占用时：`node scripts/local-server.mjs --port 8081`，然后访问 http://127.0.0.1:8081。

服务只监听本机127.0.0.1，不提供局域网共享或公网登录。不要把它直接通过隧道、反向代理公开；多人服务需要另做鉴权。Windows / macOS 启动脚本已提供；本次实际启动与浏览器验收在 Linux / Node.js 24 上完成。

## 2. 安装 Python 采集环境

安装 [Python 3.12](https://www.python.org/downloads/)（最低3.10）。Windows安装时勾选添加到 PATH；命令示例使用 `py` 启动器，无需激活 PowerShell 虚拟环境。进入项目目录。

Windows PowerShell / 命令提示符：

```powershell
py -3 -m venv collector/.venv
collector\.venv\Scripts\python.exe -m pip install -r collector/requirements.txt
```

macOS / Linux：

```bash
python3 -m venv collector/.venv
collector/.venv/bin/python -m pip install -r collector/requirements.txt
```

网络需允许 BaoStock SDK 到 `public-api.baostock.com:10030` 的出站TCP连接，通常个人电脑无需额外配置；公司网络可能限制。采集器提供 Windows / POSIX 文件锁，Windows时区数据库由依赖安装。网页能打开不代表采集联网成功，以SDK实际结果为准。

## 3. 首次拉取一只股票

先采集贵州茅台600519，避免上来全池回填。请求从2025-07-01开始，给“最近一年”回测预留至少60个完整日线；结束日为本包制作时已返回数据的2026-09-30。以后将日期改为需要的范围。

Windows（一行执行）：

```powershell
collector\.venv\Scripts\python.exe collector/sync.py --provider baostock --hs300-history --symbols 600519 --board main --from 2025-07-01 --to 2026-09-30 --timeframe 5m
```

macOS / Linux（一行执行）：

```bash
collector/.venv/bin/python collector/sync.py --provider baostock --hs300-history --symbols 600519 --board main --from 2025-07-01 --to 2026-09-30 --timeframe 5m
```

采集5分钟即可，系统从真实5分钟聚合15分钟，不重复拉两个周期。`--hs300-history` 同步按查询日保存历史成分；正式研究还核对日线ST、停牌、日历、分红送转、复权因子。BaoStock成分接口按周更新，更新日视为收盘后才已知。覆盖不足、缺失公司行动或配股未支持时，正式准入仍会阻止；联网成功不等于资料完整。

成功会打印JSON摘要，`output`字段指向生成文件。此云环境仍没有BaoStock TCP放行，因此本包没有冒充已完成一年BaoStock回填。

## 4. 导入本地系统

保持本地网页服务运行，在“行情数据”页上传 `collector/store/output/` 下生成的JSON文件。查看质量报告；只有缺口与历史资料校验通过才能正式回测。上传后保存在本机文件仓库。

也可批量导入已采集文件，无需网站Token：

Windows：

```powershell
collector\.venv\Scripts\python.exe collector/upload_local.py collector/store/output
```

macOS / Linux：

```bash
collector/.venv/bin/python collector/upload_local.py collector/store/output
```

若网页用8081端口，追加 `--url http://127.0.0.1:8081`。上传脚本只接受本机回环地址，每份文件按SHA256幂等保存，并读回验证完全相同的字节。远程私有网站的`--site`上传是另一条流程，不能把其Token需求混同BaoStock登录。

## 5. 后续增量与保存

再次执行相同采集命令，追加 `--incremental`，并更新 `--to`：保留分钟历史，补增量并重查7日重叠。请求串行、同主机单连接，默认每天10000次、每次至少间隔1秒，计数含登录和SDK分页；官方每日上限50000且禁止并发。黑名单错误立即停止。不要同时启动另一份BaoStock客户端；同一公网IP下其他机器也需协调流量。

| 路径 | 保存内容 |
| --- | --- |
| `.local-data/warehouse/` | 网页已上传的原始快照与清单，重启保留 |
| `collector/store/` | 采集SQLite、原始响应、输出JSON及成分缓存 |
| 用户目录 `~/.cache/ashare-baostock/` | 本机共享请求预算和连接锁 |
| 浏览器本地存储 | 最近20次研究摘要；换浏览器或端口不共享 |
| `data/samples/` | 随包真实行情样例；正式资料未齐 |

停服务后备份整个项目文件夹即可同时保留本地仓库、采集文件与源码；浏览器记录需另外导出回测报告。移动项目不会移动用户目录中的BaoStock日预算，不要删除它来重置限额。自定义仓库目录：`node scripts/local-server.mjs --data-dir D:\ashare-data` 或相应绝对路径。

包内已带最近一年日线（241根）和原生15分钟约半年（1970根）及5分钟近期样例。对应JSON保留资料不足状态；如需体验真实价格，可上传CSV并显式选择“CSV探索”，不视为正式盈利验证。样例不能填补一年分钟缺口。

## 6. 定时采集

本地启动不会自动启用采集定时器。先完成单标的采集、入库与质量验收，再配置任务：

- Windows任务计划：程序填写 `collector\.venv\Scripts\python.exe` 的绝对路径，参数填完整的 `collector/sync.py ... --incremental` 命令，起始目录填项目根，设为不启动并行实例。完成后运行 `collector/upload_local.py collector/store/output` 导入；网页服务须仍运行。
- Linux提供 `collector/ashare-sync.service` 和 `.timer`，需按真实安装路径配置；说明见 `collector/README.md`。
- macOS可用系统任务或终端手动执行。定时器应在北京时间收盘后的工作日运行，以日志、最新日期和缺口报告确认成功。

不要把大量全池回填和增量任务并行运行。当前包没有安装任何定时任务。

## 7. 修改源码与验证

仅在修改源码、重新构建时需要联网安装Node开发依赖：

```bash
npm ci
npm run build
npm test
```

构建后重启本地服务。`npm run dev` 是原云Worker开发模式；普通本地部署用 `npm start`。本地Node服务器复用同一云Worker API和质量审计，通过文件适配器代替R2，策略与权益账本口径不变。可运行 `python tests/collector_test.py` 验证采集器；需先安装Python依赖。
