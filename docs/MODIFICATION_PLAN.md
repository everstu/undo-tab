# Undo Tab 修改方案：按窗口隔离、最近关闭与历史记录

> 本文保留当前扩展的需求依据与实现约束；后续开发同时遵循根目录的 [AGENTS.md](../AGENTS.md)。
> 日期：2026-10-22。完成状态以当前代码和 [MANUAL_TESTS.md](MANUAL_TESTS.md) 中实际执行的验证记录为准。

## 1. 已确定的产品规则

| 项目 | 普通窗口 | 无痕窗口 |
| --- | --- | --- |
| 弹窗标签 | 最近关闭 / 历史记录 | 最近关闭 / 历史记录 |
| 可见范围 | 只展示普通数据 | 只展示本次无痕会话数据 |
| 最近关闭来源 | 扩展自行捕获普通标签关闭 | 扩展自行捕获无痕标签关闭 |
| 历史记录来源 | 查询 Chrome 自带历史，用户已确认 | 扩展自行记录无痕页面访问，用户已确认 |
| 最近关闭保存 | 本机持久保存 | 仅临时保存 |
| 历史记录保存 | 由 Chrome 管理，扩展不复制成持久历史 | 仅临时保存 |
| 最后一个无痕窗口关闭 | 普通数据不受影响 | 自动清空无痕最近关闭、访问历史及相关工作数据 |
| 恢复或打开目标 | 普通窗口 | 当前仍存在的无痕窗口 |

普通与无痕的记录不混存、不互查、不共享条数配额。去掉“普通记录 / 无痕记录”切换入口，去掉列表行中的普通/无痕来源徽标。弹窗内只切换“最近关闭 / 历史记录”。

所有当前打开的无痕窗口共用本次无痕会话的数据。关闭其中一个窗口、但仍有其他无痕窗口时保留；最后一个无痕窗口关闭后自动删除。最小化窗口、切换焦点、关闭弹窗都不触发删除。之后重新打开无痕窗口，必须是一份空的新会话。

默认每次打开弹窗显示“最近关闭”。不提供从普通弹窗查看无痕数据、或从无痕弹窗查看普通数据的功能。

## 2. 条数、宽度和保留规则

### 2.1 条数分别配置、分别计算

普通使用 normal.maxRecords；无痕最近关闭使用 incognito.recentMaxRecords，无痕历史记录使用 incognito.historyMaxRecords。三个值默认均为 500，允许 1–10000 的整数。无痕设置页提供两个输入框和各自的保存按钮，不提供模式切换器。

具体配额口径：

- 普通“最近关闭”：去重后最多保留 normal.maxRecords 个网址，超过后删除最旧项。
- 无痕“最近关闭”：去重后最多保留 incognito.recentMaxRecords 个网址，超过后删除最旧项。
- 无痕“历史记录”：去重后最多保留 incognito.historyMaxRecords 个网址，与最近关闭上限分别配置。
- 普通“历史记录”：每次搜索最多展示 normal.maxRecords 条匹配的 Chrome 历史；这个限制不裁剪、不删除 Chrome 自带历史。

例如两种模式上限都是 500：普通最近关闭有 500 条时，无痕最近关闭仍可保存 500 条，不是两边合计 500。一次访问后关闭，可以在“历史记录”和“最近关闭”各出现一次，这是两种用途的数据，不是关闭记录重复。

页脚只显示当前模式、当前标签的数量。例如“共 32 条 · 上限 500”；搜索时显示“匹配 4 条”。普通历史显示“已载入 500 条 · 展示上限 500”，不能把受查询上限限制的条数宣称为浏览器全部历史总数。

下调上限时，只裁剪对应的自有集合。无痕确认文案仅说明当前修改的列表将删多少条，并提示另一列表不受影响；不触碰另一模式，不删除 Chrome 历史。上调上限不会找回已淘汰记录。旧 incognito.maxRecords 自动回填到两个新字段，之后分别持久保存。

### 2.2 沿用宽度功能

popupWidth 默认 440px，允许 360–800px，普通与无痕共用；保存后当前弹窗立即生效，持久保留，支持仅恢复默认宽度。修改宽度不重置当前标签、搜索词和有效页码，不裁剪记录。

