# Local Markdown Database 0.16.3-hotfix.1 — Hierarchical Checkbox


本修補把 Parent / Child 的進度從名稱欄移回 Checkbox 本身。Checkbox 欄位右鍵可開啟「階層進度」；開啟後父項會顯示 ☐ / ◐ / ☑ 與完成比例。勾選父項會向下勾選全部 descendants，取消父項則全部取消；修改 child 會向上重新計算 ancestor。普通 Checkbox 完全維持原行為。

本版加入同一 Database 內的父子 Item 階層：`lmd-parent` 是隱藏系統 metadata，不會成為表格欄位。右鍵資料列可新增子項目、變更父項目或移回根層；Table 在未分組時會依父子關係巢狀顯示並可收合。Canvas Item 的 parent 存在外部 canvas metadata，不修改 Canvas JSON。刪除父項目時，直接子項目會自動解除 parent，保留為根項目。

# 0.15.6 — Canvas Item Compatibility

- Database source folders can now index both `.md` and `.canvas` files.
- Canvas files are treated as first-class database items without writing YAML or modifying Canvas JSON.
- Canvas identity and properties are stored externally in the owning `.database` definition under `canvasItems`.
- Canvas rows can be renamed, opened, manually ordered, filtered/sorted, and edited with ordinary basic properties.
- Canvas rename/move tracking updates only external metadata; node/edge/frame/layout JSON remains untouched.
- Markdown continues to use YAML/frontmatter as before.

## 0.15.5-hotfix.4 — IME Focus Lock / System Metadata Hidden

- Table 文字編輯器加入 editor-session lock：只要文字/名稱 cell 仍有焦點，cross-view reactive refresh 與 `.database` definition refresh 都只排隊，不拆掉目前 input DOM；結束編輯後才補做刷新。這是針對 Windows 注音候選窗跑到左上角、Enter 無法寫回的底層修正。
- `lmd-database` 與 `lmd-id` 正式列為系統 metadata：仍保留在 Markdown Properties 供身份/回溯使用，但不再被 Schema 推導、不進 Table/Embed/Board 等資料欄位。舊 schema 若曾誤收進這些欄位，載入時會自動剔除。

## 0.15.5 — Stability Hotfix

- 修正 Table 右鍵選單重複彈出：Row action 統一到單一 delegated context-menu listener。
- Filter state 加固：主 Database View 的篩選狀態以 active-view merge 寫回 `.database`，避免舊 renderer 覆蓋；Embedded View 同時保存 portable state 到 `.database`，讓 Vault 同步到手機/其他裝置時能帶著 Filter。
- 單選 / 多選 option 顏色改為 schema 級更新：修改 A 的顏色後，同一 View 的所有 A 立即重繪，其他開啟 View 也會同步刷新。
- Number cell 加入 physical-key numeric capture，中文 IME 開啟時仍可直接輸入數字、小數點與負號。
- IME composition 保護加固：composition 期間延後 cross-view full render，避免注音候選窗被 renderer 重建切斷；筆記名稱欄也加入相同保護。

# 0.15.3 — Attachment Notes

- 每一條附屬可以保存一段簡短備註；備註存在附屬 metadata，不寫入來源 Markdown。
- 附屬管理面板在檔名右側提供備註輸入欄。
- Table / Embed View 的 inline 附屬樹會在檔名右側顯示備註；空備註不佔額外文字位置。
- 備註隨同一 Database 的 View 顯示，不成為 Schema property。

# Local Markdown Database — 0.15.3-hotfix.1

## Flexible / Cross-database Relation V1

