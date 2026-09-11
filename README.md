# Index Portfolio

纳斯达克100、标普500与10年期美国国债的历史配置研究。

**网站：[hzhan7.github.io/Index-Portfolio](https://hzhan7.github.io/Index-Portfolio/)**

## 可以比较什么

- 任意月末起点、终点，至少12个完整月。
- 股票股息再投资与美债票息两个独立开关。
- 五个目标：最高夏普；CAGR不低于标普时最高夏普；CAGR等于标普时最高夏普；夏普不低于标普时最高CAGR；夏普等于标普时最高CAGR。
- 两张联动配比曲面、CAGR/夏普散点与近似有效边界、任意配比滑块、组合对照表。
- 固定终点改变起点，以及5/10/15/20年滚动窗口；每个窗口单独计算事后最优配置。

## 1985与1999：两种真实可用的数据范围

| 数据 | 月末点位范围 | 可计算的完整月收益 |
|---|---|---|
| NDX价格 | 1985-01至2025-12 | 1985-02至2025-12，491个月 |
| SPX价格 | 1985-01至2025-12 | 1985-02至2025-12，491个月 |
| XNDX含息 | 1999-03至2025-12 | 1999-04至2025-12，321个月 |
| SPXTR含息 | 1988-01至2025-12 | 1988-02至2025-12，455个月 |
| 10年期美债模型、无风险收益 | 1985-01至2025-12 | 回测时按股票共同区间选择 |

默认从**1985-01-31**开始，**股票不含股息、美债含票息**。这是最长可核验价格样本，不是全资产含息回报。打开股票股息选项后，共同起点设为**1999-03-31**；页面和日期控件会明确显示变化。1985–1999年缺失的XNDX没有用价格、年末股息率或ETF代理拼接。

2026-09-11重新向Nasdaq官方历史JSON请求1985起的NDX和XNDX；XNDX第一条仍为1999-03-04。另向官方Excel导出请求1985-01-01至1999-03-31，也只返回1999-03-04后的记录。该结论仅针对本次实际取得的公开数据，**不等于所有供应商都不存在更早的授权回溯序列**。

日期是月末净值端点。例如1985-01→2025-12，收益行取1985-02至2025-12；不会把起始月已有的RF或国债回报多算一次。各资产先独立取各自月份最后有效观测，再按月份对齐。

## 计算口径

美元计价，非负权重合计100%，无杠杆、固定权重、每月末再平衡。不扣交易成本、管理费和税费。关闭股息或票息仅用于拆解收益来源，不能把该结果称为完整投资收益。

```
r_portfolio[t] = sum(weight[i] * monthly_return[i,t])
CAGR = exp(12 * mean(log(1 + r_portfolio))) - 1
Sharpe = sqrt(12) * mean(r_portfolio - RF) / std(r_portfolio - RF, ddof=1)
Volatility = sqrt(12) * std(r_portfolio, ddof=1)
Max drawdown = min(wealth / running_peak - 1), including initial wealth = 1
```

最大回撤基于月末观察，不是日内或日度最大回撤。RF使用French数据中的实际一个月国库券收益，**不使用十年期国债收益率作为无风险收益**。历史高利率阶段和低利率阶段使用各自同期RF。

10年期国债采用Swinkels第6版数据中的改进模型，月末DGS10年度收益率先除100得到小数。令上一月收益率为`yp`，本月为`y`：

```
d = (1 + y/2)^(-2*(10 - 1/12))
coupon = yp/12
bond_price = (yp/y)*(1-d) + d - 1
bond_total = bond_price + coupon
```

模型表示买入平价10年期国债、持有一个月、重估剩余现金流后滚动回10年期限。它不是直接观察的国债指数或ETF，也未完整模拟曲线滚降、真实付息日和交易成本。与作者1985–2022年456个月结果的最大差为3.33e-16；2023年后按同一公式延长。

曲面和近似有效边界采用2个百分点权重网格；任意选择点的指标直接用月度收益重算。优化器使用条件解析解/二分法及外层扫描与多个局部细化；结果为确定性数值搜索，不宣称对每个任意样本都有严格全局最优认证。等式与不等式目标独立求解，不能互为别名。

所有权重都是**样本内事后优化**。起点敏感性和滚动窗口不构成样本外策略，重叠窗口也不是独立样本。初始默认配置不代表未来建议持仓。

## 历史数据与可复算文件

| 文件 | 内容 |
|---|---|
| [docs/data/monthly_history.csv](docs/data/monthly_history.csv) | 可下载的492个月历史：指数点位、价格/含息月回报、RF、票息、DGS10 |
| [docs/data/history.json](docs/data/history.json) | 网站实际读取的数据；缺失值为null，不是0 |
| [data/sources/nasdaq_monthly.csv](data/sources/nasdaq_monthly.csv) | Nasdaq官网月末原始观察值与观察日期 |
| [data/sources/sp500_treasury_monthly.csv](data/sources/sp500_treasury_monthly.csv) | SPX/SPXTR月末值、RF、DGS10及来源标识 |
| [data/SOURCES.md](data/SOURCES.md) | 来源、覆盖、数据差异及字段说明 |
| [data/manifest.json](data/manifest.json) | 已保存数据的SHA256 |
| [data/validation/reference_results.json](data/validation/reference_results.json) | 五个代表性样本、每样本五个优化目标 |
| [data/validation/scipy_crosscheck.json](data/validation/scipy_crosscheck.json) | 独立SciPy多起点验证结果 |

数据固定截至2025年12月，检索日期2026年9月11日，不自动更新。股票指数、交易所及第三方数据的权利仍归各来源所有；本项目没有为来源数据新增许可或担保其商业再分发权。参考研究文件不包含在此仓库中。

## 本地运行与复算

静态站，无构建依赖；D3固定为7.9.0并保存在仓库中，不依赖运行时CDN。

```sh
python3 -m http.server 8127 --directory docs
```

用Python标准库从保存的月末观察重建网站数据：

```sh
python3 scripts/build_data.py
```

用Node复算所有目标：

```sh
node scripts/calculate-portfolios.mjs --start 1985-01 --end 2025-12 --stocksIncome false --bondIncome true --objective all
node scripts/calculate-portfolios.mjs --start 1999-03 --end 2025-12 --stocksIncome true --bondIncome true --objective all
npm run check
npm test
```

GitHub Pages从`main`分支的`/docs`目录发布。仓库代码与网站数据同时版本管理。