仅设置偏好写入 storage.local，不把无痕访问数据混入配置。

## 3. “最近关闭”的去重与置顶

### 3.1 去重键

使用完整网址作为去重依据：先通过 new URL(url) 校验并得到规范化 href，然后在当前模式的最近关闭集合中按该值匹配。

- 保留路径、全部查询参数、参数顺序及 #fragment，不擅自移除跟踪参数。
- https://example.com/a 与 https://example.com/a?x=1 是两条。
- https://example.com/a#one 与 https://example.com/a#two 是两条。
- 同一完整网址的标题变化，不产生第二条关闭记录。
- 普通和无痕独立去重；同一网址可以在各自集合各有一条。

继续只支持 http: / https:，内部页面、file:、javascript:、data: 等按原规则排除。

### 3.2 更新规则

每次真实关闭时，在事件入口固定 closeEventId、closedAt 和关闭顺序，随后排队处理：

1. 根据标签快照确认所属模式；无痕事件还必须匹配当前 sessionId。
2. 在对应集合查找相同 urlKey。
3. 找不到则新增；找到则更新原条目的关闭时间、最新标题、原窗口/位置、固定状态等元数据，并移动到最前。
4. 按最后关闭时间和事件顺序倒序排列，再执行当前集合的条数裁剪。
5. 同一关闭事件的失败重试保持幂等，不增加条目，不重复更新时间。

旧的失败事件若晚于新的关闭事件补写，不能覆盖较新的标题、关闭时间、位置或置顶顺序。captureId / closeEventId 用于事件重试识别，不再作为“是否出现重复网址”的唯一依据。现有 appendRecord 按 id 检查重复的逻辑必须改为按 URL 更新。

记录条目可以保留稳定 id，以免置顶时界面失去定位；事件 ID 与条目 ID 分开。不得用 title 或 tabId 作为网址去重键。

## 4. 两种“历史记录”的实现

### 4.1 普通：只读查询 Chrome 历史

增加 history 权限，通过 chrome.history.search 查询：

```js
chrome.history.search({
  text: query.trim(),
  startTime: 0,
  maxResults: settings.normal.maxRecords
});
```

明确传 startTime: 0，避免 API 默认仅搜索最近 24 小时。搜索直接交给 Chrome，对匹配结果按 lastVisitTime 倒序，在本扩展内每页 50 条展示。只展示可打开的 http/https 网址。

不要先取最近 N 条空搜索结果，再仅在这 N 条里查关键词；否则较早但匹配的记录会被漏掉。查询结果达到 N 条时说明已达到展示上限，不承诺完整列出全部匹配项。

本次采用按网址聚合的历史列表，显示最后访问时间和可选的访问次数。普通历史不复制到扩展的 storage.local，不用关闭事件模拟访问，不调用 history.addUrl 添加记录。

普通历史页提供搜索、分页和点击打开；删除与清空由 Chrome 自己管理，可提供“在 Chrome 中管理历史”入口。不要复用原来的删除按钮去调用 history.deleteAll / deleteUrl，避免把“清理扩展关闭记录”变成删除浏览器历史。

可以监听 history.onVisited / onVisitRemoved 使普通历史列表失效并刷新；通知只带失效信号，不将整份普通历史推送给无痕弹窗。

### 4.2 无痕：自行采集访问

无痕历史不能依赖 Chrome History API 或 Sessions API。新增无痕访问采集逻辑，在真实导航时记录，而不是等标签关闭后再记录。

推荐增加 webNavigation 权限，监听：

- webNavigation.onCommitted：主文档导航提交。
- webNavigation.onHistoryStateUpdated：SPA 的 pushState / replaceState 等同文档变化。
- webNavigation.onReferenceFragmentUpdated：地址 hash 变化。

仅处理 frameId === 0、有效 tabId、http/https 且明确属于无痕标签的事件。忽略子框架和未激活的预渲染；处理预渲染激活/标签替换时，应确认其已经成为真实页面再采集。来源不明时先查对应 Tab 或使用可信快照；标签已消失且无法确定来源时跳过，不能默认按普通处理。

