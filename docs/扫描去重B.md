# 分析B

## 结论先说：重复的两种含义，你会同时遇到

1) **同一“文件级图片资产”被多处引用** → 你扫“产品媒体 / Files /（甚至主题素材）”时，**同一个 File/MediaImage ID**可能会在不同资源上下文里被扫到多次。因为 Shopify 的媒体体系是“文件独立管理 + 可被多个资源引用”，对一个文件做更新会传播到它被使用的地方。 

2) **同一“像素内容”被多次上传成不同文件** → 这在商家实际操作里很常见（拖拽重复上传、不同文件名、不同尺寸导出），但在 API 里会表现为**不同的文件 ID**，严格来说它们不是“同一个图片对象”，而是“内容相同的不同文件”。（这类需要做内容哈希才能真去重，但 Shopify API 不直接给你哈希。）

---

## 为什么你的设计特别容易“扫到同一张图多次”

### A. 你把 Catalog Scan 拆成多条 bulk（按资源类型分任务）
这本身是对的，但它天然会制造“重叠覆盖”。

**关键点：`files` 本身就覆盖“产品图 + 店铺素材图”**  
Shopify 的 `files` 查询用于拉取店铺上传的文件资产，并且明确说可用于“管理 product media and images”等场景；示例里 `files` 返回的图片节点类型就是 `MediaImage`，带 `id`、`alt` 等字段。 

同时 Shopify 也强调“文件系统独立于产品”，一个文件上传一次后可以被多个产品/集合/主题等引用，更新会传播。 

**因此：**
- 你做“产品媒体扫描（Product.media → MediaImage）”
- 又做“Files 图片扫描（files(query: media_type:IMAGE) → MediaImage）”

这两条扫描**很可能会把同一个 `gid://shopify/MediaImage/...` 收进两次**（一次从“产品上下文”来，一次从“文件库上下文”来）。 

---

### B. 同一个文件可以被引用到多个产品：同一 MediaImage ID 会在“不同产品上下文”重复出现
这不是猜测，Shopify 在文件更新输入里直接提供了把文件“引用到产品”的机制：`FileUpdateInput.referencesToAdd` / `referencesToRemove`（目前只接受 product IDs）。 

再结合“上传一次、可被多个产品引用、更新传播”的官方描述，你在扫描“产品维度”的时候，如果你的扫描结果行里包含 `(productId, mediaImageId)` 这种结构，那么**同一个 `mediaImageId` 出现多次是正常的**：只是它分别出现在不同的 `productId` 下。 

---

### C. Collection.image / Article.image 的 altText 是另一套“表面（surface）”，会跟 Files/Media 的 alt 并存
你设计里把：
- 集合封面：`Collection.image`（类型是 `Image`）
- 文章封面：`Article.image`（类型也是 `Image`）

单独当资源扫，这是合理的。官方对象定义也明确它们都有 `image (Image)` 字段。   
而 `Image` 对象本身有 `id` 和 `altText` 字段。 

**这会带来一个非常现实的“重复感”：**
- 同一张视觉图片文件，可能既作为“Files/MediaImage 文件资产”存在（有 `alt`，可用 `fileUpdate` 改） 
- 又作为“集合/文章的 Image 字段”存在（有 `altText`，走 `collectionUpdate`/`articleUpdate` 改）

于是扫描 UI 里看起来像“同一张图扫出两条”，但其实它们属于**两个不同的 alt 存储面**（file alt vs image altText），后续回写路径也不同。

---

### D. Continuous Scan（webhook 增量）如果不做 upsert，很容易把同一张图重复入队
增量扫描典型流程是“资源变了 → 重扫该资源 → 把缺失项加入 queue”。如果你内部队列表是“append-only”（只插入不合并），那么：
- 同一张图今天缺 alt，入队一次
- 明天产品又更新触发 webhook，你又重扫一次
- 仍缺 alt，就又入队一次

这类重复**跟 Shopify 数据模型无关**，纯粹是你队列落库策略的问题（需要幂等 upsert/唯一约束来消掉）。

---

## 你应该“允许重复”还是“必须去重”？取决于你队列的主键语义

