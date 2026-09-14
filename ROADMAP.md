# Current

- 0.17.1 Canvas Item Compatibility / Hardening — current
  - `.canvas` is a first-class source item and never enters Markdown/frontmatter parsing
  - Canvas stable identity and properties live in `.database.canvasItems`; Canvas JSON/layout is untouched
  - Table can display, open, rename, sort, filter, and edit basic Canvas properties
  - Canvas rename preserves its external identity/property record
  - Canvas deletion removes only the external metadata record after the file is trashed
  - Frontmatter-only relation migrations/reverse writes are blocked from running against Canvas files
  - Version/Parent metadata for Canvas stays in the same external identity layer

# Roadmap

- 0.16.0-hotfix.1 Parent Tree Drag Lock + Unified Expand Button — current
  - 收合父項時，子孫保持隱藏，不再被當成 root 重新插回表格
  - 父子模式拖曳只允許同層 sibling reorder；跨層直接拒絕，改 parent 必須走明確操作
  - 移除獨立父子展開箭頭；檔案/附屬 icon 左鍵展開附屬、右鍵展開/收合子項目
  - 附屬展開狀態與父子收合狀態彼此獨立保留
- 0.16.1 Child Panel in Note
- 0.16.2 Parent / Child Drag Reparenting
- 0.16.3 Progress Rollup V1
- 0.17.x Version Lineage
- 0.18.x Rollup / PC Completion / Migration / Performance
- 0.19.x Mobile

# Canvas Compatibility

- 0.15.6 Canvas Item Compatibility 🟡 待驗證
  - `.canvas` 可安全進入 Database source folder
  - Canvas 使用外部 metadata 身分證，不修改 Canvas JSON
  - Table 顯示 Canvas icon、可開啟/改名/排序
  - 基本 property 儲存在 `.database.canvasItems`
  - rename / move 更新外部 path，不碰 Canvas layout

# Emergency Hotfix

- 0.15.5-hotfix.4 IME Focus Lock + Hidden System Metadata 🟡 待驗證
  - active editor 存活期間禁止 full render 拆 input DOM
  - composition / focus 結束後才補做 reactive / definition refresh
  - `lmd-database` / `lmd-id` 永久視為隱藏系統欄位

# Local Markdown Database Roadmap

- 0.15.5 Stability Hotfix ⚠️ 部分修正
- 0.15.5-hotfix.1 Context Menu Lock + Numeric Editor 🟡 待驗證
  - Table 右鍵選單開啟期間鎖死再次右鍵，直到選單 DOM 真正消失
  - Number cell 改用可控制游標的 numeric text editor；資料寫回仍嚴格 Number
  - 實體數字鍵在中文 IME 開啟時直接插入數字，阻止 composition text 進入 Number cell

- 0.15.0 Flexible / Cross-database Relation ✅
- 0.15.1 Context Attachments Data Model ✅
- 0.15.2 Inline Context Attachments ✅
- 0.15.3 Attachment Notes + Table Geometry Fix ✅
- 0.15.4 Canvas Interop 🟡 待驗證
- 0.16.x Parent / Child ⬜
- 0.17.x Rollup / Progress ⬜
- 0.18.x PC Completion / Migration / Performance ⬜
- 0.19.x Mobile Adaptation ⬜

- 0.15.5-hotfix.2 Replace-on-right-click / IME-proof Number Cell 🟡 待驗證

### 0.15.5-hotfix.3 ✅/待驗證 — Embed Definition Refresh Isolation
- Schema 更新不得覆蓋 Embed local views
- Filter / Sort / Group / active tab 保留
- 主表 View 結構與 Embed View 結構維持隔離



### 0.15.6-hotfix.1 — CMS Safe Empty Values ✅
- 全域空值策略：筆記模式 / CMS 安全模式
- 新建條目可初始化 Schema keys
- 不批次改寫既有 Markdown


## 0.16.1 — Child Panel in Note
- Markdown 閱讀模式自動顯示同 Database 的子項目樹。
- 支援多層子孫、直接開啟子項目、從父筆記新增真正的 child Markdown。
- 若 Schema 有 Checkbox，Panel 可直接勾選並顯示 descendant 完成數。
- 若有狀態 Single-select，Panel 會顯示狀態摘要。
- Parent / Child 仍是同一 Database 的 item hierarchy，不是 Database nesting。


### 0.16.1-hotfix.2 — Leaf-driven Child Panel Mount
- Child Panel lifecycle now follows Markdown leaves directly instead of depending on Markdown post-processor ancestry.
- Re-mounts on file open, active leaf changes, layout/mode changes, and initial layout ready.
- Supports reading view and Live Preview/source view without inserting anything into CodeMirror document content.
- Keeps at most one Child Panel per Markdown leaf.


## 0.16.2 — Parent / Child Drag Reparenting
- 拖到資料列中央：把拖曳項目設為該資料列的 child。
- 拖到資料列上/下緣：只重排同一父項下的 sibling，不會意外脫離層級。
- 拖曳期間顯示「移到根層」浮動 drop target；只有丟到這裡才解除 parent。
- 支援多選 sibling 一起改 parent，保留既有手動順序。
- 禁止把 parent 丟到自己或自己的 descendant 底下，避免循環。
- 成功成為 child 後自動展開新 parent。
- Group 模式仍維持原本拖曳語義，不混入 Parent / Child reparenting。


## 0.16.3-hotfix.1 — Hierarchical Checkbox / Progress
- 移除名稱欄旁的全域 Parent / Child 進度條。
- Checkbox 欄位可獨立右鍵啟用「階層進度」；沒有啟用的 Checkbox 不受影響。
- 階層 Checkbox 支援未完成 / 部分完成 / 完成三態。
- 勾選父項會將全部 descendants 一起完成；取消父項會將全部 descendants 一起取消。
- 修改 child 後會向上同步 ancestor 的完成布林值與視覺三態。
- 完成比例只顯示在啟用階層進度的 Checkbox cell 中。
- 可選統計全部後代或只統計直接子項。
- 這是 Checkbox 的 hierarchy interaction；通用 Rollup 仍保留為後續獨立模組。

## 0.17.0 — Version Lineage V1
- Linear version families for Markdown items.
- Create next version by duplicating the current Markdown item while assigning a new stable item id.
- System metadata: `lmd-version-family`, `lmd-version-prev`, `lmd-version-status` (hidden from database schema).
- Current / superseded state and version-history modal.
- Compact version history strip in the note-side panel.
- V1 intentionally does not implement branches; Canvas version creation is deferred.


## 0.17.0-hotfix.1 — Version projection / note panel dedupe

- Note-side Parent/Child + Version UI is now leaf-owned: one Markdown leaf can have only one panel instance.
- Old duplicate panel instances are removed automatically on the next leaf refresh.
- Normal Database and embedded Views now show only the `current` member of a version family.
- `superseded` history stays as real Markdown files and remains accessible through Version Lineage, but no longer appears as ordinary rows by default.


## 0.17.1-hotfix.1 — iPadOS Compatibility
- Obsidian Mobile/iPadOS uses native table scrolling instead of the viewport-fixed desktop scrollbar.
- Pointer primary-button checks accept WebKit/iPad pointer semantics.
- Touch/pen long-press opens the same context menus as desktop right-click.
- Ctrl-wheel UI zoom and desktop wheel interception are disabled on mobile; saved desktop zoom is not applied on iPad.
- Table controls and resize targets receive mobile-safe hit areas; text fields avoid iPad focus zoom.
- Desktop data model, filters, views, Canvas items, Parent/Child and Version Lineage remain shared.