无痕历史同样按完整 urlKey 聚合，重复访问更新 lastVisitedAt、visitCount 并置顶。新文档提交与同文档 URL 变化使用各自事件标识去重；标题或 favicon 更新不能算一次新访问。

标题可能晚于导航到达，可用后续 tabs.onUpdated 补齐，但必须校验 sessionId、tabId 以及 documentId/当前 URL，避免把下一页面的标题补给上一页面。缺少标题时用域名回退。

浏览器后退/前进、刷新、SPA 路由及 hash 导航需要验收。一次导航只累计一次，不因加载中/加载完成/标题变化重复累计。

扩展启用前已经结束的无痕访问无法补录。启动枚举当前标签只建立关闭快照，不伪造过去的访问时间；Service Worker 休眠后重建快照、打开弹窗或刷新列表也不算新访问。

## 5. 后台架构与数据分区

保留现有 Manifest V3、原生 JavaScript 和 incognito: spanning，继续由一个后台串行协调窗口生命周期及记录写入。按数据域分别存储，不再保留可返回全部来源的统一历史数组。

建议存储结构：

| 存储区 | Key | 内容 |
| --- | --- | --- |
| storage.local | settings | schemaVersion: 2、popupWidth、normal.maxRecords、incognito.recentMaxRecords、incognito.historyMaxRecords |
| storage.local | normal.recent | 普通关闭条目及清空代次 |
| storage.session | normal.liveTabs | 普通活动标签快照 |
| storage.session | normal.pendingCloses | 普通待补写关闭事件 |
| storage.session | incognito.state | 本次无痕 sessionId、状态、窗口集合、最近关闭、访问历史、活动快照、待补写事件与清空代次 |

配置示例：

```js
{
  schemaVersion: 2,
  popupWidth: 440,
  normal: { maxRecords: 500 },
  incognito: { recentMaxRecords: 500, historyMaxRecords: 500 }
}
```

无痕条目的 URL、标题、访问次数、窗口/标签快照、待写事件及页面相关缓存只存 session 和运行时内存，不写 local、sync、文件、日志、Chrome 历史或网络。无痕状态按同一个 key 保存，最终清理时覆盖为空状态，减少逐项清理留下残余的机会。

storage.session 能跨 Service Worker 休眠保留数据，但其官方生命周期不等于无痕窗口生命周期。扩展必须实现第 6 节的自动清除。浏览器重启、扩展重载/更新/禁用也会使 session 数据消失；普通关闭数据仍保留。不得使用保持 worker 常驻的办法替代存储与生命周期处理。

建议将 record-store 分为普通关闭存储、无痕会话存储两个明确接口；可以共用 URL 规范化、去重和分页函数，不能共用一个混合数组或混合配额。

## 6. 最后一个无痕窗口关闭：必须自动清空

### 6.1 识别与触发

同步在 worker 顶层注册 windows.onCreated / onRemoved，并维护可信的无痕窗口 ID 集合。onRemoved 只有 windowId，需要已有窗口快照判断类型；初始化、worker 重建和必要的事件处理时，用 windows.getAll 枚举并校正集合。

判断条件是“所有无痕窗口数量为 0”，不是“当前窗口关闭”或“失去焦点”。多窗口情形必须用真实 Chrome 测试。

状态可简化为：

```text
没有无痕窗口 → 打开首个无痕窗口 → 新 sessionId，空数据
存在无痕窗口 → 关闭其中一个但还剩其他窗口 → 保留本次数据
最后一个无痕窗口关闭 → 结束当前 sessionId，清空全部无痕数据
再次打开无痕窗口 → 生成新 sessionId，不继承旧会话
```

### 6.2 清理顺序与竞态

所有窗口事件、标签关闭、访问历史写入、补写、删除和清空进入同一串行队列。每个异步事件在进入时携带所属 sessionId / 代次，不能在真正写入时随意套用最新会话。

最后一个无痕窗口关闭后：

