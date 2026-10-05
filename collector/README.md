# 沪深300回测数据采集器（不连接交易）

主要数据源为用户指定的BaoStock；无需API Key / Token。官方SDK使用TCP连接，当前托管执行环境没有相应TCP授权，因此未在此环境运行真实BaoStock回填。请在允许官方SDK联网的自有Linux主机运行。不要通过更换IP或并发连接绕过服务限制。

## 首次拉取

```bash
python3 -m venv collector/.venv
collector/.venv/bin/pip install -r collector/requirements.txt
collector/.venv/bin/python collector/sync.py --provider baostock --hs300-history --from 2023-01-01 --to 2026-09-30
```

首次默认采集区间内历史成分快照的证券并集；日线与分钟从同一个请求开始日拉取，开始日必须早于正式交易日至少60个完整交易日。建议先限定单只进行验证，避免无目的全池回填：

```bash
collector/.venv/bin/python collector/sync.py --provider baostock --hs300-history --symbols 600519 --board main --from 2023-01-01 --to 2026-09-30
```

`--incremental` 保留历史并补分钟增量，重查7日重叠。日线、公司行动和因子为较小的辅助资料重新核验；交易日历一次进程只查询一次，历史成员快照按查询日期缓存，股票串行处理。SQLite保存已完成证券与修订冲突，API响应数据保存SHA-256快照。失败不冒充完整数据，未完成任务再次运行；不要在重叠冲突未裁决前使用旧值正式研究。单包上限120000根，超过请先缩短研究区间。

结果位于 `collector/store/output/*.json`，在私有研究台“行情与完整性”页上传；服务端重新校验并保留不可变快照。不把原始成交价替换成今日前复权价。仅5分钟可聚合为15分钟，不重复请求两种分钟周期。

## 严格控制流量

[官方访问规则](https://www.baostock.com/blacklist)：每日最多50000次，禁止并发连接；初次限制6小时，再次按年度累计次数递增。

本采集器使用一个SDK连接、同主机全局连接锁、北京时间每日计数库，拦截SDK底层send_msg，因此包括自动分页与登录。默认10000次/日，每个请求至少间隔1秒，预算耗尽立即停止，已完成证券保留断点。`10001011`立即停止，不自动重连。参数 `--bs-budget` 最高40000，预留其他请求余量。

默认计数库在 `~/.cache/ashare-baostock/traffic.sqlite`，用 `BAOSTOCK_BUDGET_PATH` 可统一任务路径。同一公网IP下其他程序/主机也必须协调，采集器无法替它们计数；不要同时运行其他BaoStock客户端。初次全池历史回填可能需多天，保持默认预算即可。

## 防止成分股未来数据

[成分股接口](https://www.baostock.com/mainContent?file=hs300Stock.md)按周更新。按每个查询日期保存300只成员、updateDate和来源，更新日期晚于查询日期或成员数量不符即停止。保守假设更新日收盘后才可得：刷新当天禁止新开仓，次日开盘才应用新的名单。接口的周粒度不能替代指数公司逐事件的准确生效与公告时间；报告明示这一边界。未来的成员名单不能改变之前的信号。

## 公司行动与因子

[K线接口](https://www.baostock.com/mainContent?file=stockKData.md)的preclose在除权日为交易所除权参考价，成交量为股；分钟线没有历史ST，需从独立日线读取isST与tradestatus。

[因子接口](https://www.baostock.com/mainContent?file=factorInfo.md)用于校验事件日期和后复权因子的相对变化。连续因子按前日原始收盘 / 当日参考价在事件生效日累积，未来因子不回写过去价格。供应商整体前复权尺度可能依赖后续事件，不直接作为历史信号输入。

股息及送转须有实施公告、登记、除权、派息、红股上市日期和每股金额/股数。交易所参考价还须与现金及送转比例相符；因子有事件而缺少账务、漏报配股、未知重组、缺少付款日期等均阻止正式回测。资料声明“完整”不代表供应商一定无漏报，服务端同时检查实际日期覆盖、分钟根数与日线一致性。

配股尚不支持资金认购账务，遇到配股阻止正式回测，不默认外部注资。股息默认税前，不计算个人持有期补税；送转零股逐权益向下取整，不虚构补偿。供应商停牌日无分钟时，只作独立日线估值点，无虚构成交。

## 定时执行（当前未启用）

采集器支持独立于浏览器运行的systemd定时器。把项目放在 `/opt/ashare-lab`，配置 `/etc/ashare-lab/sync.env`（权限0600）：

```text
ASHARE_PROVIDER=baostock
ASHARE_HISTORY_FROM=2023-01-01
ASHARE_POOL=collector/pool.json
ASHARE_HS300_HISTORY=1
```

可从 `pool.example.json`复制所需标的；不限定股票时在任务中传 `--hs300-history` 且去掉 `--pool`。`ASHARE_HS300_HISTORY=1` 启用历史池检查，默认主数据源BaoStock。systemd文件路径相对于项目根，定时器于北京时间工作日16:30运行，Persistent=true允许恢复后补跑；节假日不产生交易数据。

```bash
sudo cp collector/ashare-sync.service collector/ashare-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ashare-sync.timer
systemctl list-timers ashare-sync.timer
journalctl -u ashare-sync.service
```

运行后需以日志、请求预算、最新数据日期和服务端缺口报告验收，不能只看任务已启用。当前没有安装或启用这一任务。

如需自动写入私有Site，须在主机环境配置 `ASHARE_SITE` 为本人站点根地址和 `SITES_SERVICE_TOKEN` 为平台授权的本人私有Site服务访问凭据。上传发送 `OAI-Sites-Authorization`，只发往指定HTTPS Site，凭据不进浏览器、源码或行情文件。当前无需设置即可本地采集、手工上传JSON；无人值守上传尚未在用户主机验收。

## 可选来源

AkShare新浪/东方财富仅作近期分钟补充，已验证此次约41/31个交易日，不能保证任意长历史。东财成交量“手”统一乘100，新浪/SDK按“股”。

理杏仁仅实现已确认的官方日线端点，需要 `LIXINGER_TOKEN` 环境变量与相应权限；不声称可提供分钟历史。

```bash
collector/.venv/bin/python collector/sync.py --symbols 600519 --board main --from 2023-01-01 --to 2026-09-30 --lixinger-daily
```

密钥只配置在主机环境，不要发到聊天，不要放进JSON、日志或源码。
