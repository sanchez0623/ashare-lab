# 本地部署与 BaoStock 采集

这个包包含完整源码、已构建网页、本地文件仓库和 Python 采集器。默认资金100万元，五项费用、波段加仓和正反T与已发布版相同；不对接交易。打开网页不需要登录 Sites / Cloudflare，也不需要云端数据库。本地Node服务统一调度Python采集和后台回测；正常操作只需启动一个服务。BaoStock为匿名免费接口，无需API Key或Token。

## 1. 安装并启动网页

在已发布网站的“行情数据”页点击“下载完整本地部署包”，保存 `ashare-lab-local.zip`。也可访问网站根地址下的 `/ashare-lab-local.zip`，需要登录拥有该私有网站的账号。包内 `LOCAL_DEPLOY.md` 是这份说明；Python环境、行情仓库和网站密钥不随包下载。

安装 [Node.js 24 LTS](https://nodejs.org/en/download)（最低22），解压到有写权限的文件夹，例如 `D:\ashare-lab-local` 或用户文档目录。安装 Node 后重新打开终端。

- Windows：双击 `start-local.cmd`，保持打开启动窗口。
- macOS / Linux：在解压目录运行 `bash start-local.sh`。
- 各平台也可运行 `node scripts/local-server.mjs` 或 `npm start`。

浏览器打开 **http://127.0.0.1:8080**。部署包已有构建输出，第一次启动无需 `npm install`、Python 或云平台账号。默认演示为合成行情，不是历史盈利证明。按 Ctrl+C 停止；重新启动会保留行情、任务、检查点和完整报告。

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

## 3. 自动验收一只股票（推荐）

完成Python依赖安装后，重新启动 `node scripts/local-server.mjs`，进入网页“行情数据 → 单股一年数据验收”。后台自动识别 `collector/.venv`；自定义解释器可用环境变量 `ASHARE_PYTHON` 指定绝对路径。

1. 股票填 `600519`，研究结束日填 `2026-09-30`，执行周期选5分钟。
2. 在“策略回测”的配置表中修改资金、费用和策略参数（默认资金100万元、用户指定的五项费率）。
3. 点击“采集并验收”。研究范围自动设为2025-10-01至2026-09-30，另采至少60个交易日预热；较长指标会增加预热长度。后台自动推导主板/创业板/科创板；股票必须在研究期历史成分资料中出现。
4. 查看持久任务状态。采集按月串行查询原生5分钟，并分别取得独立交易日历、日线、历史ST/停牌、历日沪深300快照、复权因子和分红送转。每个完整响应持久化后才确认检查点；六类标准化行情写入Parquet列式本地库，并保存原始响应作为审计依据。
5. 校验通过后自动写入不可变仓库，在后台线程运行回测，使用相同固定输入独立重跑一次，核对净值、现金、权益、费用及结果哈希，然后保存完整报告。
6. 完成后点击“下载完整报告”。包含分钟净值、成交、平仓、T配对、公司行动、五项费用、资料问题和输入哈希。点击“固定快照复现”会创建新任务，复用旧快照，不重新请求行情，结果哈希必须一致。

可用5分钟原始数据聚合到15分钟执行，无需重复拉取15分钟。网页关闭后任务继续，但本地服务窗口须保持打开。覆盖不足、历史ST/成分缺失、预热不足、公司行动不完整、未支持的配股以及数据修订冲突都会阻止正式回测。通过工程验收表示流程和账务完成，不能作为盈利保证。

### 中断恢复与失败处理

- 点击“暂停”或正常Ctrl+C停服务：任务保留已完成分段。重新启动后点击“断点恢复”。
- 服务异常终止：重启时将原运行任务自动重新排队，从已核验检查点继续；上一个未完成月份重新请求。旧采集子进程在下一次SDK发送前检查父进程，失去父进程即停止。所有客户端共享同一主机连接锁。
- 达到日预算或触发黑名单：立即停止并保留断点。预算按北京时间统计，翌日可手动恢复；不在同一天自动重试，不轮换IP。网络/依赖修复后也可点击恢复。
- 检查点、输入或报告哈希不符：停止，不静默替换。保留文件排查；需要重新拉取时创建新任务，避免改写旧研究资料。
- 改动引擎、采集/验收代码或采集的Python/SDK版本：旧断点禁止混用，创建新任务。原报告仍保留。

原始采集仍保留手工CLI作为辅助工具，例如：

```bash
collector/.venv/bin/python collector/sync.py --provider baostock --hs300-history --symbols 600519 --board main --from 2025-07-01 --to 2026-09-30 --timeframe 5m
```

Windows把解释器替换为 `collector\.venv\Scripts\python.exe`。手工CLI文件需按下一节导入；推荐流程已经自动入库和回测。

**本次真实验收状态：受阻。** 已向后台提交600519全年5分钟任务，当前云执行环境未授予BaoStock TCP连接，生成 `NETWORK_TCP_NOT_GRANTED` 阻塞报告，未取得真实完整一年分钟数据。工程测试的合成夹具明确标为 `synthetic-test-only`。在本地可访问官方SDK的主机运行即可继续验证，无需网站授权或API Token；若供应商资料仍不完整，系统会给出具体缺口。

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
| `.local-data/warehouse/` | 自动验收与手工上传的不可变快照和清单 |
| `.local-data/research/jobs/<任务ID>/` | 固定参数、任务状态、分段原始响应与哈希、采集结果 |
| `.local-data/research/reports/<SHA256>.json` | 完整报告，下载和复现前核对哈希 |
| `.local-data/research/market/market.sqlite` | 自动任务分钟索引和修订冲突隔离 |
| `.local-data/research/market/parquet/` | 分钟、日线、日历、成员、公司行动和因子六类列式归档，按内容哈希分文件 |
| `collector/store/` | 采集SQLite、原始响应、输出JSON及成分缓存 |
| 用户目录 `~/.cache/ashare-baostock/` | 本机共享请求预算和连接锁 |
| 浏览器本地存储 | 最近20次研究摘要；换浏览器或端口不共享 |
| `data/samples/`（如有） | 可选的真实行情样例；网站标准下载包不包含此目录 |

停服务后备份整个项目文件夹即可同时保留本地仓库、采集文件与源码；浏览器记录需另外导出回测报告。移动项目不会移动用户目录中的BaoStock日预算，不要删除它来重置限额。自定义仓库目录：`node scripts/local-server.mjs --data-dir D:\ashare-data` 或相应绝对路径。

网站标准下载包不附带真实历史行情，首次打开默认展示合成演示。真实行情需使用自动采集任务或导入自有数据。另行包含 `data/samples/` 的版本提供辅助样例；对应JSON保留资料不足状态，上传CSV时需显式选择“CSV探索”，不能据此视为正式盈利验证或填补一年分钟缺口。

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

构建后重启本地服务。`npm run dev` 是原云Worker开发模式；普通本地部署用 `npm start`。本地Node服务器复用同一云Worker API和质量审计，通过文件适配器代替R2，策略与权益账本口径不变。可运行 `python -m unittest discover -s tests -p "*collector_test.py" -v` 验证采集器；需先安装Python依赖。新增闭环测试使用合成夹具验证中断恢复、串行调度、公司行动账务、固定快照复现与篡改拦截；不会把合成测试标成真实数据验收。

## 8. 本地任务API

服务仅接受回环Host，浏览器写入须同源。接口没有交易功能。

| 操作 | 接口 |
| --- | --- |
| 提交 | `POST /api/research/jobs` |
| 列表/详情 | `GET /api/research/jobs`、`GET /api/research/jobs/<id>` |
| 暂停/恢复 | `POST /api/research/jobs/<id>/pause`、`.../resume` |
| 固定快照复现 | `POST /api/research/jobs/<id>/repeat` |
| 完整报告 | `GET /api/research/jobs/<id>/report` |

提交JSON示例：`{"symbol":"600519","to":"2026-09-30","config":{"timeframe":"5m","capital":1000000}}`。省略费用会使用用户给定默认值；研究开始日自动计算。控制操作POST发送 `{}` 并设置 `Content-Type: application/json`。

结构仍是Node服务+Python采集器，回测采用网页同一套已测试的JS引擎，后台Worker线程独立执行。单个服务串行调度持久任务，不依赖浏览器存储；本地文件仓库与SQLite需要与源码一起备份。当前结果仍属于单机研究系统，真实完整一年数据验收尚待在BaoStock可连通环境完成。

## 9. 统一数据源接口与可选依赖

`collector/sources.py` 注册五源，统一提供 `get_daily / get_minute5 / get_adj_factor / get_index_daily`；不支持的能力会明确返回 `UNSUPPORTED`。可选SDK延迟导入，未安装时 `available()=False`，不影响Node启动或显式合成演示。默认安装 `collector/requirements.txt` 仅包含年度验收必需的核心库和BaoStock；其余可按需安装。

```bash
collector/.venv/bin/python -m pip install -r collector/requirements-sources.txt
collector/.venv/bin/python collector/sources.py --status
```

Windows替换为 `collector\.venv\Scripts\python.exe`。也可单独 `pip install akshare` 或 `pip install mootdx`。理杏仁设置采集主机环境变量 `LIXINGER_API_KEY`，兼容旧 `LIXINGER_TOKEN`，无需写入浏览器或数据包。

网页“行情数据 → 数据源就绪情况”和 `GET /api/research/sources` 显示五源依赖、密钥是否配置及网络许可；缓存60秒，**不会发行情请求或自动消费付费额度**。“已配置”不代表接口连通或年度完整。SDK层 `check_health(probe=...)` 支持显式健康探测和60秒缓存，探测须经过同一适配器和限流。

| 类型 | 辅助请求降级顺序 |
| --- | --- |
| 日线 | BaoStock → AkShare → mootdx → 理杏仁 |
| 科创板日线 | mootdx → BaoStock → AkShare → 理杏仁 |
| 历史5分钟 | BaoStock → mootdx → AkShare → 新浪 |
| 盘中5分钟 | mootdx → 新浪 |
| 因子候选 | AkShare hfq/raw比值 → BaoStock事件因子 |
| 指数日线 | BaoStock → AkShare |

辅助CLI示例：

```bash
collector/.venv/bin/python collector/sources.py --kind daily --symbol 600519 --from 2025-10-01 --to 2026-09-30
collector/.venv/bin/python collector/sources.py --kind minute5 --purpose intraday --symbol 600519 --from 2026-09-01 --to 2026-09-30
```

这些输出是带来源和原始响应哈希的辅助候选数据，不会直接进入正式回测。`SourceRouter.fetch(..., expected_dates=..., purpose="annual")` 要求独立日历，校验全部48根原生5分钟网格及成交量单位；短历史继续降级，全部不满足时失败，不混入合成数据。每次选中完整候选源，保留各次拒绝原因，不把不同源片段静默拼接；BaoStock日额度/连接锁/黑名单阻断会直接停止。

### 年度自动验收与多源的界限

年度任务已经通过统一BaoStock适配器采集，但仍固定一个完整来源及其历史ST、成员、日历、公司行动和交易所参考价证据；五源的辅助降级链不会自动替代这些正式准入资料。今天 `query_all_stock` 的名称/ST/退市状态不能充当历史逐日状态，实际研究继续使用逐日日线 `isST` 和历史成员快照。新增多源正式任务前需完成来源间量价、单位与权益审计。

mootdx适配器已实现 `frequency=0/9`、每页800根、最多64页、串行间隔、重复分页检测；已通过传输夹具测试，当前环境未安装可选SDK，且没有TCP许可，未宣称真实连通。返回成交量保留供应商单位，必须用独立股单位日线校准后才能正式准入，不猜测倍数。远端分页能力不保证保留整年数据。

AkShare的hfq/raw比值只作为因子候选，不能取代当时可得的因子链和完整分红送转账务。理杏仁排最后保护付费额度，每次选择只请求一次，不自动付费重试。新浪请求5049根返回空时仅降为1970根请求一次；本次真实HTTP实测仍只有1970根（2026-08-03 14:55至2026-09-30 15:00），不是完整一年。

HTTP会话默认继承代理和CA；当前云环境必须保留这些设置，不照搬 `trust_env=False`。自有主机确需禁用环境代理时可设置 `ASHARE_HTTP_TRUST_ENV=0`，该选项不会在受管云环境关闭代理。第三方SDK的HTTP请求设定默认超时；BaoStock所有SDK分页继续共用原用量锁与计数器。

Parquet归档继续按逻辑内容与文件双哈希保存六类行情，原始响应保留审计依据。腾讯qt实时行情、申万/乐咕行业及股票基础信息的完整更新器尚未接入；它们不影响本次单股年度目标。真实完整一年验收仍等待在BaoStock可连通且资料完整的主机完成。

托管网站还支持私有环境变量 `LIXINGER_API_KEY`、`LIXINGER_TOKEN` 或已有的 `lixingren-key`。浏览器只能看到配置状态，不能读取密钥；显式日线验证请求600519在2026-09-30的一根原始日线，单次请求无自动重试，结果及失败缓存24小时，并留存原始行情哈希。网站密钥不会自动传给本地Python；本地仍需配置标准环境变量。该探测不提供年度分钟数据，也不会自动进入正式回测。
