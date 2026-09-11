# 数据来源与字段

检索：2026-09-11。网站截止：2025-12-31。仅保存本次计算所用的公开月度市场数据及派生结果。

## Nasdaq-100

- [NDX官网历史](https://indexes.nasdaq.com/Index/History/NDX)，[XNDX官网历史](https://indexes.nasdaq.com/Index/History/XNDX)。页面公开接口：POST `https://indexes.nasdaq.com/Index/HistoryChartData`，表单为`id=NDX`或`XNDX`、`startDate=1985-01-01`、`endDate=2025-12-31`。
- [XNDX早期历史Excel请求](https://indexes.nasdaq.com/Index/ExportHistory/XNDX?startDate=1985-01-01&endDate=1999-03-31&timeOfDay=EOD)实际只返回1999-03-04及以后20行。
- [官方指数版本说明](https://indexes.nasdaq.com/docs/NDX%20Versions.pdf)：NDX价格版本Base Value Date为1985-01-31，XNDX总回报版本为1999-03-04。基值日期不替代对实际历史数据的核验。
- 从接口`x`的UTC毫秒日期和`y`的收盘水平取数据。2012-10-29两序列均有0值，排除该异常观测；未做插值，该日也不是月末。
- 与旧FRED价格快照存在30个月超过0.011点的差异，集中在2003–2005；本网站采用官网新数据。官网1985–2006年末与[2007年QQQ招股书中的Nasdaq表](https://www.sec.gov/Archives/edgar/data/1067839/000120677407000760/nasdaq_485bpos.htm)22个点的差异不超过0.01点。XNDX与FRED差异仅为保留两位小数的精度级别。

## S&P 500

- 早期价格：[CRSP数据教学公开副本](https://lukestein-classes.github.io/fdap/data/sp500d.csv)，使用`spindx`，从日度记录独立取月末。近期价格：[FRED SP500](https://fred.stlouisfed.org/series/SP500)，从2016-09起覆盖。
- 含息：[Yahoo ^SP500TR历史的GitHub月末快照](https://github.com/vanexymx/sp500-historical-analysis/blob/main/data/SP500TR_monthly.json)。原始点位从1988-01起；这是二手副本，不是S&P官方直接导出。1985–1987不填值。

## 国债与无风险收益

- [Federal Reserve / FRED DGS10](https://fred.stlouisfed.org/series/DGS10)，取每月最后有效观测，不使用月均收益率。
- [Swinkels数据集](https://doi.org/10.25397/eur.8152748)，使用2023-01-10第6版ODS中的improved方法；[第6版文件](https://ndownloader.figshare.com/files/38737083)。[2019年论文](https://repub.eur.nl/pub/120274/Repub_120274_O-A.pdf)介绍早期方法，不将两版公式混称同一版。
- [French因子数据定义](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/f-f_factors.html)：RF为1个月国库券收益，原始百分数除100。至2024-05来源为Ibbotson；2024-06起为ICE BofA US 1-Month Treasury Bill Index。

## 网站历史字段

| 字段 | 单位 / 含义 |
|---|---|
| month | YYYY-MM，月末观察标签 |
| NDX / SPX | 股票价格指数点位 |
| XNDX / SPXTR | 股息再投资总回报指数点位；缺失留空 |
| ndx_pr / spx_pr | 股票价格月收益，小数 |
| ndx_tr / spx_tr | 股票含股息月收益，小数 |
| bond_tr | 模型国债含票息月收益，小数 |
| bond_pr | 模型国债不含票息月收益，小数 |
| coupon | 上月末年化DGS10（小数）/12，小数月收益 |
| RF | 同期1个月国库券收益，小数月收益 |
| dgs10_pct | 月末10年期国债年化收益率，百分数 |

原始月末观察文件还保留实际收盘/收益率日期。各资产独立采样，不要求股票交易日与国债报价日完全一致。

`scripts/build_data.py`重新从月末点位计算股票月收益，并从DGS10计算国债收益；不会直接信任旧收益列。历史数据文件以SHA256记录版本，独立优化验证记录对应输入哈希。
