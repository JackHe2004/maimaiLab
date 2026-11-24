# maimai Lab 架构

## 运行结构

```text
浏览器（Next.js 界面）
  │ GET 曲库 / GET 地区成绩 / POST 结构化成绩
  ▼
Next.js Route Handlers
  ├── DXRating dxdata（公共 JSON，ETag 再验证）
  └── PostgreSQL（本地 PGlite 或 DATABASE_URL）
         ├── catalog_cache
         └── scores
浏览器按需直接读取 DXRating 曲绘
```

Next.js App Router、React 和 TypeScript 共用地区、谱面及成绩数据模型。Route Handlers 负责曲库同步、成绩校验和持久化。浏览器做本地 HTML 解析、导入预览以及基于当前视图计算的 B50 和推分。RDBMS 使用同一套 SQL，默认 PGlite，配置 `DATABASE_URL` 后交给 PostgreSQL 服务。当前用户身份是这台机上的单个本地资料库，地区独立隔离。

界面配色集中在 `app/styles.css`。奶油白是主区背景，深茶绿用于侧栏和正文，抹茶绿与浅草绿用于主按钮和选中导航。谱面难度保留各自颜色，并针对浅底调深。色板参考 [Mori 品牌配色](https://joisti.com/mori/color)。

## 数据来源

| 数据 | 来源 | 策略 |
|---|---|---|
| 歌曲、别名、谱面、等级、定数、收录、版本 | [DXRating dxdata](https://miruku.dxrating.net/api/v1/dxdata) | 版本 1 JSON，按公开结构校验，写入 PostgreSQL。每 12 小时按需再验证，也能手动同步。带 ETag 时用 If-None-Match。上游异常时使用最后一次成功同步的快照并提示。 |
| 曲绘 | DXRating 歌曲级 `imageName` | `https://shama.dxrating.net/images/cover/v2/{imageName}.jpg`。只接受 64 位十六进制图片名。图片延迟加载，失败显示占位图。链接格式取自 DXRating 歌曲页。 |
| 玩家成绩 | 用户保存的 maimai DX NET 成绩页，或手动填写 | 本地解析和预览，通过谱面 ID 保存。 |
| 样本分布 | MaiShift 北美视图（国际服共享样本） | 配置服务端 API Key 后在 B50 自动展示。 |

`dsng_…` 表示歌曲，`dsht_…` 表示谱面。同一首歌的谱面共享曲绘。按 DXRating `serverIds` 检查地区收录，并用 `serverOverrides` 决定该地区的等级和定数。版本按下述规则核验。北美玩家地区映射到 DXRating `usa`，另支持 `intl`、`jp` 和 `cn`。本地成绩、B50 和涨分候选都使用玩家地区。宴会场和特殊谱面暂不进入成绩和 Rating 流程。

每次曲库同步会对 DXRating 的常规曲目按地区、歌曲、谱面类型（DX／STANDARD）全量核验。单首歌的 DX 各难度共用 DX 首发版本，STANDARD 各难度共用 STANDARD 首发版本。同一首歌的这两组可以属于不同版本，B35／B15 归类也分别计算。MaiShift 提供北美／国际共用曲库和日服曲库；国服对照 [SaltMeta 地区目录](https://github.com/realtvop/SaltMeta)。匹配依据为曲名和谱面类型，必要时用曲师消歧。国服对照目录按同类型可识别的最早地区版本归类。匹配不到时保留 DXRating 地区信息，同一组有多个标签时采用可确定的首发标签。与单张谱面地区版本存在冲突时记录冲突，使用该类型参考目录的首发版本。手动同步尝试重新读取参考目录，日常打开复用 24 小时缓存，上游不可用时可沿用已保存的参考。

「地区版本核验」在曲库按当前地区展示歌曲类型组数。曲库、B35／B15 和推分共用校正后的地区谱面数据，当前机台版本优先使用 MaiShift 的地区版本目录。

DXRating 归属和使用说明见[开发者文档](https://dxrating.net/zh-hant/developers)。曲绘的权利归 SEGA 和相应权利人。

## MaiShift 北美视图

B50 可以读取 MaiShift 北美视图下的国际服共享样本。根据 [MaiShift 开发者文档](https://maimai.shiftpsh.com/en%40na/developers)，`region=na` 对应北美机台视图，常规统计与国际服共用样本。成绩分布请求均使用 `region=na`。曲库版本核验另外读取日服元数据。

1. 在 MaiShift 的 Settings → Developer 注册应用并签发 API Key，将其写入本地 `.env.local` 的 `MAISHIFT_API_KEY` 后重启服务。应用通过服务端的 `X-API-Key` 请求 [MaiShift API](https://maimai.shiftpsh.com/api/v1/openapi.json)，只发送显示等级和 Rating 区间等查询条件。
2. 服务端用 `/songs?region=na` 匹配 DXRating 谱面 ID 与 MaiShift 谱面 ID。匹配依据是曲名、谱面类型和难度，必要时用曲师消歧。没有唯一候选或北美机台不可选时跳过。
3. 按 MaiShift 显示等级分组请求 `/stats/level-charts`。13,000–14,000 使用 500 分段，14,000–16,000 使用 250 分段，16,000–17,000 使用 50 分段。区间左闭右开。目录在 PostgreSQL 缓存 24 小时，按等级和 Rating 区间的分布缓存 1 小时。受保护的小样本留空，限流后可重试。
4. 推分页按本地潜在 B50 涨分排序。共享分布用于 B50 卡片。

B50 卡片显示用户在该谱面的成绩评级。色阶用所选版本算出的 B50 Rating 定位区间，再按该谱面的同一评级统计有效样本占比。例如用户成绩为 SSS，分子是达成率从 100.0000% 到低于 100.5000% 的样本数。卡片保留原始占比，同时计算同 Rating 区间、同 MaiShift 精确定数、同评级的北美可玩谱面范围。范围包括 B50 以外的谱面，排除缺失或受保护的样本。相对值 = 100 ×（占比 − 最低占比）÷（最高占比 − 最低占比）。按相对值等分八档，最低档为深茶绿，最高档为浅绿。原始占比缺失时显示「暂无数据」，比较组不完整、没有差异或只有原始占比时，显示「相对 —」并保持中性色。按公开计数定义，SSS+ 可以用有效样本总数减去低于 100.5000% 的互斥分档之和，以包含被单独归类的 AP。上游只给出合并分档的评级，以及缺失或受保护的样本，都显示数据缺失。确认有样本且该评级无人取得时显示 0%。

### 本地分布文件

B50 页可以载入从可核实的纯北美玩家汇总整理出的 JSON。文件只在本次浏览器会话内使用。应用校验格式和声明的地区，数据提供方负责样本地域来源。手动文件仍要求纯北美样本，有匹配时优先于自动读取的共享样本。每行使用 DXRating 谱面 ID、评级、左闭右开的 Rating 区间、有效玩家人数和取得该评级的人数。重叠区间优先使用较窄区间。少于五人的统计不接受。格式示例中的数值是演示数据。

```json
{
  "source": "maishift",
  "sampleRegion": "north-america",
  "rows": [
    { "chartId": "dsht_23456789ab", "from": 16200, "to": 16250, "grade": "SSS", "players": 20, "count": 4 }
  ]
}
```

## HTML 导入

`lib/import-html.ts` 使用 parse5 读取静态结构，允许多份文件和手动粘贴。它只读取文本、类名、选中的难度和白名单图标名，解析过程中不执行脚本、不加载图片、不提交表单。上传的是结构化成绩 JSON。单次文件上限 40 MB，每份源码最多 1500 万字符。服务端写入每批最多 12000 行、3 MB。

- 用 `.music_name_block` 定位曲名和所在成绩卡片，支持含有 `w_450 m_15 p_r f_0` 的公开样式。
- 难度优先取当前卡片 `music_<difficulty>_score_back`。明确选中的 `select[name=diff]` 只做后备。0–4 对应 BASIC 至 Re:MASTER。
- 用曲谱图标文件名或已知行 ID 判断 STANDARD／DX，保留 `.music_lv_block` 的显示等级用于匹配检查。
- 从 `.music_score_block` 提取达成率及 DX Score 分子和分母。达成率存为百分比的一万分之一（`100.1234%` 存成 `1001234`）。评级、FC／AP、同步和 DX 星从白名单文件名映射，未知字段留空。
- 先限定所选玩家地区，再用曲名或别名、谱面类型与难度匹配。优先精确原曲名，显示等级用于消除候选歧义。匹配失败或无成绩的行显示原因并跳过。
- 新成绩按 `(region, chart_id)` 合并，保留最高达成率、独立最高 DX Score 和最强 Combo／Sync 徽章。DX Score 与其满分成对保存，Combo 和 Sync 作为谱面最佳状态。重复导入不会让旧成绩覆盖较高成绩。

实现参考 [myjian 的成绩采集器](https://gist.github.com/myjian/e161f14b5ab6319a006a221fbed87dd7) 和 [maimai.py 的解析器](https://api.maimai.turou.fun/maimai_py/utils/page_parser.html)。之前 ChatGPT 对话上传的私有附件当前不可读取。仓库测试使用合成 HTML，实际样本的精确字段覆盖有待该附件重新提供。

## B50 和推荐

日服、国际服和北美自 CiRCLE 起，B15 从所选机台版本及上一版中取最高的 15 张谱面，B35 从更早版本取最高的 35 张。此前版本和国服按所选版本划分新曲池。曲库的版本标签仍表示地区收录版本，推分和 B50 共用新曲池与门槛。版本默认值从地区实际收录谱面和 DXRating 版本顺序推断，界面支持手动调整。选择较旧版本时会排除后来推出的谱面，定数仍取当前地区目录。Rating 使用地区定数、整数达成率和阈值系数向下取整，达成率按 100.5% 封顶。按 DXRating 的计算器口径，AP 或 AP+ 增加 1。阈值边界见 `lib/rating.ts`，参考 [DXRating 算法说明](https://dxrating.net/rating)和[社区实测系数](https://sgimera.github.io/mai_RatingAnalyzer/maidx_rating.html)。此处展示的是本地导入成绩的估算值。

推荐用目标 Rating 减去目前的单曲 Rating 与对应分组门槛两者的较大值。有空位时门槛为零。只显示单谱面涨幅为正且尚未达到目标达成率的候选。目标可以选择 S 至 SSS+，默认 SSS。建议中的目标保留已录入的最佳 AP 徽章，但不假定未来会取得新的 AP。

## 本地接口与存储

| 接口 | 用途 |
|---|---|
| `GET /api/catalog` | 返回当前已验证曲库及是否使用了过期缓存。可加 `?refresh=1` 立即再验证。 |
| `GET /api/maishift?rating=16219&ids=…` | 返回共享样本中最多 50 张谱面的评级分布。 |
| `GET /api/scores?region=usa` | 读取单一玩家地区的本地成绩。 |
| `POST /api/scores` | 校验 `{region, scores}` 和谱面收录，用单条 PostgreSQL upsert 原子合并并返回该地区记录。 |

`catalog_cache` 保存曲库来源、ETag、JSON 和最后验证时间。`scores` 保存地区、谱面 ID、达成率、DX Score、评级和徽章。未收录的老成绩可保留在库中，只有当前地区收录的谱面进入计算。曲绘与曲库来源会收到网络请求。应用没有账号登录、第三方分析、会话回放、原始 HTML 上传或 SEGA 凭证处理。

## 布局验证

在内置浏览器按 CSS 视口测试曲库、导入成绩、我的 B50 和推分。使用实际曲库、单行合成导入预览、完整 B35/B15 和有结果的推分清单。检查页面横向溢出、成绩字段裁切、评级标签和卡片列数。

| 视口 | B35 / B15 卡片列数 |
|---|---|
| 320 × 793、390 × 844 | 2 / 2 |
| 768 × 1024 | 3 / 3 |
| 1024 × 900、1440 × 900 | 5 / 5 |