- Relation 現在分成兩種模式：**固定 Database** 與 **跨資料庫**。舊 Relation 沒有 `relationMode` 時自動視為固定模式，既有資料不需要遷移。
- 新增 Relation 欄位時可直接選擇模式。固定模式維持原本「整欄綁定一個 Database」的行為。
- 跨資料庫模式允許同一欄的每一個 cell 自行連到不同 Database 的條目，同一格也可以選多筆。
- 跨資料庫 Picker 會掃描 Vault 中所有 `.database` 的 Markdown 資料來源，搜尋結果會標示條目所屬 Database。
- Relation 仍以標準 Obsidian wikilink 寫入 Markdown YAML，不把資料鎖進私有格式。
- 跨資料庫 Relation 可照常點擊 chip 打開原 Markdown，也可用既有 Filter / Group。
- 固定 Relation 的雙向 Relation 行為完全保留。
- **V1 限制：跨資料庫 Relation 暫不自動建立雙向反向欄位。** 這是刻意限制，避免在多個不同 Schema 中偷偷建立欄位；後續要先把反向語義規格定清楚再開。
- 欄位右鍵 → `Relation 設定…` 可以在固定 / 跨資料庫兩種模式間切換。由固定切成跨資料庫時會先安全移除舊的自動反向連結，再保留目前正向 wikilink。

### Relation / Attachment 定位

- **固定 Relation**：正式 Schema 關係，目標 Database 明確，適合 Filter / Group / Rollup / 雙向同步。
- **跨資料庫 Relation**：仍然是正式欄位關係，但每個 cell 的目標可以來自不同 Database。
- **Context Attachment**：不是欄位，不要求 Schema 對齊；之後會做成每張 item 自己的上下文卡片 / 群組。

---

# Local Markdown Database 0.14.5-dlc.1

## Embedded View Navigation DLC

- 修正 View 改名後舊 Markdown Embed 可能因 `view: 名稱` 失效：新 Embed 會寫入穩定 `view-id`，舊引用在 View 改名時自動補 ID / 更新名稱。
- Markdown 內嵌 Database 現在顯示自己的 View 分頁列，可直接切換 Table / Board / Calendar / Timeline。
- 內嵌 View 分頁可拖曳排序、右鍵重新命名 / 複製 / 刪除，並可用 `+` 直接新增 View。
- View 太多時，多餘分頁收進 `…` 選單；目前作用中的 View 仍會保留在可見區。
- Embed 中的 View 結構變更會同步回來源 `.database`，但 Filter / Sort / layout 仍維持每個 Embed instance 獨立。
- 每個 Embed 會記住自己最後切換到的 View，不會因此改掉主 Database 的 active View。
- 小眼睛與「開啟來源 Database」按鈕提升為所有四種內嵌 View 共用 Shell，不再只有 Table 有。
- Table / Board / Calendar / Timeline 內嵌 View 共用 hover wheel 水平優先：只要內部真的有橫向 overflow，普通滾輪優先左右移動 View。

---

# Local Markdown Database 0.14.2

## Database Identity / Lifecycle

- 為 Database 補上穩定 `id`，不再只靠檔案 path 當身份。
- 新插入的 Markdown Database View 同時記錄 `database-id`，Database 改名或移動後仍可解析。
- 舊 Embed 在 Database rename / move 時會自動更新 `database:` 路徑並補上 `database-id`。
- Embed instance state 改用 Database id 作為身份鍵，搬動 `.database` 後 Filter / Sort instance state 不應遺失。
- 追蹤 source folder rename / move、aggregate source path、Relation target path。
- `.database` 被外部修改時，已開啟 View 會收到 definition refresh。
- 修正 Database 標題 commit 重入，避免改名後 UI 又回到舊名稱而必須輸入第二次。

---

# Local Markdown Database 0.14.0-hotfix.1

## Horizontal Timeline Workflow

- 橫版 Timeline 改為自動資料範圍：不再要求手動設定起訖，會依所有事件、Shadow 事件、Playhead 與時間釘自動延伸左右空間。
- 修正 Timeline Hover 詳情視窗可能殘留在畫面上的問題；捲動、按下滑鼠、重新 render 時都會主動清理。
- 在任一 Lane 空白處按右鍵，可以依點擊位置建立：
  - ◆ 瞬間事件
  - 持續事件（預設 1 小時，之後可 Resize）
- 在既有 Timeline 事件上按右鍵，可以直接把來源 Markdown 移到 Obsidian 垃圾桶。
- Log / Inspector 右側面板可拖曳左邊界調整寬度，寬度會保存到 View；內容過長時維持面板內部捲動。
- 播放新增 Log 時會自動跟隨最新加入的紀錄，因此播放到最後時 Log 會停在最下面。
- 工具列新增可拖曳「時間釘」：把釘子拖到 Timeline 任意時間即可建立固定時間標記。
- 時間釘可右鍵重新命名或刪除；未命名時以時間作為標籤。
- 「釘子庫」可以集中修改名稱、刪除，並用拖曳調整清單展示順序。
- ◆ 瞬間事件仍維持純瞬間語義，不提供 Resize 成 duration。
- Vertical Timeline / Infinite Vertical Timeline 不在目前開發路線。


