# Index Portfolio

纳斯达克100、标普500与10年期美国国债的历史配置研究。

**网站：[hzhan7.github.io/Index-Portfolio](https://hzhan7.github.io/Index-Portfolio/)**

## 可以比较什么

- 任意月末起点、终点，至少12个完整月。
- 股票股息再投资与美债票息两个独立开关。
- 新增三个有效前沿目标：经典切点、波动率预算、收益减去风险惩罚；另保留五个历史CAGR/夏普对标目标。
- 预期收益可取历史算术均值或自定义；切线截距可取样本短债收益均值或自定义收益门槛。
- 经典收益—总波动率有效前沿，联动显示切线、等效用曲线或风险预算线；模型预期收益与实现CAGR分开显示。
- 两张联动配比曲面、CAGR/夏普散点与近似有效边界、任意配比滑块、组合对照表。
- 固定终点改变起点，以及5/10/15/20年滚动窗口；每个窗口单独计算事后最优配置。

## 1985与1999：两种真实可用的数据范围

| 数据 | 月末点位范围 | 可计算的完整月收益 |
|---|---|---|
| NDX价格 | 1985-01至2026-08 | 1985-02至2026-08，499个月 |
| SPX价格 | 1985-01至2026-08 | 1985-02至2026-08，499个月 |
| XNDX含息 | 1999-03至2026-08 | 1999-04至2026-08，329个月 |
| SPXTR含息 | 1988-01至2026-08 | 1988-02至2026-08，463个月 |
| 10年期美债模型 | 1985-01至2026-08 | 沿用原收益公式 |
| 无风险收益 | 正式值至2026-07；2026-08暂估 | 暂估月份明确标记，不冒充正式数据 |

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

## 新增：有效前沿与最优点

前沿横轴为年化总波动率，纵轴为年化**算术预期收益**，不是CAGR。默认使用`mu = 12 × mean(monthly returns)`和`Sigma = 12 × sample covariance(monthly returns)`；也可自定义三项资产的年化预期收益。自定义预期只改变模型的均值假设，不修改历史收益，也不改变历史样本估计的协方差。

| 目标 | 定义 | 参数 |
|---|---|---|
| 切点组合 | 最大化 `(mu_p - anchor) / sigma_p` | 默认固定截距为`12 × mean(monthly RF)`；可自定义 |
| 风险预算 | 最大化`mu_p`，约束`sigma_p <= cap` | 默认上限为同样本同口径SPX波动，可自定义 |
| 风险偏好 | 最大化`mu_p - gamma * sigma_p² / 2` | gamma越大越重视降低波动；初始5仅为演示偏好 |

切点模式是页面新增的默认目标。最大斜率切点与旧“历史最高夏普”定义接近但不完全相同：前者分母用总收益波动，后者分母用每月扣除同期RF后的差额收益波动；RF跨期变化时两者不同。改变截距只影响切点，不影响风险预算或风险偏好模式。

自定义收益门槛仅是几何截距，**不是无风险利率，也不是`mu >= target`约束**。若三项预期收益均不高于截距，不显示正风险溢价切点；波动率上限低于全局最小方差组合时明确显示无解，不以100%标普假装最优。

短债只是图线的出发点，没有加入第四项持仓；线上需要现金混合或融资的点不是本产品可执行的三资产组合。10年期美债仍有价格风险。风险偏好模式画`mu=U+gamma*sigma²/2`的等效用曲线；风险预算模式画波动上限。高效前沿采用非负单纯形七个非空面的解析/线性方程求解，按给定收益求最小方差，不用散点网格冒充精确前沿。

集中解有时合理，程序不通过暗设权重上限来强迫分散。自定义预期与历史均值都不是可靠预测保证，应使用日期、风险参数和预期收益输入检查敏感性；改变预测后，页面仍对新权重的历史CAGR、历史夏普与回撤单独复算。滚动窗口默认在各窗口重新估计均值、协方差和短债参考；自定义预期/截距/预算则在各窗口保持相同参数。这不是样本外回测。

独立验证覆盖11个场景、43个目标和1111个前沿点，与SciPy多起点求解对照；[验证文件](data/validation/mean_variance_crosscheck.json)。

模型定义参考：[CFA：Portfolio Risk and Return](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/portfolio-risk-return-part-1)、[William Sharpe：Portfolio Choice](https://web.stanford.edu/~wfsharpe/mia/rr/mia_rr2.htm)、[William Sharpe：The Sharpe Ratio (1994)](https://web.stanford.edu/~wfsharpe/art/sr/sr.htm)。

## 历史数据与可复算文件

| 文件 | 内容 |
|---|---|
| [docs/data/monthly_history.csv](docs/data/monthly_history.csv) | 可下载的500个月历史：指数点位、价格/含息月回报、RF、票息、DGS10与RF_status |
| [docs/data/history.json](docs/data/history.json) | 网站实际读取的数据；缺失值为null，不是0 |
| [data/sources/nasdaq_monthly.csv](data/sources/nasdaq_monthly.csv) | Nasdaq官网月末原始观察值与观察日期 |
| [data/sources/sp500_treasury_monthly.csv](data/sources/sp500_treasury_monthly.csv) | SPX/SPXTR月末值、RF、DGS10及来源标识 |
| [data/SOURCES.md](data/SOURCES.md) | 来源、覆盖、数据差异及字段说明 |
| [data/manifest.json](data/manifest.json) | 已保存数据的SHA256 |
| [data/validation/reference_results.json](data/validation/reference_results.json) | 五个代表性样本、每样本五个优化目标 |
| [data/validation/scipy_crosscheck.json](data/validation/scipy_crosscheck.json) | 独立SciPy多起点验证结果 |

数据固定截至2026年8月，检索日期2026年9月11日，不自动更新。2025年及以前的492个月原观察数值逐项保留。股票指数、交易所及第三方数据的权利仍归各来源所有；本项目没有为来源数据新增许可或担保其商业再分发权。参考研究文件不包含在此仓库中。

**8月RF是暂估值。** French美国及国际官方文件均只到2026年7月，本次没有取得8月实际GBOM回报。8月暂用7月31日DTB4WK折价年率3.63%，假设一张31天合成到期券：`RF = 1/(1-0.0363*31/360)-1 = 0.003135634805128351`（0.31356348%月收益）。这不是实际指数回报；未把利率直接当月收益，未用7月RF平填。页面、CSV的`RF_status=estimated`及JSON的`quality_notes`均标明。原始追加文件中8月正式RF仍为空，暂估仅通过显式参数`--use-estimated-rf`应用。依据与前七月误差检验见[data/sources/extension_202608/estimated_rf_aug2026.json](data/sources/extension_202608/estimated_rf_aug2026.json)。

2026年SPXTR改用Yahoo原始日数据取真实月末，并以State Street公布的标普基准1/3/6月、QTD及YTD收益交叉核验。旧公开副本的2026-07值实际停在7月22日，本次未采用。完整新增来源保存在[data/sources/extension_202608](data/sources/extension_202608)。

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
node scripts/calculate-portfolios.mjs --start 1985-01 --end 2026-08 --stocksIncome false --bondIncome true --objective all
node scripts/calculate-portfolios.mjs --start 1999-03 --end 2026-08 --stocksIncome true --bondIncome true --objective all
node scripts/calculate-frontier.mjs --start 1999-03 --end 2026-08 --equity-income true --bond-income true
node scripts/calculate-frontier.mjs --start 1999-03 --end 2026-08 --equity-income true --expected-percent 10,8,4 --anchor-percent 3 --vol-percent 12 --gamma 5
npm run check
npm test
```

GitHub Pages从`main`分支的`/docs`目录发布。仓库代码与网站数据同时版本管理。