1. 先结束旧会话、更新代次，阻止旧事件继续写入。
2. 清空无痕最近关闭和访问历史。
3. 清空对应活动快照、待补写事件、索引、标题/favicon 等页面缓存和运行时数组。
4. 将 incognito.state 覆盖为空的已结束状态；普通记录与配置不受影响。

如果 tabs.onRemoved 先于窗口事件到达，相关条目可以先生成，最终会被会话清理；如果后于清理到达，凭旧 sessionId 直接丢弃。标题查询、导航、失败重试或弹窗请求的迟到结果同样丢弃。

清理期间又打开新无痕窗口时，为其建立全新 sessionId；旧清理任务不得清掉新数据，旧写入也不得进入新会话。重新打开无痕窗口只允许显示新会话数据。

worker 初始化时，必须先核对现存无痕窗口、结束已失效会话，再进行任何待写补偿。不能沿用当前“每个消息先 flush 全部 pending”的顺序，导致旧无痕数据复活。

清理存储失败时，在内存中立即使旧会话失效并拒绝读取其内容，安排后续重试；下次 worker 唤醒也必须先核对并清理。不能把清理责任交给用户，不依赖弹窗仍开着，也不依赖可能随 worker 停止而消失的延时定时器。

撤销无痕权限后，同样结束并清空扩展中的无痕会话数据，不影响普通数据。浏览器崩溃/强杀期间不承诺最后事件必达；再次启动无 session 数据，或下次唤醒发现没有无痕窗口时必须清空遗留状态。

### 6.3 手动删除与补写不能冲突

现实现还有一项已复现的问题：local 写入失败后留下 pendingClose，用户清空关闭记录，旧 pending 在后续 flush 时又把记录补回。

本次必须一并处理：

- 清空一个集合时，更新该集合清空代次，并同时取消此前属于该集合的待补写事件。
- 单条删除时，取消此前同 URL 的待补写；后来发生的真实关闭/访问仍可生成新条目。
- 手动清空列表不丢弃仍打开标签的必要关闭快照，保留并关联到新代次，以便用户以后关闭这些标签时仍可正常记录。
- 最后一个无痕窗口关闭时，则连活动快照一起清空，因为旧会话已经结束。
- 补写前同时校验模式、会话、集合代次及事件新旧，旧事件不能使已删除的数据回来。

## 7. 弹窗、消息与恢复

### 7.1 窗口上下文固定

在弹窗自身调用 windows.getCurrent()，由 Window.incognito 确定当前数据域。一次弹窗生命周期内固定这个上下文，后台通过请求中的 windowId 再查询实际窗口确认；不信任任意传入的 mode，不使用共享 worker 的最近活跃窗口来猜测。

识别未完成时显示加载状态；失败时显示重试入口，不混入另一模式，也不提供手动选择模式的按钮。后台消息只返回当前模式请求的数据，不能继续一次返回全部 records 再让前端隐藏另一半。

区分 contextMode（normal/incognito）与 activeView（recent/history）。前者由浏览器决定，后者由两个标签切换。异步搜索响应携带请求序号和无痕 sessionId，切换标签或会话失效后丢弃旧响应。

### 7.2 界面行为

沿用现有弹窗的搜索框、导航/分页、滚动列表布局及可设置宽度。

- 标签文字固定为“最近关闭”“历史记录”。去掉普通/无痕切换及行内来源徽标。
- 最近关闭使用关闭时间；历史记录使用最后访问时间。
- 搜索只作用于当前模式、当前标签，不跨模式、不混合两种记录。
- 切换标签保留搜索词，页码回第一页，滚动回顶部；每次重开弹窗默认最近关闭、空搜索。
- 每页 50 条；无匹配时显示 0/0；删除或去重置顶后收敛页码。
- 关闭网址重新打开后，最近关闭条目保留；再次关闭只更新并置顶，不增加第二条。
- 设置页仅修改当前模式的上限；无痕最近关闭与历史分别输入、保存、预览裁剪，宽度设置共用。

操作边界：普通最近关闭支持单删/清空；普通历史提供查询和打开，以及 Chrome 历史管理入口。无痕最近关闭和自建历史分别支持单删/清空；可在设置中“清空本次记录”，确认后清除本次无痕会话的两个集合及旧待写，不影响普通数据。