## 0.13.12 Horizontal UX Fix

- Timeline 新增、Resize、刪除與放置釘子後保留目前橫向視窗位置。
- 釘子庫可直接定位到指定時間；Timeline 釘子只顯示 icon，拖放時顯示插入指示線。
- 滑鼠位於 Timeline 主視圖時，普通滾輪改為水平捲動；Alt+滾輪仍為時間縮放。
- Log / Inspector 面板可同時左右與上下 Resize；內容超出固定高度時在面板內部垂直捲動，播放自動追蹤最新 Log。


## 0.13.13 Horizontal Coordinate / Ruler Fix

- Timeline 內所有滑鼠時間換算統一使用「scrollLeft + viewport X」內容座標，修正往右捲後釘子插入線、實際落點與游標逐漸偏移。
- 操作後視窗恢復改為保留原本左側可視時間，不再用 35% 偏移恢復，因此拖曳 / Resize / 建立 / 刪除不應再偷偷往右跳。
- 拖曳釘子工具只保留 pin icon。
- Log / Inspector 頂部按鈕重新排列，Log/Inspector tabs 靠左，匯出/快速印/清除靠右且保持一致間距。
- 新增「找播放頭」按鈕：不修改 Playhead 時間，只把 Timeline 視窗水平置中到目前播放頭。
- 每日區段加入交替淡色背景，午夜刻度使用較強日界線，方便小時尺度辨認換日。
- Timeline ruler 改為自適應 LOD：依 px/min 自動選擇 5/10/15/30 分、1/2/3/6/12 小時、1/2/7/30 天級刻度，避免縮小後標籤重疊。
- 縮放時同步重算事件、Playhead、釘子、日界背景與 ruler，不再只搬動舊的小時刻度。


## 0.13.14 Timeline Coordinate Core

- Timeline ruler/grid cadence is driven by Snap Grid again.
- Alt + wheel changes only horizontal time density.
- One canonical time ↔ X mapping is shared by pins, playhead, ruler and placement guides.
- Ruler shows time on the first line and date on the second line at day boundaries.
- Adjacent days use alternating ruler header backgrounds.

## 0.13.15 Pin Drag Rewrite

- 時間釘不再使用瀏覽器原生 HTML5 drag/drop，改成 `pointerdown → pointermove → pointerup` 自訂拖曳。
- 拖曳時只保留一個 `snapped time` 作為唯一真實落點；插入指示線與最後儲存的釘子完全共用同一時間，不在放開滑鼠時重新計算。
- Timeline 已水平捲動時，釘子位置直接由 Canvas 內容座標換算，不受工具列 pin icon 的抓取 hotspot 影響。
- 拖到 Timeline 之外時不建立釘子；重新進入 Timeline 後才恢復插入指示線。


## 0.13.17 — Timeline coordinate zoom fix
- Fixed Timeline pointer coordinates under Ctrl UI Zoom.
- Right-click creation, pin preview/drop, playhead placement, and bar move/resize now convert viewport pixels back into unzoomed Timeline layout pixels before time conversion.
- Alt Timeline Zoom remains represented only by px-per-minute, preventing double scaling.


## 0.14.0 — Table State / Filter Integrity

- Table 手動列順序的 definition 寫入改為序列化，避免較舊的非同步儲存覆蓋較新的 manualOrder。
- Markdown 內嵌 Database View 改為 instance-local View state：Filter / Sort / layout 不再回寫主 `.database`。
- 內嵌 View 重新 render 時保留自身暫存 Filter / Sort。
- 從有可推導篩選條件的 View 新增資料時，自動寫入對應 frontmatter（等值、多選 contains、checkbox 等）。
- 新建資料寫入 frontmatter 後等待 metadata cache 更新，再 render，避免新資料因 cache 延遲被篩選掉。
- Table 中修改被 Filter 使用的欄位後，會等待 metadata 更新並立即重新套用 Filter。


