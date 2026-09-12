# 数据来源与字段

数据截至 2026-08-31；市场数据检索 2026-09-11，估值锚点价格核对 2026-09-12。仓库保存计算所用的月末观察、1985 年起的含息回填，以及少量推导出的相对市盈率锚点。不自动更新。

## 覆盖与状态（`history.json` 的 `coverage`）

含息序列是月收益，第一个收益月为 1985-02；点位序列从 1985-01 起。

| 序列 id | 区间 | 状态 | source_id | 来源 |
|---|---|---|---|---|
| NDX 纳指100 价格 | 1985-01～2026-08 | 实测 observed | `nasdaq_ndx` | Nasdaq 官网 NDX 历史 |
| SPX 标普500 价格 | 1985-01～2016-08 | 实测 | `crsp_spindx` | CRSP `spindx` 教学公开副本，日度取月末 |
|  | 2016-09～2026-08 | 实测 | `fred_sp500` | FRED SP500 日收盘取月末 |
| NDX_TR 纳指100 含息 | 1985-02～1999-03 | 估算 estimated | `nasdaq_div_sec` | 价格月收益 + 年末股息率按月平摊（下文） |
|  | 1999-04～2026-08 | 实测 | `nasdaq_xndx` | Nasdaq 官网 XNDX 历史 |
| SPX_TR 标普500 含息 | 1985-02～1988-01 | 构建 constructed | `spx_tr_backfill` | 价格 × CRSP 股息时点，按年校准（下文） |
|  | 1988-02～2026-08 | 实测 | `yahoo_sp500tr` | Yahoo `^SP500TR` 月末（GitHub 快照；2026 年取 Yahoo 日收盘） |
| RF 无风险利率 | 1985-01～2026-07 | 实测 | `french_rf` | French 1个月国库券 |
|  | 2026-08 | 估算 | `rf_estimate` | FRED DTB4WK 暂估（下文） |
| UST 10年美债 | 1985-01～2026-08 | 模型 model | `fred_dgs10` | DGS10 月末收益率 → 平价10年债模型 |

引擎含息口径：纳指100 = `ndx_tr ?? (ndx_pr + ndx_div_<档>)`；标普500 = `spx_tr ?? spx_tr_con`；10年美债 = `bond_tr`。价格口径：`ndx_pr`、`spx_pr`、`bond_pr`。股息预扣税 t：股票月收益减 t ×（含息 − 价格）。

## 纳指100