所有清空文案说明当前操作范围，删除按钮不冒泡触发打开。权限提示放在状态/设置说明中，不恢复普通/无痕数据选择器。

### 7.3 打开与恢复

普通最近关闭/历史只能打开到普通窗口，无痕最近关闭/历史只能打开到仍属于当前会话的无痕窗口。保留上轮已修复的“目标失效后重新选择同模式窗口”处理。

普通没有可用窗口可创建普通窗口。无痕目标窗口失效后若还有别的无痕窗口，可重选；如果一个无痕窗口都没有，应结束会话、删除数据并拒绝旧恢复请求。不得利用旧记录新建一个无痕会话来恢复已经按规则销毁的数据。

普通历史是“重新打开网址”，不承诺恢复页面表单或标签状态；最近关闭也沿用现有 URL 恢复的能力边界。

## 8. Manifest 与权限调整

保留已有 tabs / storage / favicon，增加 history 与 webNavigation：

```json
{
  "manifest_version": 3,
  "version": "0.2.0",
  "minimum_chrome_version": "114",
  "permissions": ["tabs", "storage", "favicon", "history", "webNavigation"],
  "incognito": "spanning"
}
```

上面是需合并的关键字段，不是完整 manifest。保留现有 background、action、icons 等配置。不添加名为 windows 的权限，不需要 host_permissions、内容脚本、后台服务器或 unlimitedStorage。

新增权限可能需要用户在 Chrome 中确认后才生效；README 写清更新步骤。无痕仍需要用户手动开启“允许在无痕模式下运行”。无痕数据采集不调用 history.addUrl，也不通过 history.deleteAll 来执行会话清理。

## 9. 从当前版本迁移

当前 settings.schemaVersion 为 1，历史是 local 中的 history.records 混合数组。升级到 schemaVersion: 2，在后台初始化队列中进行幂等迁移：

1. 保留 popupWidth；将旧 maxRecords 分别作为 normal.maxRecords、incognito.recentMaxRecords、incognito.historyMaxRecords 的初值，非法或缺失值用默认值。已有 schema 2 的 incognito.maxRecords 同样回填两个字段，新的合法独立值优先保留。
2. 读取旧 history.records，只保留 mode === normal 的有效 http/https 记录；若新 normal.recent 已存在，同时读取它，避免中途失败后重试覆盖已经迁移的数据。
3. 合并新旧普通记录后按完整 URL 去重，保留同 URL 中最后关闭的记录及元数据，写入 normal.recent，并按普通上限裁剪。旧 key 已不存在时，不能把现有新集合覆盖成空数组。
4. 删除旧混合历史 key，清除旧 live.tabs 中遗留的无痕快照及无痕待写。普通活动快照按新结构重建；有效的普通 pendingClose 单独迁入 normal.pendingCloses，保留原事件时间及幂等标识，再删除旧 live.tabs。
5. 旧版曾持久保存的无痕记录直接删除，不迁入新会话，也不进入 Chrome 历史。
6. 为当前仍存在的无痕窗口建立空的新会话和必要活动快照；不导入旧访问历史。
7. 全部迁移成功后提交 schemaVersion: 2。失败时明确报错并允许重试，不回退展示旧混合数组，不宣称升级完成。

迁移不创建包含旧无痕数据的备份文件或日志；重复执行不能丢失普通记录或重新导入已删除的无痕记录。验收时检查所有旧 local key，不能只隐藏界面而仍把无痕网址留在 legacy 数组里。

## 10. 对现有文件的修改清单