这里是产品设计的关键：**你的 queue 到底表示“图片资产（asset）”，还是“图片出现位置（occurrence）”？**

### 方案 1：queue = “资产（asset）待补 alt”（更适合 `fileUpdate` 的世界）
如果你的主要写回是 `fileUpdate`（你文档也倾向这么做），那它更新的是**文件级 alt**：`fileUpdate` 直接更新 `MediaImage` 的 `alt`。   
又因为文件可复用、更新会传播，所以从用户体验上更合理的是：

- **队列按 `fileId`（例如 `gid://shopify/MediaImage/…`）去重**
- 同一条队列项下面展示“它被哪些资源引用”（产品 A/B、某集合、某主题模块等），作为审阅上下文

这样可以避免出现“同一文件两条候选，生成两个不同 alt，最后互相覆盖”的尴尬。

**建议的唯一键（示例）：**
- `shopId + surface = FILE + fileGid (+ locale 如果做多语言)`  
多语言之所以加 locale，是因为 2025-10 起“图片 alt text 可翻译”。 

---

### 方案 2：queue = “出现位置（occurrence）待处理”（更适合集合/文章/HTML）
对下面这些情况，“同一图片多次出现”反而是你想要的：
- **HTML 内嵌图**：同一个 `src` 在不同页面/不同段落出现，语境不同，你可能希望 alt 不同（或者至少要分别审阅）  
- **集合封面 / 文章封面**：它们的 `image.altText` 是“资源字段级”的，你更新的是“这个集合/文章的 image 字段”，不是全店文件资产

这时你应该把“重复”当成“多处出现”，而不是 bug。

**建议的唯一键（示例）：**
- Collection 封面：`shopId + surface = COLLECTION_IMAGE + collectionId`（image 只是字段，主语是 collection）
- Article 封面：`shopId + surface = ARTICLE_IMAGE + articleId`
- HTML img：`shopId + surface = HTML_IMG + ownerType + ownerId + domLocator/src`（至少要能稳定定位回写）

相关对象确实存在这些 image 字段：Collection.image、Article.image。 

---

## 最实用的落地建议：做“两层模型”，重复就不再是问题

为了同时满足“可审阅”和“避免重复/覆盖”，通常这样建模最稳：

1) **Asset（资产）表**：按可写回的“底层对象”归一  
- 对 Files/Media：用 `MediaImage.id`（或更泛化：File GID）作为 assetId  
  - `files` 查询示例里 `MediaImage` 就有 `id`/`alt`。 
  - `fileUpdate` 更新也是用这些文件 ID。 

2) **Occurrence（出现位置）表**：记录它“在哪里出现”  
- productId、collectionId、articleId、页面/段落定位、首次/最近一次扫描时间等
- 这层允许一对多：一个 asset 对应很多 occurrence

3) UI 上默认按 **Asset 聚合展示**（避免同图多条），但点开能看到它的所有 Occurrence（给足审阅上下文）。

---

## 额外提醒：你“看到相同图片”的判定标准要明确
最后给你一个避免踩坑的小清单：

- **不要用 URL 当唯一键**：Shopify CDN URL 可能带尺寸变体/参数，同图不同 URL 很常见。用对象 `id` 更稳（Files/MediaImage 场景）。   
- **集合/文章的 image**：能取到 `Image.id` 就优先用 `id`，因为 `Image` 明确有 `id` 字段。   
- **增量扫描必须幂等**：用 upsert 或唯一约束，保证“同一个唯一键只保留一条待处理记录”，否则 webhook 会把队列刷爆（这类重复最常见，也最影响体验）。

---

### 一句话总结
按你这套“多资源类型 + Bulk 全量 + webhook 增量”的扫描设计，**同一张图片被多次扫到是高概率事件**：要么因为 Shopify 文件可复用、同一文件在多资源中出现，要么因为你同时扫了 ProductMedia 和 Files 产生重叠覆盖，要么因为增量扫描缺少幂等入队。正确做法不是“强行避免扫描到”，而是**在数据模型层定义清楚 asset/occurrence，并用合适的唯一键去重或聚合展示**。 