## 0.14.0-hotfix.1 — Embed State / Immediate Filter Refresh

- 內嵌 Database View 的 Filter / Sort / layout 改為真正的 embed-instance state，保存到插件資料而不是來源 `.database`。
- 同一個 Markdown 裡的不同 embed 使用獨立 key，不應互相污染，也不應污染主表。
- 編輯 Table property 成功後先建立本地值 overlay，Filter 立即以新值重新判定，不再等待 Obsidian metadata cache。
- metadata cache 追上後會自動退回正常 cache 讀取，避免永久覆蓋外部修改。


### 0.14.0-hotfix.2
同一筆 Markdown 同時出現在主 Database 與內嵌 View 時，任一 View 編輯欄位會即時通知其他已開啟 View 更新與重新套用篩選。


## 0.14.1-hotfix.1 — Stable Item Identity / View Manual Order

- 每篇 Database Markdown item 會取得隱藏用途的 `lmd-id` 穩定身份。
- `manualOrder` 不再依賴 Markdown 路徑，而是保存 stable item ID。
- 每個 View 各自保存自己的 manual order；Embedded View 也沿用自己的 instance state。
- Sort / Filter 只改顯示結果，不會摧毀底層 manual order。
- 舊的 path-based manual order 會在載入時自動遷移；資料夾 rename 後也會以唯一檔名協助舊資料恢復原順序。
- `lmd-id` 不會被自動推斷成 Database property 欄位。


## 0.14.2 — Table Rendering / Input

- 日期欄位縮回與文字/數字欄位一致的 28px 控件節奏。
- Multi-select 隱藏相容性 mirror input，避免空白輸入框遮住 chip。
- Checkbox 欄位預設更窄，最小可縮至接近方塊本體。
- Number cell 使用 number + decimal input mode。
- Table 文字/一般欄位加入 IME composition 保護，避免注音組字期間 Enter/blur 被插件誤提交。


## 0.14.3 Select System

- 新增 Single-select 單選欄位。
- Select 選項改為 Schema 內的持久化 options registry；最後一筆使用者消失後，選項本身仍保留。
- 欄位右鍵「選項設定…」可調整選項順序、名稱、顏色與刪除。重新命名或刪除會同步遷移來源 Markdown 的值。
- Multi-select / Single-select 共用同一套顏色與選項順序。
- Table / Embed 在存在橫向 overflow 時，滑鼠停在 View 內使用普通滾輪會優先左右捲動；到達左右邊界後才把上下滾動交還外層頁面。


## 0.14.4 — Table UX Polish

- View 工具列可用小眼睛暫時收合，Embed 旁提供來源 Database 快捷按鈕。
- Table 欄位右鍵可隱藏，並可從其他欄位右鍵選單恢復。
- 有 Markdown 正文的資料列在名稱旁顯示文件圖示。
- 從 Database / View 開啟筆記時，在 Properties 寫入 `lmd-database` 回溯連結。
- 欄位類型與 Filter 顯示中文化（核取方塊、關聯、包含等）。
- Table 有橫向 overflow 時，滑鼠停在 View 內的普通滾輪全程優先左右移動，不再半途跳回外層上下捲動。


## 0.14.5 — Table Render Stabilization

- 普通 Table 手動拖曳排序改為原地移動既有 row DOM，不再為 manualOrder 清空整張 View。
- 內部 saveDefinition 造成的 Obsidian modify 回音，不再讓同一個 renderer 重複 full render。
- 其他開啟中的主表 / Embed 仍會正常收到 definition / row sync；資料模型與既有 Filter、Sort、Group 行為不變。
- 有 Sort、跨 Group 等確實需要重新計算結構的操作仍保留安全的 full render fallback。

## 0.14.5-dlc.2 — Embedded Local View Structure Hotfix

- Markdown Embed 裡的 View 分頁結構現在是 **instance-local**。
- Embed 內新增 / 重新命名 / 複製 / 刪除 / 拖曳排序 View，不再回寫來源 `.database` 的 `views`。
- 主 Database 的 View 結構與 Embed 子 View 結構正式分離；只有 Markdown 資料本體、Schema 等資料層仍共用。
- Embed 的 Filter / Sort / layout 仍沿用原本 instance-local state，不與主表互相污染。
- 主 Database 自己改 View 名稱時，既有 `view-id` 引用仍可穩定解析，不依賴顯示名稱。