| 文件 / 模块 | 需要修改的责任 |
| --- | --- |
| manifest.json | 新增 history/webNavigation，更新版本，保持现有加载方式 |
| shared/constants.js、settings.js | schema 2、独立数据 key、分模式上限及 recent/history 标签枚举，保留宽度校验 |
| shared/urls.js | 统一 urlKey 规则，供关闭与无痕访问去重、迁移共用 |
| background/record-store.js | 拆除混合数组/混合配额；普通持久记录按 URL 更新，维护清空代次 |
| 新增 background/incognito-session.js | 无痕窗口集合、会话代次、session 数据、最终自动清理与写入校验 |
| background/tab-tracker.js | 按模式写对应最近关闭，closeEventId 与条目 id 分离，清理相关 pending |
| 新增 background/history-service.js | 普通 Chrome 历史查询与无痕访问历史采集/查询；接口按上下文路由 |
| background/service-worker.js | 顶层注册窗口/导航事件；先核对会话，再允许补写；统一串行调度 |
| background/messenger.js | 请求验证窗口上下文；分视图查询/打开/删除/清空，禁止返回另一模式数据 |
| background/restore-service.js | 无痕恢复增加有效会话校验，最终窗口已关闭不再按旧记录重建会话 |
| popup/popup.html、popup.js、state.js、popup.css | 两个标签改名；移除来源切换/徽标；分视图搜索分页与操作；保留宽度 |
| tests、scripts/smoke.mjs | 替换旧混合历史/重复记录断言，增加会话清理、URL 去重、迁移与补写回归 |
| README.md、docs/MANUAL_TESTS.md | 重写数据说明和验收矩阵，删除旧版无痕永久保存及跨模式切换描述 |

可以适度合并新模块，不为文件数量增加无用抽象。当前测试验证的是旧规则，通过旧测试不能证明本次变更完成。

## 11. 实施顺序

1. **先证明关键能力**：常规 Chrome 中加载扩展，开启无痕权限，验证窗口识别、多无痕窗口计数、最后一个窗口关闭后的自动清理，以及普通 history 查询和无痕导航采集。
2. **改数据层与迁移**：独立数据域、独立上限、URL 去重、会话 ID、清空代次；先补去重/清理/迁移的回归测试。
3. **接入两种历史**：普通直接查询 Chrome，无痕采集主框架访问；实现标题补齐及过期异步结果丢弃。
4. **改弹窗与恢复**：最近关闭/历史记录标签、上下文固定、当前模式查询、操作范围及动态宽度。
5. **完整验收**：运行 npm test、更新烟测；再执行真实 Chrome 无痕和真实工具栏弹窗用例，记录版本、步骤和实际结果。

当前 CDP 冒烟加载方式曾在开启无痕权限/扩展重载时触发 DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION，且把 popup 页面作为普通标签页测试。应继续分别记录通过/跳过/失败，不能借助这些跳过项声称无痕或真实弹窗已验收。受限时完成代码及可执行测试，并将真实浏览器未执行项明确交付。

## 12. 验收清单

| 场景 | 通过标准 |
| --- | --- |
| 普通弹窗 | 只有最近关闭/历史记录；只显示普通数据，无来源切换 |
| 无痕弹窗 | 同样两个标签；只显示本次无痕数据，无普通历史泄漏 |
| Chrome 历史 | 能搜索 24 小时以前的匹配记录；数据来自 Chrome，不是关闭记录副本 |
| 无痕访问 | 页面未关闭就出现在历史；刷新、前进/后退、SPA/hash按规则更新，子框架不混入 |
| URL 去重 | 同一模式相同完整 URL 连关两次，只有一条，时间/标题/顺序更新 |
| URL 区别 | 不同 query 或 fragment 的网址分别保留；普通/无痕同 URL 各自独立 |
| 重试新旧 | 较旧失败事件晚补写，不覆盖较新关闭记录或造成重复 |
| 独立上限 | 普通上限设 4、无痕最近关闭设 2、无痕历史设 3，各自保留最新不同 URL 的 4/2/3 条；保存其中一个无痕上限不裁剪另一列表 |
| 独立视图计数 | 无痕最近关闭与访问历史各自计数/裁剪；普通历史只限显示，不删除 Chrome 数据 |
| 多无痕窗口 | 关闭一个但还剩另一个时，两个无痕列表均保留 |
| 最终自动清空 | 关闭最后一个无痕窗口，最近关闭、访问历史、快照、pending及运行时缓存全部清空；普通完全不受影响 |
| 重新开始 | 再开无痕窗口，两列表为空；旧记录不能恢复或被晚到任务补回 |
| 事件竞态 | 最终关窗与 tabs.onRemoved、导航、标题查询、新建无痕窗交错时，旧会话不写入新会话 |
| worker 休眠 | 有无痕窗口时休眠唤醒不误清空；没有无痕窗口时初始化先清空再读/补写 |
| 无普通窗口 | 只剩无痕窗口时仍正常跟踪；最后无痕窗关闭后不遗留可读取的旧会话 |
| 权限撤销 | 无痕数据清空，不继续采集或跨模式打开；普通记录可用 |
| 手动清空回归 | 制造存储失败形成 pending → 清空 → 释放空间/重启 worker，旧记录不能复活 |
| 恢复与打开 | 普通始终回普通；无痕只在有效当前会话打开，不能回退普通或复活已结束会话 |
| 升级迁移 | 普通旧数据按 URL 去重且保留；旧持久无痕数据从 local 删除；宽度/上限正确迁移 |
| 宽度 | 360/440/800px 可用，保存/重开生效；模式/视图/搜索与条数不会被误改 |
| 搜索分页 | 在当前模式、当前标签完整范围内搜索；页码收敛正确，无异步旧结果覆盖 |
| 测试报告 | 单测、mock、真实普通浏览器、真实无痕、真实工具栏弹窗分别标明，跳过不计通过 |