- [NDX 历史](https://indexes.nasdaq.com/Index/History/NDX)、[XNDX 历史](https://indexes.nasdaq.com/Index/History/XNDX)。接口：POST `https://indexes.nasdaq.com/Index/HistoryChartData`，表单 `id=NDX|XNDX`、`startDate=1985-01-01`；取 `x`（UTC 毫秒）与 `y`（收盘）。2012-10-29 两序列为 0，剔除（非月末，不插值）。
- [指数版本说明](https://indexes.nasdaq.com/docs/NDX%20Versions.pdf)：NDX 基值日 1985-01-31，XNDX 1999-03-04。[XNDX 1985–1999 Excel 请求](https://indexes.nasdaq.com/Index/ExportHistory/XNDX?startDate=1985-01-01&endDate=1999-03-31&timeOfDay=EOD) 只返回 1999-03-04 起 20 行。
- 与旧 FRED 价格快照有 30 个月差异 > 0.011 点（集中在 2003–2005），采用官网值；官网 1985–2006 年末与 [2007 年 QQQ 招股书表](https://www.sec.gov/Archives/edgar/data/1067839/000120677407000760/nasdaq_485bpos.htm) 22 个点相差 ≤ 0.01 点。

## 标普500

- 价格：[CRSP 教学公开副本](https://lukestein-classes.github.io/fdap/data/sp500d.csv)（`spindx`）至 2016-08；[FRED SP500](https://fred.stlouisfed.org/series/SP500) 自 2016-09。
- 含息：[Yahoo `^SP500TR` 月末 GitHub 快照](https://github.com/vanexymx/sp500-historical-analysis/blob/main/data/SP500TR_monthly.json)，点位自 1988-01（二手副本，非 S&P 官方导出）。2026 年用 Yahoo 原始日收盘取月末（8 月末 17219.939453125，7 月末 16763.419921875），与 State Street SSTTX 公布的截至 2026-08-31 基准 1/3/6 个月、QTD、YTD 收益 2.72%、1.68%、12.37%、2.66%、13.14% 吻合；旧快照的“2026-07”实为 7 月 22 日，未用。

## 国债与无风险利率

- [FRED DGS10](https://fred.stlouisfed.org/series/DGS10)：每月最后有效观测（不用月均）。模型（[Swinkels 数据集第 6 版](https://doi.org/10.25397/eur.8152748) improved 方法，[文件](https://ndownloader.figshare.com/files/38737083)）：`D = (1 + y/2)^(−2·(10 − 1/12))`，`bond_pr = (y_prev/y)(1 − D) + D − 1`，`coupon = y_prev/12`，`bond_tr = bond_pr + coupon`。
- [French RF](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/f-f_factors.html)：1个月国库券月收益，百分数 ÷ 100；至 2024-05 为 Ibbotson，2024-06 起为 ICE BofA US 1-Month Treasury Bill Index。
- **2026-08 RF 暂估** 0.003135634805128351 = `1/(1 − 0.0363 × 31/360) − 1`，[DTB4WK](https://fred.stlouisfed.org/series/DTB4WK) 2026-07-31 银行折价年率 3.63%，31 天合成到期券；同法对 2026-01～07 French 值平均绝对差 1.21bp、最大 2.36bp。原始追加文件中 8 月 RF 为空，由 `scripts/extend_202608.py --use-estimated-rf` 显式写入；CSV `RF_status=estimated`，`quality_notes` 与 [data_quality.json](sources/data_quality.json) 标注。依据：[estimated_rf_aug2026.json](sources/extension_202608/estimated_rf_aug2026.json)。French 发布后重建数据。

## 1985 年起的含息回填（[backfill_1985/README.md](sources/backfill_1985/README.md)）

- **纳指100 股息（估算）** `ndx_div_default/low/high`，1985-02～1999-03（170 个月）：QQQ SEC 文件中 Nasdaq 公布的年末股息率（全年现金股息 ÷ 年末成分股总市值；1986 0.33% … 1998 0.07%），`d_m = (y_Y/100 × NDX_Dec(Y)/12) / NDX_(m−1)`。1985 年未公布，假设同 1986；低/高档 ×0.75 / ×1.25。1999–2006 验证：XNDX 实测 / 估算合并 0.835。`python3 scripts/backfill/ndx_dividends.py` 逐字节复现 CSV。
- **标普500 含息（构建）** `spx_tr_con`，1985-02～1988-01（36 个月）：`TR_m = (1 + PR_m)(1 + k_Y·DIV_m) − 1`，`DIV_m` 为 CRSP 日度 `(1+vwretd)/(1+vwretx) − 1` 月内连乘，`k_Y` 使年度总回报等于 31.73% / 18.67% / 5.25%（1985/86/87，误差 < 1e-12 个百分点）；点位由 SPXTR 1988-01 = 257.47 反向链接，1988-01 月收益 = 257.47/247.08 − 1。方法对 SPXTR 1988-02～2024-12 跟踪误差 0.081%/年。
- 未提交：CRSP 日度文件与 scipy 校准脚本；`build_data.py` 断言年度校准、1988-01 衔接、与实测不重叠、股息分量非负。

## 相对市盈率锚点（`docs/data/valuation.json`，[valuation/README.md](sources/valuation/README.md)）

`M = 纳指100 市盈率 ÷ 标普500 市盈率`（彭博 PE_RATIO 口径）；`R = 纳指100/标普500 价格比`；相对EPS = `R / M`。

| 层级 | 月份 → M | 说明 |
|---|---|---|
| `bbg_label` 实测·彭博 | 2026-08 → 1.4148 | 2026-09-10 标签 37.05 ÷ 26.18 = 1.4152，按 FRED 收盘调整到月末：`M × R(08-31)/R(09-10)`，假设期间 TTM EPS 不变 |
| `bbg_chart` 实测·彭博 | 2004-12 → 1.6997；2014-12 → 1.3432；2024-12 → 1.3531 | 用户彭博相对市盈率图季末读数 |
| `bridge` 估算 | 1985-01 → 2.0143；1994-12 → 1.7639；2004-12 → 1.6944 | BetaShares 2016 顾问材料 NDX 市盈率图 ÷ Shiller 标普500 市盈率，`M = M_raw × e^0.14`（2003–2015 重叠期对彭博口径的对数差） |
| `estimate` 估算区间 | 1985-01 → 1.8～2.5 | 彭博口径 p10～p90；中值 = bridge 1985-01 |

分段：d1985、d1995 为 bridge→bridge；d2005、d2015 为 bbg_chart→bbg_chart；d2025 为 bbg_chart→bbg_label。相邻分段只在 2004-12 换层级（bridge→bbg_chart），十年分段相加与全期（1985-01 中值 → 2026-08）的市盈率项相差 +0.31 对数点（口径拼接差，`build_data.py` 断言 ≤ 2）。FRED 原始下载：`sources/valuation/fred_NASDAQ100_…csv`、`fred_SP500_…csv`。

## 字段（`docs/data/history.json` `observations`，500 行 1985-01～2026-08）

| 字段 | 含义 |
|---|---|
| month | YYYY-MM 月末 |
| NDX / SPX | 价格指数点位 |
| XNDX / SPXTR | 含息指数点位；缺失为 null |
| ndx_pr / spx_pr | 价格月收益（小数） |
| ndx_tr / spx_tr | 实测含息月收益 |
| ndx_div_default / _low / _high | 纳指100 估算月股息收益，仅 1985-02～1999-03 |
| spx_tr_con | 标普500 构建含息月收益，仅 1985-02～1988-01 |
| bond_pr / bond_tr / coupon | 模型国债价格 / 含票息月收益；coupon = 上月末 DGS10/12 |
| RF | 1个月国库券月收益 |
| dgs10_pct | 月末 DGS10（百分数） |

顶层：`schemaVersion: 2`、`as_of`、`retrieved`、`coverage`、`sources`（按 id）、`quality_notes`（RF 暂估按 `month`；回填按 `from`/`to`）。`monthly_history.csv` 另含 `RF_status`、回填列、`ndx_tr_ext`/`spx_tr_ext`（默认档含息月收益）与 `ndx_tr_status`/`spx_tr_status`。v1 字段 1985-01～2025-12 数值与 schemaVersion 1 逐项一致（`tests/data.test.js` 哈希校验）。

## 重建与校验

- `python3 scripts/build_data.py`（仅标准库，幂等）：由 `data/sources/**` 生成 `history.json`、`monthly_history.csv`、`valuation.json`、`data/manifest.json`（`data/sources`、`docs/data` 全部文件字节数与 SHA256）。
- 数据变更后必须重跑 `python3 scripts/validation/crosscheck_v2.py`，否则 `tests/crosscheck.test.js` 因输入哈希不符失败。
- 原始月末观察：[nasdaq_monthly.csv](sources/nasdaq_monthly.csv)、[sp500_treasury_monthly.csv](sources/sp500_treasury_monthly.csv)（含实际观察日期；各资产独立采样）；2026 年增量与审计：[extension_202608/](sources/extension_202608/)。

## 许可

- 指数、交易所、FRED、French、Yahoo 数据权利归各来源；本项目不新增许可，不担保再分发权。
- SEC EDGAR 公开文件；CRSP 仅用教学公开副本，仓库只存 36 个月派生点位；Wikipedia、Berkshire、SBBI、Damodaran 只作校准目标或对照。
- 彭博与 BetaShares 材料：仅发布 7 个推导比值与 2 个市盈率标签，不保存任何月度供应商序列；BetaShares 材料标注不得分发，不在仓库中。