## 0.15.0-hotfix.1

- 跨資料庫 Relation picker 改為以 Database 為資料夾的階層式清單。
- Database 可展開/收合，條目在所屬 Database 下選取。
- 搜尋時自動展開符合結果。
- picker 使用固定高度的內部垂直捲動，不再因清單過長而點不到底部。


## 0.15.1 Context Attachments Data Model

- 新增 Context Attachments / 附屬底層資料模型。
- 每篇 Markdown item 以 stable `lmd-id` 綁定自己的附屬群組。
- 群組與群組內附屬都有獨立順序；附屬只引用原 Markdown，不建立副本。
- 附屬可跨 Database，並記錄選取時的來源 Database context。
- Table 筆記列右鍵新增「附屬…」最小驗證入口，可建立群組、加入/移除附屬、改名與調整順序。
- 附屬資料存於 plugin metadata，不會變成主 Database Schema 欄位，也不與 Relation 混用。

### 0.15.1-hotfix.1 Attachment Group Button Fix
- 修正「新增群組」按鈕在部分 Obsidian / Electron 環境中無法使用的問題。
- 移除對 `window.prompt()` 的依賴：按下「新增群組」會立刻建立預設群組，並自動聚焦群組名稱輸入框供直接改名。
- 群組資料模型與既有 Context Attachments 儲存格式不變。


## 0.15.2 — Inline Context Attachments Rebuild
- Based directly on 0.15.1-hotfix.1 (the rejected 0.15.2 card panel is not used).
- Click the file/file-text icon in a Table row to expand Context Attachments inline beneath that row.
- Multiple rows can stay expanded at once. Inline mode is read-first: open files, right-click to remove, long-press then drag to reorder within a group.
- Adding attachments remains in the row context-menu Attachment editor.
- The editor keeps compact hierarchy and drag sorting without source/summary cards.


## 0.15.3-hotfix.1 — Table Geometry / Zoom Fix

- 修正真實大型資料庫在 Ctrl UI Zoom 下，1px 表格格線被縮成次像素後不規則消失。
- Table 格線會依目前 UI Zoom 反向補償，維持約 1 個螢幕像素的可見粗細。
- 修正欄位拖曳插入線在橫向捲動後越來越偏：插入線現在使用 table scroll-content 座標並計入 scrollLeft。
- 不改 Context Attachments、Relation、Filter、Sort 或資料模型。


## 0.15.4 — Canvas Interop

- Table 筆記右鍵新增「展開附屬到 Canvas / 收起 Canvas 附屬」。
- 也可用命令面板對目前 Markdown 筆記執行展開 / 收起。
- 每篇筆記建立或重用同資料夾下的 `<筆記名> · 附屬.canvas`。
- 主筆記保留為中心 file node；附屬群組是文字節點，附屬本身全部是指向原始 Markdown 的 file node。
- 附屬備註會顯示在 Canvas edge label。
- 重新展開只重建 Local Markdown Database 自己產生的附屬節點，不碰使用者或 Story Canvas Layout 建立的其他 Canvas nodes。
- 收起只移除展開出的群組 / 附屬 nodes 與 edges，保留主筆記 node 與所有原始 Markdown。


## 0.15.5-hotfix.1 — Context Menu Lock / Numeric Editor

- Table 的右鍵選單改成 exclusive lock：一份 Obsidian Menu 存在期間，後續 Table contextmenu 全部被攔截；直到 Menu DOM 消失才解鎖。
- Number 欄位不再使用原生 `input[type=number]` 作為編輯表面，避免 Chromium 不支援 selection/setRangeText 導致實體數字鍵攔截後無法真正插入。
- Number 編輯器改為 `text + inputmode=decimal`，但寫回 YAML 時仍由 `writeProperty()` 嚴格驗證並儲存為 Number。
- 中文 IME 開啟時會先攔截實體 Digit/Numpad/小數點/負號鍵，直接寫入數字；composition text 不允許進入 Number cell。


## 0.15.5-hotfix.2 — Replace-on-right-click / IME-proof Number Cell