不要通过抓取用户真实无痕网址来输出验收日志；用 example.com 或本地测试站点构造数据。自动化和 mock 必须覆盖失败/延迟/重试路径，真实 Chrome 必须覆盖多窗口最终清理。

## 13. 可直接发送给 DeepSeek 的开发指令

> 请按 docs/MODIFICATION_PLAN.md 修改现有 Undo Tab，并遵循 AGENTS.md 的开发约束。普通与无痕数据完全分域：普通最近关闭持久保存，无痕最近关闭和自行采集的访问历史仅临时保存，在最后一个无痕窗口关闭后自动全部删除；多无痕窗口共享本次会话，关一个但还有其他时保留。弹窗只显示当前窗口模式的数据，取消普通/无痕切换与行内来源标记，标签统一改为“最近关闭 / 历史记录”。普通历史用 Chrome History API 只读查询，无痕历史由扩展通过主框架导航事件采集，不写入 Chrome 历史或 local。最近关闭按完整 URL 在各模式内部去重，再次关闭就更新并置顶；旧重试不能覆盖新事件。普通和无痕分别配置和计算条数，按本文第 2 节区分关闭存储上限与 Chrome 历史展示上限。保留 360–800px 可设置宽度。实现 schema 2 迁移：保留去重后的旧普通记录、保留宽度和条数设置，删除旧 local 中的无痕记录。修复清空后 pending 补写导致旧数据复活，使用会话 ID 和清空代次阻止迟到事件。先完成关键能力验证，再改数据层、历史、弹窗与恢复，交付完整代码、测试及真实浏览器验收记录；未执行和跳过必须如实标注。

## 14. 官方依据

1. [Chrome History API](https://developer.chrome.com/docs/extensions/reference/api/history)：history 权限、search 的默认 24 小时与 maxResults、HistoryItem、getVisits，以及删除 API 的全浏览器影响范围。
2. [WebNavigation API](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)：主框架提交、同文档路由与 fragment 事件，webNavigation 权限。
3. [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)：Tab.incognito、关闭前快照、onRemoved/onUpdated/onReplaced。
4. [Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows)：Window.incognito、窗口枚举、窗口创建/关闭事件。官方未保证事件与枚举之间的原子性，需要本方案的串行化和会话校验。
5. [Manifest incognito](https://developer.chrome.com/docs/extensions/reference/manifest/incognito)：spanning 事件路由、split 与普通/无痕共享 local/sync 的边界。
6. [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)：session 在内存中、跨 worker 休眠、在扩展重载/更新/禁用和浏览器重启时清空；最后一个无痕窗口关闭的清理需扩展自行实现。
7. [Service Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)：后台休眠和全局变量丢失，不能依赖常驻内存或定时器完成必要清理。