- Table 右鍵選單改成 replace-on-right-click：新的 LMD 右鍵選單會先關閉舊的，再在新位置出現；不再堆疊，也不會因舊選單存在而吃掉新的右鍵。
- 取代邏輯是 plugin-wide，因此主表 / Embed / 不同欄位之間同樣永遠最多一份 LMD Menu。
- Number cell 使用 readonly 視覺輸入面 + 自訂實體數字鍵編輯器，避免桌面注音 IME 接管 composition target。
- 支援 0–9、Numpad、負號、小數點、Backspace/Delete、方向鍵、Home/End、Ctrl/Cmd+A 與貼上；寫回仍經 Number 驗證。
- Number 的程式化編輯會在 blur 時提交，避免自訂輸入沒有原生 change 而丟值。

## 0.15.5-hotfix.3 — Embedded View state isolation emergency fix

- 修正 `.database` Schema / 選項 / 顏色變更後，Markdown Embed 會被主資料庫 View 結構覆蓋的問題。
- Embedded View 收到 Database definition refresh 時，只更新共享層（Schema、Source、Database metadata）。
- Embed 自己的分頁、active View、Filter、Sort、Group 與 View layout 完整保留。
- 不再把主表的 Group / Filter / View tabs 灌入頁面內 View。



## 0.15.6-hotfix.1 — CMS Safe Empty Values

- Settings → 資料寫回 → `保留空 Property（CMS 安全模式）`：預設關閉。開啟後清空 Schema 欄位不再刪除 YAML key。
- 型別化空值：文字/日期/單選=`""`，多選/Relation=`[]`，Checkbox=`false`，Number=`null`。
- `新建條目時初始化 Schema 欄位`：預設關閉；開啟後新建 Markdown 會建立目前 Schema 的全部一般欄位。
- `lmd-id` / `lmd-database` 等系統 metadata 不會被當成 CMS Schema 欄位初始化。
- 預設仍維持既有筆記模式，因此升級不會批次改寫舊筆記。


## 0.16.0-hotfix.1

- Fix collapsed Parent/Child descendants reappearing as root rows.
- Lock hierarchy drag to sibling-only manual ordering; re-parenting remains explicit.
- Merge Parent/Child expand control into the existing attachment/file icon: left click attachments, right click children.
- Attachment expansion and Parent/Child collapsed state are independent.


### 0.16.1 Child Panel in Note
打開屬於 Database 的 Markdown 筆記（閱讀模式）時，頁尾會顯示「子項目」樹。可直接開啟子項目、建立新的 child；若資料庫有 Checkbox 欄位，也可在 Panel 直接切換完成狀態。


### 0.16.3 Parent / Child Progress Rollup V1
Parent rows can display computed completion progress based on a Checkbox field. The Table View can switch between all descendants and direct children, and can choose the completion Checkbox when multiple Checkbox fields exist. The note Child Panel also shows a progress meter. Rollups are read-only calculations and do not write derived percentages back to source files.


## 0.17.0-hotfix.1 — Version projection / note panel dedupe

- Note-side Parent/Child + Version UI is now leaf-owned: one Markdown leaf can have only one panel instance.
- Old duplicate panel instances are removed automatically on the next leaf refresh.
- Normal Database and embedded Views now show only the `current` member of a version family.
- `superseded` history stays as real Markdown files and remains accessible through Version Lineage, but no longer appears as ordinary rows by default.


## 0.17.1 Canvas Item Compatibility

Canvas files (`.canvas`) can live directly inside a Database source folder. They are treated as a separate item type rather than Markdown: the plugin never uses frontmatter APIs on Canvas JSON. Stable identity and Database properties are stored in the `.database` definition under `canvasItems`, so editing Database fields does not rewrite Canvas nodes, edges, frames, positions, or layout. Canvas rows can be opened, renamed, sorted, filtered, and can participate in Parent / Child identity metadata.

This release also hardens lifecycle handling: renaming a Canvas keeps the same metadata identity, deleting one cleans its metadata record, and Markdown-only relation migrations are prevented from touching `.canvas` files. Cross-database bidirectional reverse writes *to* Canvas remain intentionally deferred until a target-database-aware Canvas relation adapter exists.
