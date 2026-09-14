// @ts-nocheck
const {
  FileView,
  MarkdownRenderer,
  MarkdownRenderChild,
  Modal,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  TFile,
  TFolder,
  normalizePath,
  Platform,
} = require("obsidian");

const VIEW_TYPE_DATABASE = "local-markdown-database-view";
// 0.17.1-hotfix.2 — iPadOS mobile leaf activation + renderer diagnostics.
const DATABASE_EXTENSION = "database";
const SUPPORTED_FIELD_TYPES = ["text", "number", "date", "checkbox", "single-select", "multi-select", "relation"];
const SOURCE_MARKER_NAME = ".lmd-source.json";
const OPTION_COLORS = ["default", "transparent", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"];
const OPTION_COLOR_LABELS = { default: "重置", transparent: "透明", red: "紅", orange: "橘", yellow: "黃", green: "綠", cyan: "青", blue: "藍", purple: "紫", pink: "粉", gray: "灰" };

function isLmdMobileRuntime() {
  try { return !!(Platform?.isMobileApp || Platform?.isMobile || document?.body?.classList?.contains("is-mobile")); }
  catch (_) { return false; }
}
function isLmdPrimaryPointer(event) {
  if (!event) return false;
  if (event.isPrimary === false) return false;
  return event.button === 0 || event.button === -1 || event.button === undefined || event.button === null;
}

const SYSTEM_METADATA_FIELDS = new Set(["lmd-id", "lmd-database", "lmd-parent", "lmd-version-family", "lmd-version-prev", "lmd-version-status"]);
function isSystemMetadataField(id) { return SYSTEM_METADATA_FIELDS.has(String(id || "").trim().toLowerCase()); }

function normalizeOptionColor(value) { return OPTION_COLORS.includes(value) ? value : "default"; }
function isFlexibleRelation(field) { return field?.type === "relation" && field?.relationMode === "flexible"; }

function isDatabaseDefinition(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.version !== "number") return false;
  if (!value.source || typeof value.source !== "object") return false;
  const validFolderSource = value.source.type === "folder" && typeof value.source.path === "string";
  const validAggregateSource = value.source.type === "database-set" && Array.isArray(value.source.paths) && value.source.paths.every((path) => typeof path === "string");
  if (!validFolderSource && !validAggregateSource) return false;
  if (value.schema !== undefined && !Array.isArray(value.schema)) return false;
  return true;
}


function parseDateRangeValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return { startDate:"", startTime:"", endDate:"", endTime:"", hasTime:false, hasEnd:false };
  const parts = text.split("/");
  const parsePart = (part) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(String(part || "").trim());
    return m ? { date:m[1], time:m[2] ? `${m[2]}:${m[3]}` : "" } : { date:"", time:"" };
  };
  const start = parsePart(parts[0]);
  const end = parts.length > 1 ? parsePart(parts[1]) : { date:"", time:"" };
  return { startDate:start.date, startTime:start.time, endDate:end.date, endTime:end.time, hasTime:!!start.time || !!end.time, hasEnd:!!end.date };
}
function formatDateRangeValue(value) {
  const r = typeof value === "string" ? parseDateRangeValue(value) : (value || {});
  if (!r.startDate) return "";
  const start = `${r.startDate}${r.startTime ? `T${r.startTime}` : ""}`;
  if (!r.hasEnd || !r.endDate) return start;
  const end = `${r.endDate}${r.hasTime && r.endTime ? `T${r.endTime}` : ""}`;
  return `${start}/${end}`;
}
function dateRangeDisplay(value) {
  const r = parseDateRangeValue(value);
  if (!r.startDate) return "";
  const start = `${r.startDate}${r.startTime ? ` ${r.startTime}` : ""}`;
  if (!r.hasEnd || !r.endDate) return start;
  const end = r.endDate === r.startDate && r.endTime ? r.endTime : `${r.endDate}${r.endTime ? ` ${r.endTime}` : ""}`;
  return `${start} → ${end}`;
}

function formatProperty(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  return String(value);
}

// Database cells should preserve intentional line structure more faithfully than
// document Markdown's lazy-continuation rules. In particular an empty list marker
// followed by plain text must stay an empty list item instead of swallowing the
// next line into that list item.
function prepareMarkdownForCell(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    if (/^\s*(?:[-+*]|\d+[.)])\s*$/.test(line) && i + 1 < lines.length && lines[i + 1].trim() !== "") {
      out.push("");
    }
  }
  return out.join("\n");
}

function isWikiLinkValue(value) {
  return typeof value === "string" && /^\[\[[^\]]+\]\]$/.test(value.trim());
}

function inferFieldType(value) {
  if (Array.isArray(value)) {
    const nonEmpty = value.map((item) => String(item ?? "").trim()).filter(Boolean);
    if (nonEmpty.length && nonEmpty.every(isWikiLinkValue)) return "relation";
    return "multi-select";
  }
  if (isWikiLinkValue(value)) return "relation";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?(?:\/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)?$/.test(value)) return "date";
  return "text";
}

function formatRelationWikiLink(value) {
  const target = stripWikiLink(value);
  if (!target) return "";
  const label = pathBasenameNoExt(target);
  return target.includes("/") && label ? `[[${target}|${label}]]` : `[[${target}]]`;
}

function collectFolders(vault) {
  const folders = [vault.getRoot()];
  const visit = (folder) => {
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        folders.push(child);
        visit(child);
      }
    }
  };
  visit(vault.getRoot());
  return folders;
}

function sanitizeFileName(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.+$/g, "")
    .trim();
}

function normalizeFieldId(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function stripMdExtension(path) {
  return String(path || "").replace(/\.md$/i, "");
}

function stripWikiLink(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^\[\[(.+?)(?:\|.*?)?\]\]$/);
  return (m ? m[1] : raw).trim();
}

function pathBasenameNoExt(path) {
  const clean = stripMdExtension(path);
  const parts = clean.split("/");
  return parts[parts.length - 1] || clean;
}

function generateSourceId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch (_) {}
  return `lmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function lmdStableCanvasId(seed) {
  const text = String(seed || "");
  let a = 2166136261 >>> 0;
  let b = 2246822519 >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a ^= c; a = Math.imul(a, 16777619) >>> 0;
    b ^= c + i; b = Math.imul(b, 3266489917) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

function lmdCanvasDirname(path) {
  const clean = normalizePath(String(path || ""));
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(0, idx) : "";
}

class FolderPickerModal extends Modal {
  constructor(app, initialPath, onChoose) {
    super(app);
    this.initialPath = initialPath || "";
    this.onChoose = onChoose;
    this.selected = this.initialPath;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "選擇資料來源資料夾" });
    contentEl.createEl("p", {
      text: "Database 只讀取這個資料夾的直屬 Markdown 文件。",
      cls: "lmd-db-modal-note",
    });

    const folders = collectFolders(this.app.vault);
    new Setting(contentEl)
      .setName("資料夾")
      .addDropdown((dropdown) => {
        for (const folder of folders) {
          dropdown.addOption(folder.path, folder.path || "/（Vault 根目錄）");
        }
        dropdown.setValue(this.selected);
        dropdown.onChange((value) => { this.selected = value; });
      });

    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const apply = actions.createEl("button", { text: "套用", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      this.close();
      void this.onChoose(this.selected);
    });
  }

  onClose() { this.contentEl.empty(); }
}




class AggregateSourceModal extends Modal {
  constructor(app, currentDatabasePath, initialPaths, onChoose) {
    super(app);
    this.currentDatabasePath = normalizePath(currentDatabasePath || "");
    this.selected = new Set((initialPaths || []).map((path) => normalizePath(path)).filter(Boolean));
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "管理聚合資料來源" });
    contentEl.createEl("p", {
      text: "0.12.0 先聚合多個 Database 的原始 Markdown；只有各來源中同名且同類型的 property 會成為共同欄位。資料不會被複製。",
      cls: "lmd-db-modal-note",
    });
    const files = this.app.vault.getFiles()
      .filter((file) => file.extension === DATABASE_EXTENSION && normalizePath(file.path) !== this.currentDatabasePath)
      .sort((a, b) => a.path.localeCompare(b.path, "zh-Hant"));
    const list = contentEl.createDiv({ cls: "lmd-db-aggregate-source-list" });
    if (!files.length) list.createDiv({ cls: "lmd-db-modal-note", text: "目前沒有其他 .database 可以加入。" });
    for (const file of files) {
      const row = list.createEl("label", { cls: "lmd-db-aggregate-source-row" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.selected.has(normalizePath(file.path));
      row.createSpan({ text: file.path });
      checkbox.addEventListener("change", () => {
        const path = normalizePath(file.path);
        if (checkbox.checked) this.selected.add(path); else this.selected.delete(path);
      });
    }
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      const paths = Array.from(this.selected);
      this.close();
      void this.onChoose(paths);
    });
  }

  onClose() { this.contentEl.empty(); }
}

class AggregateCreateTargetModal extends Modal {
  constructor(app, targets, onChoose) {
    super(app);
    this.targets = targets || [];
    this.onChoose = onChoose;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "選擇新增資料的來源" });
    contentEl.createEl("p", { text: "聚合 Database 不擁有 Markdown。請選擇要把新資料建立在哪一個原始 Database。", cls: "lmd-db-modal-note" });
    const list = contentEl.createDiv({ cls: "lmd-db-aggregate-target-list" });
    for (const target of this.targets) {
      const button = list.createEl("button", { cls: "lmd-db-aggregate-target-button", text: target.label });
      button.addEventListener("click", () => { this.close(); void this.onChoose(target); });
    }
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}


class CalendarShadowSourcesModal extends Modal {
  constructor(app, plugin, currentDatabasePath, initialSources, onChoose) {
    super(app); this.plugin = plugin; this.currentDatabasePath = normalizePath(currentDatabasePath || "");
    this.sources = Array.isArray(initialSources) ? JSON.parse(JSON.stringify(initialSources)) : []; this.onChoose = onChoose;
  }
  async onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl("h2", { text: "影子來源" });
    contentEl.createEl("p", { text: "把其他 Database 的卡片投影到目前 Calendar。影子卡片會以灰階顯示，在這裡只允許拖曳修改時間；其他內容仍回原始 Database 編輯。", cls: "lmd-db-modal-note" });
    const files = this.app.vault.getFiles().filter((file) => file.extension === DATABASE_EXTENSION && normalizePath(file.path) !== this.currentDatabasePath).sort((a,b)=>a.path.localeCompare(b.path,"zh-Hant"));
    const host = contentEl.createDiv({ cls: "lmd-db-shadow-source-list" });
    for (const file of files) {
      const def = await this.plugin.readDatabaseDefinition(file); if (!def || def.source?.type !== "folder") continue;
      const schema = Array.isArray(def.schema) ? def.schema : [];
      const dateFields = schema.filter((field) => field?.type === "date" && field.id);
      if (!dateFields.length) continue;
      let entry = this.sources.find((x)=>normalizePath(x.databasePath)===normalizePath(file.path));
      const row = host.createDiv({ cls: "lmd-db-shadow-source-row" });
      const top = row.createEl("label", { cls: "lmd-db-shadow-source-toggle" });
      const check = top.createEl("input", { attr:{type:"checkbox"} }); check.checked = !!entry;
      top.createSpan({ text: def.name || file.basename });
      const select = row.createEl("select", { cls: "lmd-db-shadow-source-date" });
      for (const field of dateFields) select.createEl("option", { text: field.name || field.id, value: field.id });
      select.value = entry?.dateField && dateFields.some((f)=>f.id===entry.dateField) ? entry.dateField : dateFields[0].id;
      select.disabled = !check.checked;
      const sync = () => {
        const path = normalizePath(file.path); const idx = this.sources.findIndex((x)=>normalizePath(x.databasePath)===path);
        if (check.checked) {
          const next = { databasePath:path, dateField:select.value, enabled:true };
          if (idx >= 0) this.sources[idx] = next; else this.sources.push(next);
        } else if (idx >= 0) this.sources.splice(idx,1);
        select.disabled = !check.checked;
      };
      check.addEventListener("change", sync); select.addEventListener("change", sync);
    }
    if (!host.childElementCount) host.createDiv({ cls:"lmd-db-modal-note", text:"目前沒有其他含 Date property 的普通 Database。" });
    const actions=contentEl.createDiv({cls:"lmd-db-modal-actions"});
    actions.createEl("button",{text:"取消"}).addEventListener("click",()=>this.close());
    actions.createEl("button",{text:"套用",cls:"mod-cta"}).addEventListener("click",()=>{const out=this.sources; this.close(); void this.onChoose(out);});
  }
  onClose(){this.contentEl.empty();}
}


class TimelineRangeModal extends Modal {
  constructor(app, initialStart, initialEnd, onChoose) {
    super(app); this.initialStart=initialStart; this.initialEnd=initialEnd; this.onChoose=onChoose;
  }
  onOpen(){
    const {contentEl}=this; contentEl.empty(); contentEl.createEl("h2",{text:"Timeline 時間範圍"});
    contentEl.createEl("p",{text:"這是推演範圍，不會跟隨真實的「今天」。",cls:"lmd-db-modal-note"});
    let start=this.initialStart||""; let end=this.initialEnd||"";
    new Setting(contentEl).setName("開始").addText((text)=>{text.inputEl.type="datetime-local"; text.setValue(start); text.onChange((v)=>{start=v;});});
    new Setting(contentEl).setName("結束").addText((text)=>{text.inputEl.type="datetime-local"; text.setValue(end); text.onChange((v)=>{end=v;});});
    const actions=contentEl.createDiv({cls:"lmd-db-modal-actions"});
    actions.createEl("button",{text:"取消"}).addEventListener("click",()=>this.close());
    actions.createEl("button",{text:"套用",cls:"mod-cta"}).addEventListener("click",()=>{
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end)){new Notice("請輸入完整的開始與結束時間。");return;}
      const a=new Date(start),b=new Date(end); if(!Number.isFinite(a.getTime())||!Number.isFinite(b.getTime())||b<=a){new Notice("結束時間必須晚於開始時間。");return;}
      this.close(); void this.onChoose(start,end);
    });
  }
  onClose(){this.contentEl.empty();}
}


class TimelinePinLibraryModal extends Modal {
  constructor(app, pins, onSave, onJump=null) { super(app); this.pins = Array.isArray(pins) ? pins.map((pin)=>({...pin})) : []; this.onSave = onSave; this.onJump = onJump; }
  onOpen(){
    const {contentEl}=this; contentEl.empty(); contentEl.createEl("h2",{text:"Timeline 釘子庫"});
    contentEl.createEl("p",{text:"拖曳左側把手調整展示順序；可用定位按鈕直接跳到該時間。",cls:"lmd-db-modal-note"});
    const list=contentEl.createDiv({cls:"lmd-db-timeline-pin-library"});
    let dragIndex=null;
    const render=()=>{
      list.empty();
      if(!this.pins.length){list.createDiv({cls:"lmd-db-modal-note",text:"目前沒有釘子。從 Timeline 工具列把釘子拖到時間尺即可建立。"});return;}
      this.pins.forEach((pin,index)=>{
        const row=list.createDiv({cls:"lmd-db-timeline-pin-library-row"}); row.draggable=true; row.dataset.index=String(index);
        const grip=row.createSpan({cls:"lmd-db-timeline-pin-library-grip",attr:{title:"拖曳排序"}}); setIcon(grip,"grip-vertical");
        row.createSpan({cls:"lmd-db-timeline-pin-library-time",text:String(pin.time||"").replace("T"," ")});
        const input=row.createEl("input",{cls:"lmd-db-timeline-pin-library-name",attr:{type:"text",placeholder:"未命名（預設顯示時間）",value:pin.name||""}});
        input.addEventListener("input",()=>{pin.name=input.value.slice(0,40);});
        const jump=row.createEl("button",{cls:"lmd-db-timeline-pin-library-jump",attr:{type:"button",title:"跳到這個時間"}});setIcon(jump,"locate-fixed");
        jump.addEventListener("click",(event)=>{event.preventDefault();event.stopPropagation();if(this.onJump){this.close();this.onJump(pin);}});
        const del=row.createEl("button",{cls:"lmd-db-timeline-pin-library-delete",attr:{type:"button",title:"刪除釘子"}});setIcon(del,"trash-2");
        del.addEventListener("click",()=>{this.pins.splice(index,1);render();});
        row.addEventListener("dragstart",(event)=>{dragIndex=index;row.addClass("is-dragging");event.dataTransfer.effectAllowed="move";});
        row.addEventListener("dragend",()=>{dragIndex=null;row.removeClass("is-dragging");});
        row.addEventListener("dragover",(event)=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect="move";});
        row.addEventListener("drop",(event)=>{event.preventDefault();if(dragIndex===null||dragIndex===index)return;const [moved]=this.pins.splice(dragIndex,1);this.pins.splice(index,0,moved);dragIndex=null;render();});
      });
    };
    render();
    const actions=contentEl.createDiv({cls:"lmd-db-modal-actions"});
    actions.createEl("button",{text:"取消"}).addEventListener("click",()=>this.close());
    actions.createEl("button",{text:"儲存",cls:"mod-cta"}).addEventListener("click",()=>{this.close();void this.onSave(this.pins);});
  }
  onClose(){this.contentEl.empty();}
}

class DatabaseSetupModal extends Modal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.mode = "existing";
    this.selected = "";
    this.selectedDatabases = new Set();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "建立 Database" });
    contentEl.createEl("p", { text: "先決定資料來源。使用現有資料夾不會建立任何多餘資料夾；Managed 模式才會建立專屬資料夾。", cls: "lmd-db-modal-note" });

    const modeSetting = new Setting(contentEl).setName("資料來源方式");
    modeSetting.addDropdown((dropdown) => {
      dropdown.addOption("existing", "使用現有資料夾");
      dropdown.addOption("managed", "建立新的 Managed 資料夾");
      dropdown.setValue(this.mode);
      dropdown.onChange((value) => { this.mode = value; renderFolderChoice(); });
    });

    const folderHost = contentEl.createDiv();
    const renderFolderChoice = () => {
      folderHost.empty();
      if (this.mode === "managed") {
        folderHost.createEl("p", { text: "會建立與 Database 同名的專屬資料夾，之後 Database 改名時會同步改名。", cls: "lmd-db-modal-note" });
        return;
      }
      if (this.mode === "aggregate") {
        folderHost.createEl("p", { text: "聚合其他 .database 的資料，不建立或複製 Markdown。0.12.0 暫時只使用各來源中同名、同類型的共同 property。", cls: "lmd-db-modal-note" });
        const dbFiles = this.app.vault.getFiles().filter((file) => file.extension === DATABASE_EXTENSION).sort((a,b) => a.path.localeCompare(b.path, "zh-Hant"));
        for (const file of dbFiles) {
          const row = folderHost.createEl("label", { cls: "lmd-db-aggregate-source-row" });
          const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
          checkbox.checked = this.selectedDatabases.has(file.path);
          row.createSpan({ text: file.path });
          checkbox.addEventListener("change", () => { if (checkbox.checked) this.selectedDatabases.add(file.path); else this.selectedDatabases.delete(file.path); });
        }
        return;
      }
      const folders = collectFolders(this.app.vault);
      if (!this.selected || !folders.some((f) => f.path === this.selected)) this.selected = folders[0]?.path || "";
      new Setting(folderHost).setName("現有資料夾").addDropdown((dropdown) => {
        for (const folder of folders) dropdown.addOption(folder.path, folder.path || "/（Vault 根目錄）");
        dropdown.setValue(this.selected);
        dropdown.onChange((value) => { this.selected = value; });
      });
    };
    renderFolderChoice();

    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "建立", cls: "mod-cta" }).addEventListener("click", () => {
      const choice = { mode: this.mode, path: this.mode === "existing" ? this.selected : "", paths: this.mode === "aggregate" ? Array.from(this.selectedDatabases) : [] };
      this.close();
      void this.onChoose(choice);
    });
  }

  onClose() { this.contentEl.empty(); }
}

class AddFieldModal extends Modal {
  constructor(app, existingIds, currentDatabasePath, onCreate) {
    super(app);
    this.existingIds = new Set(existingIds);
    this.currentDatabasePath = currentDatabasePath || "";
    this.onCreate = onCreate;
    this.name = "";
    this.type = "text";
    this.relationMode = "fixed";
    this.relationTarget = "";
  }

  getDatabaseFiles() {
    return this.app.vault.getFiles()
      .filter((file) => file.extension === DATABASE_EXTENSION && file.path !== this.currentDatabasePath)
      .sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" }));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "新增欄位" });

    new Setting(contentEl)
      .setName("欄位名稱")
      .setDesc("會作為 Markdown YAML property 的名稱。")
      .addText((text) => {
        text.setPlaceholder("例如：年齡、生日、朋友");
        text.onChange((value) => { this.name = value; });
        text.inputEl.addEventListener("pointerdown", (event) => event.stopPropagation());
        text.inputEl.addEventListener("keydown", (event) => event.stopPropagation());
        requestAnimationFrame(() => requestAnimationFrame(() => text.inputEl.focus({ preventScroll: true })));
      });

    let relationModeSetting;
    let relationSetting;
    const refreshRelationVisibility = () => {
      if (relationModeSetting) relationModeSetting.settingEl.style.display = this.type === "relation" ? "" : "none";
      if (relationSetting) relationSetting.settingEl.style.display = this.type === "relation" && this.relationMode !== "flexible" ? "" : "none";
    };

    new Setting(contentEl)
      .setName("類型")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("text", "文字")
          .addOption("number", "數字")
          .addOption("date", "日期")
          .addOption("checkbox", "核取方塊")
          .addOption("single-select", "單選")
          .addOption("multi-select", "多選")
          .addOption("relation", "關聯");
        dropdown.setValue(this.type);
        dropdown.onChange((value) => {
          this.type = value;
          refreshRelationVisibility();
        });
      });

    const databases = this.getDatabaseFiles();
    relationModeSetting = new Setting(contentEl)
      .setName("Relation 模式")
      .setDesc("固定：整欄只連一個 Database。跨資料庫：每個格子可自行連到不同 Database 的條目。")
      .addDropdown((dropdown) => {
        dropdown.addOption("fixed", "固定 Database");
        dropdown.addOption("flexible", "跨資料庫");
        dropdown.setValue(this.relationMode);
        dropdown.onChange((value) => { this.relationMode = value === "flexible" ? "flexible" : "fixed"; refreshRelationVisibility(); });
      });
    relationSetting = new Setting(contentEl)
      .setName("關聯資料庫")
      .setDesc("固定模式下，整個欄位只會從這個 Database 選擇條目。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", databases.length ? "選擇資料庫…" : "找不到其他 Database");
        for (const file of databases) dropdown.addOption(file.path, file.basename);
        dropdown.setValue(this.relationTarget);
        dropdown.onChange((value) => { this.relationTarget = value; });
      });
    refreshRelationVisibility();

    const errorEl = contentEl.createDiv({ cls: "lmd-db-modal-error" });
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { text: "建立", cls: "mod-cta" });
    create.addEventListener("click", () => {
      const id = normalizeFieldId(this.name);
      if (!id) {
        errorEl.setText("請輸入有效的欄位名稱。");
        return;
      }
      if (this.existingIds.has(id)) {
        errorEl.setText("這個欄位已經存在。");
        return;
      }
      if (!SUPPORTED_FIELD_TYPES.includes(this.type)) {
        errorEl.setText("不支援的欄位類型。");
        return;
      }
      if (this.type === "relation" && this.relationMode !== "flexible" && !this.relationTarget) {
        errorEl.setText("固定 Relation 欄位必須先綁定一個 Database。");
        return;
      }
      this.close();
      const field = { id, name: this.name.trim(), type: this.type, width: this.type === "relation" ? 220 : 160 };
      if (this.type === "single-select" || this.type === "multi-select") { field.options = []; field.optionColors = {}; }
      if (this.type === "relation") {
        field.relationMode = this.relationMode === "flexible" ? "flexible" : "fixed";
        if (field.relationMode === "fixed") field.relationTarget = this.relationTarget;
      }
      void this.onCreate(field);
    });
  }

  onClose() { this.contentEl.empty(); }
}


class DateSettingsModal extends Modal {
  constructor(app, field, onApply) {
    super(app);
    this.field = field || {};
    this.onApply = onApply;
    this.includeTime = this.field.includeTime === true;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "日期設定" });
    contentEl.createEl("p", { text: "開啟時間後，這個欄位可保存到分鐘，例如 1965-08-31 10:00。", cls: "lmd-db-modal-note" });
    new Setting(contentEl)
      .setName("包含時間")
      .setDesc("關閉時只保存年月日；開啟時使用年月日 + 時:分。")
      .addToggle((toggle) => {
        toggle.setValue(this.includeTime);
        toggle.onChange((value) => { this.includeTime = value; });
      });
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      const result = { includeTime: this.includeTime };
      this.close();
      void this.onApply(result);
    });
  }

  onClose() { this.contentEl.empty(); }
}

class RelationSettingsModal extends Modal {
  constructor(app, field, onApply) {
    super(app);
    this.field = field || {};
    this.onApply = onApply;
    this.relationMode = this.field.relationMode === "flexible" ? "flexible" : "fixed";
    this.bidirectional = this.field.bidirectional === true && this.relationMode !== "flexible";
    this.reverseFieldName = String(this.field.reverseFieldName || "");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Relation 設定" });
    contentEl.createEl("p", {
      text: "固定 Relation 適合正式 Schema 關係；跨資料庫 Relation 允許同一欄的每個格子連到不同 Database。跨資料庫模式 V1 暫不自動建立反向欄位。",
      cls: "lmd-db-modal-note",
    });

    let bidirectionalSetting;
    let reverseSetting;
    const refresh = () => {
      if (bidirectionalSetting) bidirectionalSetting.settingEl.style.display = this.relationMode === "fixed" ? "" : "none";
      if (this.relationMode === "flexible") this.bidirectional = false;
      if (reverseSetting) reverseSetting.settingEl.style.display = this.relationMode === "fixed" && this.bidirectional ? "" : "none";
    };

    new Setting(contentEl)
      .setName("Relation 模式")
      .addDropdown((dropdown) => {
        dropdown.addOption("fixed", "固定 Database");
        dropdown.addOption("flexible", "跨資料庫");
        dropdown.setValue(this.relationMode);
        dropdown.onChange((value) => { this.relationMode = value === "flexible" ? "flexible" : "fixed"; refresh(); });
      });

    bidirectionalSetting = new Setting(contentEl)
      .setName("雙向關聯")
      .setDesc("固定模式可同步建立目標 Database 的反向 Relation。")
      .addToggle((toggle) => {
        toggle.setValue(this.bidirectional);
        toggle.onChange((value) => { this.bidirectional = value; refresh(); });
      });

    reverseSetting = new Setting(contentEl)
      .setName("反向欄位名稱")
      .setDesc("留空時會使用目前 Database 的名稱。")
      .addText((text) => {
        text.setPlaceholder("例如：出現在");
        text.setValue(this.reverseFieldName);
        text.onChange((value) => { this.reverseFieldName = value; });
      });
    refresh();

    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      const result = {
        relationMode: this.relationMode,
        bidirectional: this.relationMode === "fixed" && this.bidirectional,
        reverseFieldName: this.reverseFieldName.trim(),
      };
      this.close();
      void this.onApply(result);
    });
  }

  onClose() { this.contentEl.empty(); }
}



class ViewNameModal extends Modal {
  constructor(app, title, initialName, onSubmit) {
    super(app);
    this.titleText = title || "View";
    this.value = initialName || "";
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    const input = contentEl.createEl("input", { type: "text", value: this.value, cls: "lmd-db-modal-text-input" });
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const submit = () => {
      const name = input.value.trim();
      if (!name) { new Notice("名稱不能是空白。"); return; }
      this.close();
      void this.onSubmit(name);
    };
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); submit(); }
      else if (event.key === "Escape") this.close();
    });
    requestAnimationFrame(() => requestAnimationFrame(() => { input.focus({ preventScroll: true }); input.select(); }));
  }
  onClose() { this.contentEl.empty(); }
}


class CreateViewModal extends Modal {
  constructor(app, schema, onCreate) {
    super(app);
    this.schema = Array.isArray(schema) ? schema : [];
    this.onCreate = onCreate;
    this.name = "新視圖";
    this.type = "table";
    this.groupBy = this.schema.find((field) => field?.id)?.id || "";
    this.dateField = this.schema.find((field) => field?.type === "date")?.id || "";
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "新增 View" });
    new Setting(contentEl).setName("名稱").addText((text) => {
      text.setValue(this.name).onChange((value) => { this.name = value; });
    });
    const groupHost = contentEl.createDiv();
    const renderGroup = () => {
      groupHost.empty();
      if (this.type === "board") {
        const candidates = this.schema.filter((field) => field && field.id);
        if (!candidates.length) {
          groupHost.createEl("p", { text: "Board 至少需要一個 property 欄位作為分組依據。", cls: "lmd-db-modal-note" });
          return;
        }
        if (!candidates.some((field) => field.id === this.groupBy)) this.groupBy = candidates[0].id;
        new Setting(groupHost).setName("分組欄位").setDesc("卡片會依這個 property 分欄。拖到另一欄時會同步修改 Markdown property。")
          .addDropdown((dropdown) => {
            for (const field of candidates) dropdown.addOption(field.id, `${field.name || field.id} · ${field.type}`);
            dropdown.setValue(this.groupBy);
            dropdown.onChange((value) => { this.groupBy = value; });
          });
        return;
      }
      if (this.type === "calendar" || this.type === "timeline") {
        const candidates = this.schema.filter((field) => field?.type === "date" && field.id);
        if (!candidates.length) {
          groupHost.createEl("p", { text: `${this.type === "timeline" ? "Timeline" : "Calendar"} 至少需要一個日期（date）property。`, cls: "lmd-db-modal-note" });
          return;
        }
        if (!candidates.some((field) => field.id === this.dateField)) this.dateField = candidates[0].id;
        new Setting(groupHost).setName("日期欄位").setDesc(`${this.type === "timeline" ? "時間軸" : "月曆"}會依這個 date property 放置資料。拖到其他日期會同步修改 Markdown。`)
          .addDropdown((dropdown) => {
            for (const field of candidates) dropdown.addOption(field.id, field.name || field.id);
            dropdown.setValue(this.dateField);
            dropdown.onChange((value) => { this.dateField = value; });
          });
      }
    };
    new Setting(contentEl).setName("View 類型").addDropdown((dropdown) => {
      dropdown.addOption("table", "Table");
      dropdown.addOption("board", "Board");
      dropdown.addOption("calendar", "Calendar");
      dropdown.addOption("timeline", "Timeline");
      dropdown.setValue(this.type);
      dropdown.onChange((value) => { this.type = value; renderGroup(); });
    });
    renderGroup();
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "建立", cls: "mod-cta" }).addEventListener("click", () => {
      const name = this.name.trim();
      if (!name) { new Notice("名稱不能是空白。"); return; }
      if (this.type === "board" && !this.groupBy) { new Notice("請先選擇 Board 的分組欄位。"); return; }
      if ((this.type === "calendar" || this.type === "timeline") && !this.dateField) { new Notice(`請先選擇 ${this.type === "timeline" ? "Timeline" : "Calendar"} 的日期欄位。`); return; }
      this.close();
      void this.onCreate({ name, type: this.type, groupBy: this.groupBy, dateField: this.dateField });
    });
  }
  onClose() { this.contentEl.empty(); }
}


class BoardCardFieldsModal extends Modal {
  constructor(app, schema, selectedIds, onApply, viewLabel = "Board") {
    super(app);
    this.schema = schema || [];
    this.selectedIds = Array.isArray(selectedIds) ? selectedIds.slice() : [];
    this.onApply = onApply;
    this.viewLabel = viewLabel || "Board";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `${this.viewLabel} 卡片內容` });
    contentEl.createEl("p", { text: "選擇卡片要顯示的 property，並調整顯示順序。名稱永遠顯示在卡片頂部。", cls: "lmd-db-modal-note" });

    const valid = new Set(this.schema.map((field) => field.id));
    this.selectedIds = this.selectedIds.filter((id) => valid.has(id));
    const selectedSet = new Set(this.selectedIds);
    for (const field of this.schema) if (!this.selectedIds.includes(field.id)) this.selectedIds.push(field.id);
    const list = contentEl.createDiv({ cls: "lmd-db-board-card-fields-list" });
    const render = () => {
      list.empty();
      for (let index = 0; index < this.selectedIds.length; index++) {
        const id = this.selectedIds[index];
        const field = this.schema.find((item) => item.id === id);
        if (!field) continue;
        const row = list.createDiv({ cls: "lmd-db-board-card-field-row" });
        const label = row.createEl("label", { cls: "lmd-db-board-card-field-label" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = selectedSet.has(id);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selectedSet.add(id); else selectedSet.delete(id);
        });
        label.createSpan({ text: field.name || field.id });
        const actions = row.createDiv({ cls: "lmd-db-board-card-field-actions" });
        const up = actions.createEl("button", { text: "↑", attr: { "aria-label": "上移" } });
        const down = actions.createEl("button", { text: "↓", attr: { "aria-label": "下移" } });
        up.disabled = index === 0;
        down.disabled = index === this.selectedIds.length - 1;
        up.addEventListener("click", () => {
          if (index <= 0) return;
          [this.selectedIds[index - 1], this.selectedIds[index]] = [this.selectedIds[index], this.selectedIds[index - 1]];
          render();
        });
        down.addEventListener("click", () => {
          if (index >= this.selectedIds.length - 1) return;
          [this.selectedIds[index + 1], this.selectedIds[index]] = [this.selectedIds[index], this.selectedIds[index + 1]];
          render();
        });
      }
    };
    render();

    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      const ordered = this.selectedIds.filter((id) => selectedSet.has(id));
      this.close();
      void this.onApply(ordered);
    });
  }

  onClose() { this.contentEl.empty(); }
}

class BoardCardEditModal extends Modal {
  constructor(app, file, multiFields, title, valuesByField, suggestionsByField, onApply) {
    super(app);
    this.file = file;
    this.multiFields = multiFields || [];
    this.title = title || file?.basename || "";
    this.valuesByField = {};
    this.colorsByField = {};
    for (const field of this.multiFields) {
      const raw = valuesByField?.[field.id];
      this.valuesByField[field.id] = Array.isArray(raw) ? raw.map(String) : (raw ? [String(raw)] : []);
      this.colorsByField[field.id] = { ...(field.optionColors || {}) };
    }
    this.suggestionsByField = suggestionsByField || {};
    this.onApply = onApply;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "編輯 Board 卡片" });
    new Setting(contentEl).setName("標題").addText((text) => {
      text.setValue(this.title);
      text.onChange((value) => { this.title = value; });
      setTimeout(() => text.inputEl.focus(), 0);
    });

    if (this.multiFields.length) {
      const section = contentEl.createDiv({ cls: "lmd-db-board-card-edit-tags" });
      section.createEl("h3", { text: "標籤 / 多選" });
      for (const field of this.multiFields) {
        const row = section.createDiv({ cls: "lmd-db-board-card-edit-tag-row" });
        row.createDiv({ cls: "lmd-db-board-card-edit-tag-name", text: field.name || field.id });
        const chips = row.createDiv({ cls: "lmd-db-board-card-edit-tag-chips" });
        const renderChips = () => {
          chips.empty();
          const values = this.valuesByField[field.id] || [];
          if (!values.length) chips.createSpan({ cls: "lmd-db-empty-value", text: "空" });
          for (const value of values) {
            chips.createSpan({ cls: `lmd-db-option-chip is-${normalizeOptionColor(this.colorsByField[field.id]?.[value])}`, text: value });
          }
        };
        renderChips();
        const edit = row.createEl("button", { cls: "lmd-db-board-card-edit-tag-button", text: "編輯" });
        edit.addEventListener("click", () => {
          new MultiSelectPickerModal(
            this.app,
            { ...field, optionColors: this.colorsByField[field.id] || {} },
            this.suggestionsByField[field.id] || [],
            this.valuesByField[field.id] || [],
            async (selected, colors) => {
              this.valuesByField[field.id] = selected;
              this.colorsByField[field.id] = colors;
              renderChips();
            }
          ).open();
        });
      }
    }

    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      const payload = {
        title: this.title,
        valuesByField: this.valuesByField,
        colorsByField: this.colorsByField,
      };
      this.close();
      void this.onApply(payload);
    });
  }
  onClose() { this.contentEl.empty(); }
}

class BoardGroupVisibilityModal extends Modal {
  constructor(app, groups, hiddenGroups, labelFor, onApply) {
    super(app);
    this.groups = groups;
    this.hidden = new Set(hiddenGroups || []);
    this.labelFor = labelFor;
    this.onApply = onApply;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Board 分組顯示" });
    contentEl.createEl("p", { text: "取消勾選即可隱藏分組；資料本身不會被刪除或修改。", cls: "lmd-db-modal-note" });
    const list = contentEl.createDiv({ cls: "lmd-db-board-group-visibility-list" });
    for (const group of this.groups) {
      const row = list.createEl("label", { cls: "lmd-db-board-group-visibility-row" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = !this.hidden.has(group);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.hidden.delete(group); else this.hidden.add(group);
      });
      row.createSpan({ text: this.labelFor(group) });
    }
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      const hidden = Array.from(this.hidden);
      this.close();
      void this.onApply(hidden);
    });
  }
  onClose() { this.contentEl.empty(); }
}

class BoardGroupFieldModal extends Modal {
  constructor(app, schema, current, onApply) {
    super(app);
    this.schema = Array.isArray(schema) ? schema.filter((field) => field?.id) : [];
    this.value = current || this.schema[0]?.id || "";
    this.onApply = onApply;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Board 分組" });
    if (!this.schema.length) {
      contentEl.createEl("p", { text: "目前沒有可用的 property 欄位。", cls: "lmd-db-modal-note" });
      return;
    }
    new Setting(contentEl).setName("分組欄位").addDropdown((dropdown) => {
      for (const field of this.schema) dropdown.addOption(field.id, `${field.name || field.id} · ${field.type}`);
      dropdown.setValue(this.value);
      dropdown.onChange((value) => { this.value = value; });
    });
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      this.close();
      void this.onApply(this.value);
    });
  }
  onClose() { this.contentEl.empty(); }
}

class TableGroupFieldModal extends Modal {
  constructor(app, schema, current, onApply) {
    super(app);
    this.schema = Array.isArray(schema) ? schema.filter((field) => field?.id) : [];
    this.value = current || "";
    this.onApply = onApply;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Table 分組" });
    new Setting(contentEl).setName("分組欄位").setDesc("同一個 View 會依這個 property 分成可摺疊區塊。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "不分組");
        for (const field of this.schema) dropdown.addOption(field.id, `${field.name || field.id} · ${field.type}`);
        dropdown.setValue(this.value);
        dropdown.onChange((value) => { this.value = value; });
      });
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      const value = this.value;
      this.close();
      void this.onApply(value);
    });
  }
  onClose() { this.contentEl.empty(); }
}

class AddSortModal extends Modal {
  constructor(app, columns, onCreate) { super(app); this.columns = columns; this.onCreate = onCreate; this.field = columns[0]?.id || "file.name"; this.direction = "asc"; }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl("h2", { text: "新增排序規則" });
    new Setting(contentEl).setName("欄位").addDropdown((d) => { for (const c of this.columns) d.addOption(c.id, c.name || c.id); d.setValue(this.field); d.onChange(v => this.field = v); });
    new Setting(contentEl).setName("方向").addDropdown((d) => { d.addOption("asc", "升冪").addOption("desc", "降冪"); d.setValue(this.direction); d.onChange(v => this.direction = v); });
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "新增", cls: "mod-cta" }).addEventListener("click", () => { this.close(); void this.onCreate({ field: this.field, direction: this.direction }); });
  }
  onClose() { this.contentEl.empty(); }
}

class AddFilterModal extends Modal {
  constructor(app, columns, onCreate, suggestionsByField = {}) {
    super(app);
    this.columns = columns; this.onCreate = onCreate; this.suggestionsByField = suggestionsByField || {};
    this.field = columns[0]?.id || "file.name"; this.operator = "contains"; this.value = "";
  }
  operatorsFor(fieldId) {
    const c = this.columns.find(x => x.id === fieldId); const t = c?.type || "text";
    if (t === "number") return [["eq","等於"],["neq","不等於"],["gt","大於"],["gte","大於等於"],["lt","小於"],["lte","小於等於"],["empty","為空"],["not-empty","不為空"]];
    if (t === "date") return [["eq","日期等於"],["before","早於"],["after","晚於"],["empty","為空"],["not-empty","不為空"]];
    if (t === "checkbox") return [["checked","已勾選"],["unchecked","未勾選"]];
    if (t === "multi-select" || t === "relation") return [["contains","包含"],["not-contains","不包含"],["eq","完全等於"],["empty","為空"],["not-empty","不為空"]];
    if (t === "single-select") return [["eq","等於"],["neq","不等於"],["empty","為空"],["not-empty","不為空"]];
    return [["contains","包含"],["not-contains","不包含"],["eq","等於"],["neq","不等於"],["starts","開頭是"],["ends","結尾是"],["empty","為空"],["not-empty","不為空"]];
  }
  async relationSuggestions(field) {
    const values = new Set(this.suggestionsByField[field.id] || []);
    if (isFlexibleRelation(field)) return Array.from(values).sort((a,b)=>String(a).localeCompare(String(b), "zh-Hant", {numeric:true}));
    const targetPath = normalizePath(field?.relationTarget || "");
    if (!targetPath) return Array.from(values);
    try {
      const databaseFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (!(databaseFile instanceof TFile)) return Array.from(values);
      const definition = JSON.parse(await this.app.vault.read(databaseFile));
      const sourcePath = normalizePath(definition?.source?.path || "");
      const source = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : this.app.vault.getRoot();
      if (source instanceof TFolder) {
        for (const file of source.children) if (file instanceof TFile && file.extension === "md") values.add(file.basename);
      }
    } catch (error) { console.warn("Local Markdown Database: relation filter suggestions failed", error); }
    return Array.from(values).sort((a,b)=>String(a).localeCompare(String(b), "zh-Hant", {numeric:true}));
  }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl("h2", { text: "新增篩選條件" });
    let opDropdown;
    let valueSetting = null;
    let valueInput = null;
    let dataList = null;
    const needsValue = () => !["empty","not-empty","checked","unchecked"].includes(this.operator);
    const currentField = () => this.columns.find((c) => c.id === this.field);
    const rebuildValue = async () => {
      if (!valueSetting || !valueInput) return;
      const field = currentField();
      valueSetting.settingEl.style.display = needsValue() ? "" : "none";
      if (!needsValue()) { this.value = ""; return; }
      const type = field?.type || "text";
      let suggestions = Array.from(new Set(this.suggestionsByField[this.field] || []));
      if (type === "relation") suggestions = await this.relationSuggestions(field);
      if (dataList) dataList.remove();
      dataList = contentEl.createEl("datalist");
      dataList.id = `lmd-filter-values-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      for (const value of suggestions) dataList.createEl("option", { attr: { value: String(value) } });
      valueInput.setAttribute("list", dataList.id);
      if (type === "multi-select" || type === "single-select") {
        valueSetting.setDesc(suggestions.length ? "直接選擇此欄位已建立的選項，也可以輸入搜尋。" : "輸入要篩選的選項。");
        valueInput.placeholder = "選擇或搜尋選項…";
      } else if (type === "relation") {
        const target = isFlexibleRelation(field) ? "跨資料庫" : (field?.relationTarget ? pathBasenameNoExt(field.relationTarget) : "未綁定 Relation Database");
        valueSetting.setDesc(`Relation 來源：${target}。可直接選擇或搜尋目標筆記。`);
        valueInput.placeholder = "選擇或搜尋 Relation…";
      } else {
        valueSetting.setDesc("輸入篩選值。");
        valueInput.removeAttribute("placeholder");
      }
    };
    const rebuildOps = () => {
      if (!opDropdown) return; opDropdown.selectEl.empty(); const ops=this.operatorsFor(this.field);
      for (const [v,l] of ops) opDropdown.addOption(v,l);
      if (!ops.some(x=>x[0]===this.operator)) this.operator=ops[0][0];
      opDropdown.setValue(this.operator); void rebuildValue();
    };
    new Setting(contentEl).setName("欄位").addDropdown((d) => {
      for (const c of this.columns) d.addOption(c.id, c.name || c.id); d.setValue(this.field);
      d.onChange(v => { this.field=v; this.value=""; if (valueInput) valueInput.value=""; rebuildOps(); });
    });
    new Setting(contentEl).setName("條件").addDropdown((d) => { opDropdown=d; rebuildOps(); d.onChange(v => { this.operator=v; void rebuildValue(); }); });
    valueSetting = new Setting(contentEl).setName("值");
    valueSetting.addText((t) => { valueInput=t.inputEl; t.setValue(this.value); t.onChange(v=>this.value=v); });
    void rebuildValue();
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "新增", cls: "mod-cta" }).addEventListener("click", () => {
      this.close(); void this.onCreate({ field: this.field, operator: this.operator, value: needsValue() ? this.value : "" });
    });
  }
  onClose() { this.contentEl.empty(); }
}





class FieldDisplaySettingsModal extends Modal {
  constructor(app, field, onApply) {
    super(app);
    this.field = field;
    this.onApply = onApply;
    this.markdown = field.markdown === true;
    this.wrap = field.wrap === true;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `${this.field.name || this.field.id} · 顯示設定` });
    if (this.field.type === "text") {
      new Setting(contentEl)
        .setName("Markdown 顯示")
        .setDesc("開啟後，非編輯狀態會渲染粗體、斜體、連結、wikilink 等 inline Markdown。雙擊儲存格進入編輯。")
        .addToggle((toggle) => toggle.setValue(this.markdown).onChange((value) => { this.markdown = value; }));
    }
    new Setting(contentEl)
      .setName("自動換行")
      .setDesc("關閉時內容會在欄寬處截斷；開啟時列高會跟著內容增加。")
      .addToggle((toggle) => toggle.setValue(this.wrap).onChange((value) => { this.wrap = value; }));
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      this.close();
      void this.onApply({ markdown: this.markdown, wrap: this.wrap });
    });
  }
  onClose() { this.contentEl.empty(); }
}

class MultiSelectPickerModal extends Modal {
  constructor(app, field, suggestions, currentValue, onApply) {
    super(app);
    this.field = field;
    this.suggestions = Array.from(new Set((suggestions || []).map(String).map((v) => v.trim()).filter(Boolean)));
    this.options = Array.from(new Set([...(Array.isArray(field.options) ? field.options : []), ...this.suggestions].map(String).map((v) => v.trim()).filter(Boolean)));
    this.single = field.type === "single-select";
    this.selected = new Set((Array.isArray(currentValue) ? currentValue : (currentValue ? [currentValue] : [])).map(String));
    if (this.single && this.selected.size > 1) this.selected = new Set([Array.from(this.selected)[0]]);
    this.colors = { ...(field.optionColors || {}) };
    this.query = "";
    this.onApply = onApply;
    this.commitChain = Promise.resolve();
  }
  commit() {
    const values = Array.from(this.selected);
    const colors = { ...this.colors };
    const options = this.options.slice();
    this.commitChain = this.commitChain
      .then(() => this.onApply(values, colors, options))
      .catch((error) => console.error("Local Markdown Database: instant multi-select update failed", error));
    return this.commitChain;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `${this.single ? "單選" : "多選"} · ${this.field.name || this.field.id}` });
    const search = contentEl.createEl("input", { cls: "lmd-db-multiselect-search", attr: { type: "text", placeholder: "搜尋或建立新選項…" } });
    search.addEventListener("pointerdown", (event) => event.stopPropagation());
    search.addEventListener("mousedown", (event) => event.stopPropagation());
    const list = contentEl.createDiv({ cls: "lmd-db-multiselect-list" });
    const render = () => {
      list.empty();
      const q = this.query.trim().toLocaleLowerCase();
      const all = Array.from(new Set([...this.options, ...this.suggestions, ...this.selected]));
      const visible = q ? all.filter((v)=>v.toLocaleLowerCase().includes(q)) : all;
      for (const value of visible) {
        const row = list.createDiv({ cls: "lmd-db-multiselect-option" });
        const check = row.createEl("input", { attr: { type: this.single ? "radio" : "checkbox", name: this.single ? `lmd-select-${this.field.id}` : undefined } });
        check.checked = this.selected.has(value);
        const chip = row.createSpan({ cls: `lmd-db-option-chip is-${normalizeOptionColor(this.colors[value])}`, text: value });
        const color = row.createEl("select", { cls: "lmd-db-option-color" });
        for (const key of OPTION_COLORS) color.createEl("option", { value: key, text: OPTION_COLOR_LABELS[key] });
        color.value = normalizeOptionColor(this.colors[value]);
        color.addEventListener("change", (event) => {
          event.stopPropagation();
          this.colors[value] = color.value;
          chip.className = `lmd-db-option-chip is-${normalizeOptionColor(color.value)}`;
          void this.commit();
        });
        const toggle = () => {
          if (this.single) { this.selected.clear(); if (check.checked) this.selected.add(value); render(); }
          else { if (check.checked) this.selected.add(value); else this.selected.delete(value); }
          void this.commit();
        };
        check.addEventListener("change", toggle);
        row.addEventListener("click", (event) => {
          if (event.target === color || event.target === check) return;
          check.checked = this.single ? true : !check.checked;
          toggle();
        });
      }
      const exact = this.query.trim();
      if (exact && !all.some((v)=>v.toLocaleLowerCase()===exact.toLocaleLowerCase())) {
        const create = list.createEl("button", { cls: "lmd-db-multiselect-create", text: `＋ 建立「${exact}」` });
        create.addEventListener("click", () => {
          this.suggestions.push(exact);
          if (!this.options.includes(exact)) this.options.push(exact);
          if (this.single) this.selected.clear();
          this.selected.add(exact);
          this.query = "";
          search.value = "";
          render();
          void this.commit();
        });
      }
      if (!visible.length && !exact) list.createDiv({ cls: "lmd-db-empty-value", text: "這個欄位還沒有使用過任何選項。" });
    };
    search.addEventListener("input", () => { this.query = search.value; render(); });
    search.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        const exact = search.value.trim();
        if (exact && !this.suggestions.some((value) => value.toLocaleLowerCase() === exact.toLocaleLowerCase())) {
          event.preventDefault();
          this.suggestions.push(exact); if (!this.options.includes(exact)) this.options.push(exact); if (this.single) this.selected.clear(); this.selected.add(exact); this.query = ""; search.value = ""; render(); void this.commit();
        }
      }
    });
    render();
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "清空" }).addEventListener("click", () => { this.selected.clear(); render(); void this.commit(); });
    actions.createEl("button", { text: "完成", cls: "mod-cta" }).addEventListener("click", () => this.close());
    requestAnimationFrame(() => requestAnimationFrame(() => search.focus({ preventScroll: true })));
  }
  onClose() { this.contentEl.empty(); }
}

class SelectOptionsManagerModal extends Modal {
  constructor(app, field, onApply) {
    super(app); this.field = field || {}; this.onApply = onApply;
    const options = Array.from(new Set((Array.isArray(field?.options) ? field.options : []).map(String).map((v)=>v.trim()).filter(Boolean)));
    this.rows = options.map((label)=>({ original: label, label, color: normalizeOptionColor(field?.optionColors?.[label]) }));
  }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl("h2", { text: `${this.field.type === "single-select" ? "單選" : "多選"} · 選項管理` });
    contentEl.createEl("p", { cls:"lmd-db-modal-note", text:"選項屬於欄位 Schema；即使目前沒有任何筆記使用，仍會保留。可調整順序、改名、顏色或刪除。" });
    const list = contentEl.createDiv({ cls:"lmd-db-select-options-manager" });
    const render = () => {
      list.empty();
      this.rows.forEach((row,index)=>{
        const el=list.createDiv({cls:"lmd-db-select-option-manage-row"});
        const input=el.createEl("input",{cls:"lmd-db-select-option-name",attr:{type:"text"}}); input.value=row.label;
        input.addEventListener("input",()=>{row.label=input.value;});
        const color=el.createEl("select",{cls:"lmd-db-option-color"});
        for(const key of OPTION_COLORS) color.createEl("option",{value:key,text:OPTION_COLOR_LABELS[key]}); color.value=row.color;
        color.addEventListener("change",()=>{row.color=color.value;});
        const up=el.createEl("button",{text:"↑",attr:{type:"button",title:"上移"}}); up.disabled=index===0;
        const down=el.createEl("button",{text:"↓",attr:{type:"button",title:"下移"}}); down.disabled=index===this.rows.length-1;
        const del=el.createEl("button",{attr:{type:"button",title:"刪除選項","aria-label":"刪除選項"}}); setIcon(del,"trash-2");
        up.addEventListener("click",()=>{ if(index<=0)return; [this.rows[index-1],this.rows[index]]=[this.rows[index],this.rows[index-1]]; render(); });
        down.addEventListener("click",()=>{ if(index>=this.rows.length-1)return; [this.rows[index+1],this.rows[index]]=[this.rows[index],this.rows[index+1]]; render(); });
        del.addEventListener("click",()=>{ this.rows.splice(index,1); render(); });
      });
      const add=list.createEl("button",{cls:"lmd-db-select-option-add",text:"＋ 新增選項",attr:{type:"button"}});
      add.addEventListener("click",()=>{ this.rows.push({original:"",label:"新選項",color:"default"}); render(); });
    };
    render();
    const actions=contentEl.createDiv({cls:"lmd-db-modal-actions"});
    actions.createEl("button",{text:"取消"}).addEventListener("click",()=>this.close());
    actions.createEl("button",{text:"套用",cls:"mod-cta"}).addEventListener("click",()=>{
      const cleaned=[]; const seen=new Set();
      for(const row of this.rows){ const label=String(row.label||"").trim(); if(!label||seen.has(label))continue; seen.add(label); cleaned.push({...row,label,color:normalizeOptionColor(row.color)}); }
      const original=Array.from(new Set((Array.isArray(this.field.options)?this.field.options:[]).map(String)));
      const remainingOriginal=new Set(cleaned.map((r)=>r.original).filter(Boolean));
      const deleted=original.filter((label)=>!remainingOriginal.has(label));
      const renames={}; for(const row of cleaned) if(row.original && row.original!==row.label) renames[row.original]=row.label;
      const options=cleaned.map((r)=>r.label); const colors={}; for(const row of cleaned) colors[row.label]=row.color;
      this.close(); void this.onApply({options,colors,renames,deleted});
    });
  }
  onClose(){this.contentEl.empty();}
}

class RelationTargetModal extends Modal {
  constructor(app, currentDatabasePath, currentTarget, onApply) {
    super(app);
    this.currentDatabasePath = currentDatabasePath || "";
    this.currentTarget = currentTarget || "";
    this.onApply = onApply;
    this.selected = this.currentTarget;
  }

  getDatabaseFiles() {
    return this.app.vault.getFiles()
      .filter((file) => file.extension === DATABASE_EXTENSION && file.path !== this.currentDatabasePath)
      .sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" }));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "綁定 Relation 資料庫" });
    contentEl.createEl("p", {
      text: "這個 Relation 欄位只會顯示你綁定的 Database 裡的條目。之後可以隨時更換。",
      cls: "lmd-db-modal-note",
    });

    const databases = this.getDatabaseFiles();
    new Setting(contentEl)
      .setName("目標 Database")
      .addDropdown((dropdown) => {
        dropdown.addOption("", databases.length ? "選擇資料庫…" : "找不到其他 .database");
        for (const file of databases) dropdown.addOption(file.path, `${file.basename}  —  ${file.path}`);
        dropdown.setValue(this.selected);
        dropdown.onChange((value) => { this.selected = value; });
      });

    if (!databases.length) {
      contentEl.createEl("p", {
        text: "目前 Vault 裡沒有其他 .database。請先建立第二個 Database，再回來綁定。",
        cls: "lmd-db-modal-error",
      });
    }

    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const apply = actions.createEl("button", { text: "套用", cls: "mod-cta" });
    apply.disabled = !databases.length;
    apply.addEventListener("click", () => {
      if (!this.selected) {
        new Notice("請先選擇一個 Database。");
        return;
      }
      this.close();
      void this.onApply(this.selected);
    });
  }

  onClose() { this.contentEl.empty(); }
}


class FlexibleRelationPickerModal extends Modal {
  constructor(app, currentDatabasePath, sourceFilePath, currentValue, onApply) {
    super(app);
    this.currentDatabasePath = currentDatabasePath || "";
    this.sourceFilePath = sourceFilePath || "";
    this.onApply = onApply;
    const current = Array.isArray(currentValue) ? currentValue : (currentValue ? [currentValue] : []);
    this.selected = new Set(current.map((v) => stripWikiLink(v)).filter(Boolean));
    this.query = "";
    this.items = [];
    this.commitChain = Promise.resolve();
  }

  async readDefinition(file) {
    try {
      const raw = await this.app.vault.read(file);
      const def = JSON.parse(raw);
      return isDatabaseDefinition(def) ? def : null;
    } catch (_) { return null; }
  }

  async collectFromDatabase(databaseFile, seenDatabases = new Set()) {
    if (!(databaseFile instanceof TFile)) return [];
    const key = normalizePath(databaseFile.path);
    if (seenDatabases.has(key)) return [];
    seenDatabases.add(key);
    const def = await this.readDefinition(databaseFile);
    if (!def) return [];
    if (def.source?.type === "database-set") {
      const out = [];
      for (const path of def.source.paths || []) {
        const child = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (child instanceof TFile) out.push(...await this.collectFromDatabase(child, seenDatabases));
      }
      return out;
    }
    const sourcePath = normalizePath(def.source?.path || "");
    const source = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : this.app.vault.getRoot();
    if (!(source instanceof TFolder)) return [];
    return source.children
      .filter((item) => item instanceof TFile && item.extension === "md")
      .map((file) => ({
        file,
        databasePath: databaseFile.path,
        databaseName: def.name || databaseFile.basename,
      }));
  }

  async loadItems() {
    const dbFiles = this.app.vault.getFiles()
      .filter((file) => file.extension === DATABASE_EXTENSION)
      .sort((a,b)=>a.basename.localeCompare(b.basename, undefined, { numeric:true, sensitivity:"base" }));
    const byPath = new Map();
    for (const db of dbFiles) {
      const entries = await this.collectFromDatabase(db, new Set());
      for (const entry of entries) {
        if (entry.file.path === this.sourceFilePath) continue;
        const path = stripMdExtension(entry.file.path);
        let existing = byPath.get(path);
        if (!existing) {
          existing = { file: entry.file, path, databases: [] };
          byPath.set(path, existing);
        }
        if (!existing.databases.some((item) => item.path === entry.databasePath)) {
          existing.databases.push({ path: entry.databasePath, name: entry.databaseName });
        }
      }
    }
    this.items = Array.from(byPath.values()).sort((a,b) =>
      a.file.basename.localeCompare(b.file.basename, undefined, { numeric:true, sensitivity:"base" }) ||
      a.file.path.localeCompare(b.file.path)
    );
    const allowed = new Set(this.items.map((item) => item.path));
    const healed = new Set();
    const byBase = new Map();
    for (const item of this.items) {
      const key = item.file.basename.toLocaleLowerCase();
      if (!byBase.has(key)) byBase.set(key, []);
      byBase.get(key).push(item.path);
    }
    for (const value of this.selected) {
      if (allowed.has(value)) { healed.add(value); continue; }
      const matches = byBase.get(pathBasenameNoExt(value).toLocaleLowerCase()) || [];
      if (matches.length === 1) healed.add(matches[0]);
    }
    this.selected = healed;
  }

  commit() {
    const allowed = new Set(this.items.map((item) => item.path));
    const values = Array.from(this.selected).filter((value) => allowed.has(value));
    this.commitChain = this.commitChain
      .then(() => this.onApply(values))
      .catch((error) => console.error("Local Markdown Database: flexible relation update failed", error));
    return this.commitChain;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "選擇跨資料庫 Relation" });
    const status = contentEl.createDiv({ cls: "lmd-db-relation-target", text: "掃描 Database…" });
    try { await this.loadItems(); }
    catch (error) {
      console.error("Local Markdown Database: flexible relation load failed", error);
      status.setText(error?.message || "無法讀取 Database。");
      return;
    }
    const databaseCount = new Set(this.items.flatMap((item) => item.databases.map((db) => db.path))).size;
    status.setText(`可選：${databaseCount} 個 Database · ${this.items.length} 筆條目`);
    const search = contentEl.createEl("input", { cls: "lmd-db-relation-search", attr: { type: "search", placeholder: "搜尋 Database 或條目…" } });
    const list = contentEl.createDiv({ cls: "lmd-db-relation-list lmd-db-relation-tree" });
    if (!this.expandedDatabases) {
      this.expandedDatabases = new Set();
      for (const item of this.items) {
        if (!this.selected.has(item.path)) continue;
        for (const db of item.databases) this.expandedDatabases.add(db.path);
      }
    }
    const buildGroups = () => {
      const groups = new Map();
      for (const item of this.items) {
        for (const db of item.databases) {
          if (!groups.has(db.path)) groups.set(db.path, { ...db, items: [] });
          groups.get(db.path).items.push(item);
        }
      }
      return Array.from(groups.values()).sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" }) ||
        String(a.path || "").localeCompare(String(b.path || ""))
      );
    };
    const groups = buildGroups();
    const render = () => {
      list.empty();
      const q = this.query.trim().toLocaleLowerCase();
      for (const group of groups) {
        const groupHaystack = `${group.name || ""} ${group.path || ""}`.toLocaleLowerCase();
        const matchedItems = group.items.filter((item) => {
          const haystack = `${item.file.basename} ${item.file.path}`.toLocaleLowerCase();
          return !q || groupHaystack.includes(q) || haystack.includes(q);
        });
        if (!matchedItems.length) continue;
        const section = list.createDiv({ cls: "lmd-db-relation-group" });
        const header = section.createEl("button", { cls: "lmd-db-relation-group-header", attr: { type: "button" } });
        const forcedOpen = !!q;
        const isOpen = forcedOpen || this.expandedDatabases.has(group.path);
        header.createSpan({ cls: "lmd-db-relation-group-caret", text: isOpen ? "▾" : "▸" });
        header.createSpan({ cls: "lmd-db-relation-group-name", text: group.name || pathBasenameNoExt(group.path) || "未命名 Database" });
        header.createSpan({ cls: "lmd-db-relation-group-count", text: String(matchedItems.length) });
        const children = section.createDiv({ cls: "lmd-db-relation-group-items" });
        children.toggleClass("is-collapsed", !isOpen);
        header.addEventListener("click", () => {
          if (q) return;
          if (this.expandedDatabases.has(group.path)) this.expandedDatabases.delete(group.path);
          else this.expandedDatabases.add(group.path);
          render();
        });
        if (!isOpen) continue;
        for (const item of matchedItems) {
          const row = children.createEl("label", { cls: "lmd-db-relation-option" });
          const box = row.createEl("input", { attr: { type: "checkbox" } });
          box.checked = this.selected.has(item.path);
          row.createSpan({ text: item.file.basename, cls: "lmd-db-relation-option-name" });
          const relativePath = item.file.parent?.path || "";
          if (relativePath) row.createSpan({ text: relativePath, cls: "lmd-db-relation-option-path" });
          box.addEventListener("change", () => {
            if (box.checked) this.selected.add(item.path);
            else this.selected.delete(item.path);
            void this.commit();
          });
        }
      }
      if (!list.childElementCount) list.createDiv({ cls: "lmd-db-relation-empty", text: "找不到符合的 Database 或條目。" });
    };
    list.addEventListener("wheel", (event) => {
      if (list.scrollHeight <= list.clientHeight) return;
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      event.stopPropagation();
    }, { passive: true });
    search.addEventListener("input", () => { this.query = search.value; render(); });
    render();
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "清空" }).addEventListener("click", () => { this.selected.clear(); render(); void this.commit(); });
    actions.createEl("button", { text: "完成", cls: "mod-cta" }).addEventListener("click", () => this.close());
    requestAnimationFrame(() => requestAnimationFrame(() => search.focus({ preventScroll: true })));
  }

  onClose() { this.contentEl.empty(); }
}


class AttachmentItemPickerModal extends Modal {
  constructor(app, plugin, ownerFile, onPick) {
    super(app);
    this.plugin = plugin;
    this.ownerFile = ownerFile;
    this.onPick = onPick;
    this.query = "";
    this.groups = [];
    this.expanded = new Set();
  }

  async loadGroups() {
    const dbFiles = this.app.vault.getFiles()
      .filter((file) => file.extension === DATABASE_EXTENSION)
      .sort((a,b)=>a.basename.localeCompare(b.basename, undefined, { numeric:true, sensitivity:"base" }));
    const groups = [];
    for (const databaseFile of dbFiles) {
      let definition;
      try { definition = await this.plugin.readDatabaseDefinition(databaseFile); } catch (_) { definition = null; }
      if (!definition || definition.source?.type !== "folder") continue;
      const sourcePath = normalizePath(definition.source?.path || "");
      const source = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : this.app.vault.getRoot();
      if (!(source instanceof TFolder)) continue;
      const files = source.children
        .filter((item) => item instanceof TFile && item.extension === "md" && item.path !== this.ownerFile?.path)
        .sort((a,b)=>a.basename.localeCompare(b.basename, undefined, { numeric:true, sensitivity:"base" }));
      if (!files.length) continue;
      const databaseId = await this.plugin.ensureDatabaseId(databaseFile, definition);
      groups.push({ databaseFile, definition, databaseId, files });
    }
    this.groups = groups;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "選擇附屬" });
    const status = contentEl.createDiv({ cls: "lmd-db-relation-target", text: "掃描 Database…" });
    await this.loadGroups();
    status.setText(`可選：${this.groups.length} 個 Database`);
    const search = contentEl.createEl("input", { cls: "lmd-db-relation-search", attr: { type: "search", placeholder: "搜尋 Database 或筆記…" } });
    const list = contentEl.createDiv({ cls: "lmd-db-relation-list lmd-db-relation-tree lmd-db-attachment-picker-list" });
    const render = () => {
      list.empty();
      const q = this.query.trim().toLocaleLowerCase();
      for (const group of this.groups) {
        const dbName = String(group.definition?.name || group.databaseFile.basename || "未命名 Database");
        const dbHay = `${dbName} ${group.databaseFile.path}`.toLocaleLowerCase();
        const matched = group.files.filter((file) => !q || dbHay.includes(q) || `${file.basename} ${file.path}`.toLocaleLowerCase().includes(q));
        if (!matched.length) continue;
        const section = list.createDiv({ cls: "lmd-db-relation-group" });
        const header = section.createEl("button", { cls: "lmd-db-relation-group-header", attr: { type: "button" } });
        const open = !!q || this.expanded.has(group.databaseFile.path);
        header.createSpan({ cls: "lmd-db-relation-group-caret", text: open ? "▾" : "▸" });
        header.createSpan({ cls: "lmd-db-relation-group-name", text: dbName });
        header.createSpan({ cls: "lmd-db-relation-group-count", text: String(matched.length) });
        header.addEventListener("click", () => {
          if (q) return;
          if (this.expanded.has(group.databaseFile.path)) this.expanded.delete(group.databaseFile.path);
          else this.expanded.add(group.databaseFile.path);
          render();
        });
        if (!open) continue;
        const children = section.createDiv({ cls: "lmd-db-relation-group-items" });
        for (const file of matched) {
          const row = children.createEl("button", { cls: "lmd-db-attachment-pick-row", attr: { type: "button" } });
          const icon = row.createSpan({ cls: "lmd-db-attachment-pick-icon" }); setIcon(icon, "file-text");
          row.createSpan({ cls: "lmd-db-relation-option-name", text: file.basename });
          if (file.parent?.path) row.createSpan({ cls: "lmd-db-relation-option-path", text: file.parent.path });
          row.addEventListener("click", async () => {
            const itemId = await this.plugin.ensureStableItemIdForFile(file);
            await this.onPick({
              itemId,
              path: file.path,
              databaseId: group.databaseId || "",
              databasePath: group.databaseFile.path,
            });
            this.close();
          });
        }
      }
      if (!list.childElementCount) list.createDiv({ cls: "lmd-db-relation-empty", text: "找不到符合的 Database 或筆記。" });
    };
    search.addEventListener("input", () => { this.query = search.value; render(); });
    render();
    requestAnimationFrame(() => search.focus({ preventScroll: true }));
  }

  onClose() { this.contentEl.empty(); }
}

class ContextAttachmentsModal extends Modal {
  constructor(app, plugin, ownerFile, ownerDatabaseFile, onChanged = null) {
    super(app);
    this.plugin = plugin;
    this.ownerFile = ownerFile;
    this.ownerDatabaseFile = ownerDatabaseFile;
    this.ownerId = "";
    this.model = null;
    this.onChanged = onChanged;
    this.dragState = null;
  }

  async ensureModel() {
    this.ownerId = await this.plugin.ensureStableItemIdForFile(this.ownerFile);
    this.model = this.plugin.getContextAttachmentModel(this.ownerId) || { version: 1, groups: [] };
  }

  async save() {
    await this.plugin.saveContextAttachmentModel(this.ownerId, this.model);
    if (typeof this.onChanged === "function") {
      try { await this.onChanged(); } catch (_) {}
    }
  }

  async resolveReference(ref) {
    if (!ref) return null;
    let file = ref.itemId ? await this.plugin.findMarkdownFileByStableId(ref.itemId) : null;
    if (!(file instanceof TFile) && ref.path) file = this.app.vault.getAbstractFileByPath(normalizePath(ref.path));
    if (!(file instanceof TFile)) return null;
    if (file.path !== ref.path) ref.path = file.path;
    return file;
  }

  clearDragIndicators() {
    this.contentEl.querySelectorAll('.is-drag-before,.is-drag-after,.is-drag-over').forEach((el) => {
      el.removeClass('is-drag-before'); el.removeClass('is-drag-after'); el.removeClass('is-drag-over');
    });
  }

  async moveGroup(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.model.groups.length) return;
    const [group] = this.model.groups.splice(fromIndex, 1);
    if (toIndex > fromIndex) toIndex -= 1;
    toIndex = Math.max(0, Math.min(toIndex, this.model.groups.length));
    this.model.groups.splice(toIndex, 0, group);
    await this.save(); this.render();
  }

  async moveItem(fromGroupId, fromIndex, toGroupId, toIndex) {
    const fromGroup = this.model.groups.find((g) => g.id === fromGroupId);
    const toGroup = this.model.groups.find((g) => g.id === toGroupId);
    if (!fromGroup || !toGroup || fromIndex < 0 || fromIndex >= fromGroup.items.length) return;
    const [ref] = fromGroup.items.splice(fromIndex, 1);
    if (fromGroup === toGroup && toIndex > fromIndex) toIndex -= 1;
    toIndex = Math.max(0, Math.min(toIndex, toGroup.items.length));
    toGroup.items.splice(toIndex, 0, ref);
    await this.save(); this.render();
  }

  attachGroupDnD(handle, box, groupIndex) {
    handle.draggable = true;
    handle.addEventListener('dragstart', (event) => {
      this.dragState = { type: 'group', groupIndex }; box.addClass('is-dragging');
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'lmd-attachment-group'); }
    });
    handle.addEventListener('dragend', () => { box.removeClass('is-dragging'); this.dragState = null; this.clearDragIndicators(); });
    box.addEventListener('dragover', (event) => {
      if (this.dragState?.type !== 'group') return; event.preventDefault(); this.clearDragIndicators();
      const rect = box.getBoundingClientRect(); box.addClass(event.clientY < rect.top + rect.height / 2 ? 'is-drag-before' : 'is-drag-after');
    });
    box.addEventListener('drop', async (event) => {
      if (this.dragState?.type !== 'group') return; event.preventDefault();
      const rect = box.getBoundingClientRect(); const to = groupIndex + (event.clientY < rect.top + rect.height / 2 ? 0 : 1);
      const from = this.dragState.groupIndex; this.dragState = null; this.clearDragIndicators(); await this.moveGroup(from, to);
    });
  }

  attachItemDnD(handle, row, group, itemIndex, itemsEl) {
    handle.draggable = true;
    handle.addEventListener('dragstart', (event) => {
      this.dragState = { type: 'item', groupId: group.id, itemIndex }; row.addClass('is-dragging');
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'lmd-attachment-item'); }
    });
    handle.addEventListener('dragend', () => { row.removeClass('is-dragging'); this.dragState = null; this.clearDragIndicators(); });
    row.addEventListener('dragover', (event) => {
      if (this.dragState?.type !== 'item') return; event.preventDefault(); this.clearDragIndicators();
      const rect = row.getBoundingClientRect(); row.addClass(event.clientY < rect.top + rect.height / 2 ? 'is-drag-before' : 'is-drag-after');
    });
    row.addEventListener('drop', async (event) => {
      if (this.dragState?.type !== 'item') return; event.preventDefault();
      const from = this.dragState; const rect = row.getBoundingClientRect(); const toIndex = itemIndex + (event.clientY < rect.top + rect.height / 2 ? 0 : 1);
      this.dragState = null; this.clearDragIndicators(); await this.moveItem(from.groupId, from.itemIndex, group.id, toIndex);
    });
    itemsEl.addEventListener('dragover', (event) => { if (this.dragState?.type !== 'item' || event.target !== itemsEl) return; event.preventDefault(); itemsEl.addClass('is-drag-over'); });
    itemsEl.addEventListener('drop', async (event) => {
      if (this.dragState?.type !== 'item' || event.target !== itemsEl) return; event.preventDefault();
      const from = this.dragState; this.dragState = null; this.clearDragIndicators(); await this.moveItem(from.groupId, from.itemIndex, group.id, group.items.length);
    });
  }

  async onOpen() {
    await this.ensureModel();
    if (this.modalEl) this.modalEl.addClass("lmd-db-attachment-modal-shell");
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lmd-db-attachment-modal-content");
    const titleRow = contentEl.createDiv({ cls: "lmd-db-attachment-title-row" });
    const titleIcon = titleRow.createSpan({ cls: "lmd-db-attachment-title-icon" }); setIcon(titleIcon, "paperclip");
    titleRow.createEl("h2", { text: `附屬 · ${this.ownerFile.basename}` });
    contentEl.createEl("p", { cls: "lmd-db-attachment-modal-desc", text: "在這裡管理附屬與群組；表格中的文件圖示只負責快速展開閱讀。" });
    const toolbar = contentEl.createDiv({ cls: "lmd-db-attachment-toolbar" });
    const addGroup = toolbar.createEl("button", { text: "＋ 新增群組", cls: "mod-cta", attr: { type: "button" } });
    addGroup.addEventListener("click", async (event) => {
      event.preventDefault(); event.stopPropagation();
      const groupId = `att-group-${generateSourceId()}`;
      this.model.groups.push({ id: groupId, name: "附屬", collapsed: false, items: [] });
      await this.save(); this.render();
      requestAnimationFrame(() => {
        const input = this.contentEl.querySelector(`[data-attachment-group-id="${groupId}"] .lmd-db-attachment-group-name`);
        if (input instanceof HTMLInputElement) { input.focus({ preventScroll: true }); input.select(); }
      });
    });
    const groupsEl = contentEl.createDiv({ cls: "lmd-db-attachment-groups" });
    if (!this.model.groups.length) groupsEl.createDiv({ cls: "lmd-db-attachment-empty", text: "還沒有附屬群組。先建立一個群組，再從右側 ＋ 加入筆記。" });
    for (let gi = 0; gi < this.model.groups.length; gi++) {
      const group = this.model.groups[gi];
      const box = groupsEl.createDiv({ cls: "lmd-db-attachment-group", attr: { "data-attachment-group-id": group.id } });
      const head = box.createDiv({ cls: "lmd-db-attachment-group-head" });
      const drag = head.createEl("button", { cls: "lmd-db-attachment-drag-handle", attr: { type: "button", title: "拖曳群組" } }); setIcon(drag, "grip-vertical");
      this.attachGroupDnD(drag, box, gi);
      const toggle = head.createEl("button", { cls: "lmd-db-icon-button", attr: { type: "button", title: group.collapsed ? "展開" : "收合" } });
      setIcon(toggle, group.collapsed ? "chevron-right" : "chevron-down");
      toggle.addEventListener("click", async () => { group.collapsed = !group.collapsed; await this.save(); this.render(); });
      const name = head.createEl("input", { cls: "lmd-db-attachment-group-name", value: group.name || "附屬" });
      name.addEventListener("change", async () => { group.name = name.value.trim() || "附屬"; await this.save(); });
      head.createSpan({ cls: "lmd-db-attachment-group-count", text: String(group.items.length) });
      const add = head.createEl("button", { cls: "lmd-db-icon-button", attr: { type: "button", title: "加入附屬" } }); setIcon(add, "plus");
      add.addEventListener("click", () => {
        new AttachmentItemPickerModal(this.app, this.plugin, this.ownerFile, async (ref) => {
          if (!group.items.some((item) => item.itemId === ref.itemId && item.databaseId === ref.databaseId)) group.items.push(ref);
          await this.save(); this.render();
        }).open();
      });
      const del = head.createEl("button", { cls: "lmd-db-icon-button lmd-db-attachment-danger", attr: { type: "button", title: "刪除群組" } }); setIcon(del, "trash-2");
      del.addEventListener("click", async () => { this.model.groups.splice(gi, 1); await this.save(); this.render(); });
      if (group.collapsed) continue;
      const itemsEl = box.createDiv({ cls: "lmd-db-attachment-items" });
      if (!group.items.length) itemsEl.createDiv({ cls: "lmd-db-attachment-group-empty", text: "尚無附屬" });
      group.items.forEach((ref, ii) => {
        const row = itemsEl.createDiv({ cls: "lmd-db-attachment-row" });
        const itemDrag = row.createEl("button", { cls: "lmd-db-attachment-drag-handle", attr: { type: "button", title: "拖曳附屬" } }); setIcon(itemDrag, "grip-vertical");
        this.attachItemDnD(itemDrag, row, group, ii, itemsEl);
        const label = row.createEl("button", { cls: "lmd-db-attachment-open", attr: { type: "button" } });
        const icon = label.createSpan({ cls: "lmd-db-attachment-row-icon" }); setIcon(icon, "file");
        const title = label.createSpan({ cls: "lmd-db-attachment-row-title", text: pathBasenameNoExt(ref.path || ref.itemId || "遺失附屬") });
        void this.resolveReference(ref).then((file) => {
          if (!label.isConnected) return;
          if (file) { title.setText(file.basename); label.title = file.path; }
          else { row.addClass("is-missing"); label.title = "找不到原始 Markdown"; }
        });
        label.addEventListener("click", async () => {
          const file = await this.resolveReference(ref);
          if (file) await this.app.workspace.getLeaf(false).openFile(file);
          else new Notice("找不到這個附屬的原始 Markdown。");
        });
        const note = row.createEl("input", {
          cls: "lmd-db-attachment-note-input",
          value: String(ref.note || ""),
          attr: { type: "text", placeholder: "備註…", "aria-label": `附屬備註：${pathBasenameNoExt(ref.path || ref.itemId || "附屬")}` },
        });
        let noteComposing = false;
        note.addEventListener("compositionstart", () => { noteComposing = true; });
        note.addEventListener("compositionend", () => { noteComposing = false; });
        note.addEventListener("change", async () => { ref.note = note.value.trim(); await this.save(); });
        note.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !noteComposing) note.blur();
          if (event.key === "Escape") { note.value = String(ref.note || ""); note.blur(); }
        });
        const remove = row.createEl("button", { cls: "lmd-db-icon-button lmd-db-attachment-remove", attr: { type: "button", title: "移除附屬" } }); setIcon(remove, "x");
        remove.addEventListener("click", async () => { group.items.splice(ii, 1); await this.save(); this.render(); });
      });
    }
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "完成", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

class RelationPickerModal extends Modal {
  constructor(app, targetDatabasePath, currentValue, onApply) {
    super(app);
    this.targetDatabasePath = targetDatabasePath;
    this.onApply = onApply;
    const current = Array.isArray(currentValue) ? currentValue : (currentValue ? [currentValue] : []);
    this.selected = new Set(current.map((v) => stripWikiLink(v)).filter(Boolean));
    this.query = "";
    this.targetFiles = [];
    this.targetDatabaseName = "Relation";
    this.commitChain = Promise.resolve();
  }
  async loadTargetFiles() {
    const databaseFile = this.app.vault.getAbstractFileByPath(this.targetDatabasePath);
    if (!(databaseFile instanceof TFile)) throw new Error("找不到關聯 Database。");
    this.targetDatabaseName = databaseFile.basename;
    const raw = await this.app.vault.read(databaseFile);
    let definition;
    try { definition = JSON.parse(raw); } catch (_) { throw new Error("關聯 Database 的 JSON 格式無效。"); }
    const sourcePath = normalizePath(definition?.source?.path || "");
    const source = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : this.app.vault.getRoot();
    if (!(source instanceof TFolder)) throw new Error("關聯 Database 找不到資料來源資料夾。");
    this.targetFiles = source.children
      .filter((item) => item instanceof TFile && item.extension === "md")
      .sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" }));
    const allowed = new Set(this.targetFiles.map((file) => stripMdExtension(file.path)));
    const byBase = new Map();
    for (const file of this.targetFiles) {
      const key = file.basename.toLocaleLowerCase();
      if (!byBase.has(key)) byBase.set(key, []);
      byBase.get(key).push(stripMdExtension(file.path));
    }
    const healed = new Set();
    for (const value of this.selected) {
      if (allowed.has(value)) { healed.add(value); continue; }
      const matches = byBase.get(pathBasenameNoExt(value).toLocaleLowerCase()) || [];
      if (matches.length === 1) healed.add(matches[0]);
    }
    this.selected = healed;
  }
  commit() {
    const allowed = new Set(this.targetFiles.map((file) => file.path.replace(/\.md$/i, "")));
    const values = Array.from(this.selected).filter((value) => allowed.has(value));
    this.commitChain = this.commitChain
      .then(() => this.onApply(values))
      .catch((error) => console.error("Local Markdown Database: instant relation update failed", error));
    return this.commitChain;
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "選擇 Relation" });
    const status = contentEl.createDiv({ cls: "lmd-db-relation-target", text: "讀取關聯資料庫…" });
    try { await this.loadTargetFiles(); }
    catch (error) {
      console.error("Local Markdown Database: relation target load failed", error);
      status.setText(error?.message || "無法讀取關聯 Database。");
      return;
    }
    status.setText(`來源：${this.targetDatabaseName} · ${this.targetFiles.length} 筆資料`);
    const search = contentEl.createEl("input", { cls: "lmd-db-relation-search", attr: { type: "search", placeholder: `搜尋 ${this.targetDatabaseName} 的條目…` } });
    const list = contentEl.createDiv({ cls: "lmd-db-relation-list" });
    const render = () => {
      list.empty();
      const q = this.query.trim().toLocaleLowerCase();
      for (const file of this.targetFiles) {
        const linkTarget = file.path.replace(/\.md$/i, "");
        if (q && !file.basename.toLocaleLowerCase().includes(q) && !file.path.toLocaleLowerCase().includes(q)) continue;
        const row = list.createEl("label", { cls: "lmd-db-relation-option" });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = this.selected.has(linkTarget);
        row.createSpan({ text: file.basename, cls: "lmd-db-relation-option-name" });
        if (file.parent && file.parent.path) row.createSpan({ text: file.parent.path, cls: "lmd-db-relation-option-path" });
        box.addEventListener("change", () => {
          if (box.checked) this.selected.add(linkTarget);
          else { this.selected.delete(linkTarget); this.selected.delete(file.basename); }
          void this.commit();
        });
      }
    };
    search.addEventListener("input", () => { this.query = search.value; render(); });
    search.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        const exact = search.value.trim();
        if (exact && !this.suggestions.some((value) => value.toLocaleLowerCase() === exact.toLocaleLowerCase())) {
          event.preventDefault();
          this.suggestions.push(exact); if (!this.options.includes(exact)) this.options.push(exact); if (this.single) this.selected.clear(); this.selected.add(exact); this.query = ""; search.value = ""; render(); void this.commit();
        }
      }
    });
    render();
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "清空" }).addEventListener("click", () => { this.selected.clear(); render(); void this.commit(); });
    actions.createEl("button", { text: "完成", cls: "mod-cta" }).addEventListener("click", () => this.close());
    requestAnimationFrame(() => requestAnimationFrame(() => search.focus({ preventScroll: true })));
  }
  onClose() { this.contentEl.empty(); }
}


class RenameFieldModal extends Modal {
  constructor(app, currentName, onApply) {
    super(app); this.currentName = currentName || ""; this.onApply = onApply; this.value = this.currentName;
  }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl("h2", { text: "重新命名欄位" });
    let inputEl = null;
    new Setting(contentEl).setName("欄位名稱").addText((t) => {
      inputEl = t.inputEl; t.setValue(this.currentName); t.onChange((v) => this.value = v);
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    });
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    const apply = () => {
      const value = String(this.value || "").trim(); if (!value || value === this.currentName) { this.close(); return; }
      this.close(); void this.onApply(value);
    };
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", apply);
    setTimeout(() => { inputEl?.focus(); inputEl?.select(); }, 0);
  }
  onClose() { this.contentEl.empty(); }
}

class ChangeFieldTypeModal extends Modal {
  constructor(app, currentType, onApply) { super(app); this.currentType = currentType || "text"; this.value = this.currentType; this.onApply = onApply; }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl("h2", { text: "變更欄位類型" });
    const labels = { text: "文字", number: "數字", date: "日期", checkbox: "核取方塊", "single-select": "單選", "multi-select": "多選", relation: "關聯" };
    new Setting(contentEl).setName("類型").addDropdown((d) => {
      for (const type of SUPPORTED_FIELD_TYPES) d.addOption(type, labels[type] || type);
      d.setValue(this.currentType); d.onChange((v) => this.value = v);
    });
    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "套用", cls: "mod-cta" }).addEventListener("click", () => {
      const next = this.value; this.close(); if (next && next !== this.currentType) void this.onApply(next);
    });
  }
  onClose() { this.contentEl.empty(); }
}

class DatabaseColorModal extends Modal {
  constructor(app, context, onApply) {
    super(app);
    this.context = context || {};
    this.onApply = onApply;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lmd-db-color-modal");
    contentEl.createEl("h2", { text: "選擇顏色" });
    const grid = contentEl.createDiv({ cls: "lmd-db-color-grid" });
    for (const color of OPTION_COLORS) {
      const button = grid.createEl("button", {
        cls: `lmd-db-color-swatch is-${color}`,
        attr: {
          "aria-label": OPTION_COLOR_LABELS[color] || color,
          title: OPTION_COLOR_LABELS[color] || color,
        },
      });
      button.dataset.color = color;
      if (color === "default") setIcon(button, "rotate-ccw");
      else if (color === "transparent") setIcon(button, "circle-dashed");
      button.addEventListener("click", () => {
        this.close();
        void this.onApply({ color });
      });
    }
  }

  onClose() { this.contentEl.empty(); }
}

const DEFAULT_SETTINGS = {
  experimentalFreeze: false,
  // Markdown-note mode keeps YAML compact by removing emptied properties.
  // CMS-safe mode keeps schema keys present with type-appropriate empty values.
  emptyValuePolicy: "delete",
  initializeSchemaFieldsOnCreate: false,
  embedViewStates: {},
  embedActiveViews: {},
  embedViewStructures: {},
  contextAttachments: {},
};

class LocalMarkdownDatabaseSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Local Markdown Database" });

    containerEl.createEl("h3", { text: "資料寫回" });
    new Setting(containerEl)
      .setName("保留空 Property（CMS 安全模式）")
      .setDesc("關閉時維持筆記模式：欄位清空就移除 YAML key。開啟後，Schema 欄位清空仍保留 key；文字/單選/日期保留為空字串，多選/Relation 保留為 []，Checkbox 為 false，數字為空值。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.emptyValuePolicy === "preserve")
        .onChange(async (value) => {
          this.plugin.settings.emptyValuePolicy = value === true ? "preserve" : "delete";
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("新建條目時初始化 Schema 欄位")
      .setDesc("新建 Markdown 條目時先建立目前 Database 的全部 Schema keys。適合網站 CMS；既有筆記不會被批次修改。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.initializeSchemaFieldsOnCreate === true)
        .onChange(async (value) => {
          this.plugin.settings.initializeSchemaFieldsOnCreate = value === true;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "實驗功能" });
    containerEl.createEl("p", {
      text: "這些功能預設關閉，不會出現在正常介面。",
      cls: "setting-item-description",
    });
    new Setting(containerEl)
      .setName("Freeze 欄位")
      .setDesc("實驗功能。開啟後才會在欄位右鍵選單出現 Freeze。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.experimentalFreeze === true)
        .onChange(async (value) => {
          this.plugin.settings.experimentalFreeze = value === true;
          await this.plugin.saveSettings();
          await this.plugin.refreshOpenDatabaseViews();
        }));
  }
}


class ParentItemPickerModal extends Modal {
  constructor(app, files, currentFile, getStableId, getParentId, onChoose) {
    super(app);
    this.files = Array.isArray(files) ? files : [];
    this.currentFile = currentFile;
    this.getStableId = getStableId;
    this.getParentId = getParentId;
    this.onChoose = onChoose;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lmd-db-parent-picker");
    contentEl.createEl("h3", { text: "變更父項目" });
    const search = contentEl.createEl("input", { cls: "lmd-db-parent-picker-search", attr: { type: "search", placeholder: "搜尋父項目…" } });
    const list = contentEl.createDiv({ cls: "lmd-db-parent-picker-list" });
    const currentId = this.getStableId(this.currentFile);
    const parentById = new Map();
    for (const file of this.files) parentById.set(this.getStableId(file), this.getParentId(file));
    const wouldCycle = (candidateId) => {
      let cursor = candidateId;
      const seen = new Set();
      while (cursor && !seen.has(cursor)) {
        if (cursor === currentId) return true;
        seen.add(cursor);
        cursor = parentById.get(cursor) || "";
      }
      return false;
    };
    const render = () => {
      list.empty();
      const q = String(search.value || "").trim().toLowerCase();
      const root = list.createEl("button", { cls: "lmd-db-parent-picker-item", attr: { type: "button" } });
      setIcon(root, "corner-up-left"); root.createSpan({ text: "根層（沒有父項目）" });
      root.addEventListener("click", () => { this.close(); void this.onChoose(null); });
      for (const file of this.files) {
        const id = this.getStableId(file);
        if (!id || id === currentId || wouldCycle(id)) continue;
        if (q && !String(file.basename || "").toLowerCase().includes(q)) continue;
        const row = list.createEl("button", { cls: "lmd-db-parent-picker-item", attr: { type: "button" } });
        setIcon(row, String(file.extension || "").toLowerCase() === "canvas" ? "layout-dashboard" : "file-text");
        row.createSpan({ text: file.basename });
        row.addEventListener("click", () => { this.close(); void this.onChoose(file); });
      }
    };
    search.addEventListener("input", render);
    render();
    window.setTimeout(() => search.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}



class VersionLineageModal extends Modal {
  constructor(app, renderer, file) { super(app); this.renderer = renderer; this.file = file; }
  async onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl("h2", { text: "版本歷程" });
    let lineage = [];
    try { lineage = await this.renderer.getVersionLineage(this.file); }
    catch (error) { console.error("Local Markdown Database: version lineage modal failed", error); }
    if (!lineage.length) { contentEl.createDiv({ cls:"lmd-db-version-empty", text:"目前沒有版本鏈。" }); return; }
    const list = contentEl.createDiv({ cls:"lmd-db-version-lineage-list" });
    for (const entry of lineage) {
      const row = list.createDiv({ cls:"lmd-db-version-lineage-row" });
      const dot = row.createSpan({ cls:"lmd-db-version-lineage-dot" });
      dot.toggleClass("is-current", entry.status === "current");
      const name = row.createEl("button", { cls:"lmd-db-version-lineage-name", text:entry.file.basename, attr:{type:"button"} });
      name.addEventListener("click", () => { this.close(); void this.app.workspace.openLinkText(entry.file.path, this.file.path, false); });
      const status = row.createSpan({ cls:"lmd-db-version-lineage-status", text: entry.status === "current" ? "目前" : entry.status === "draft" ? "草稿" : "舊版" });
      if (entry.status !== "current") {
        const makeCurrent = row.createEl("button", { cls:"lmd-db-version-lineage-current", text:"設為目前", attr:{type:"button"} });
        makeCurrent.addEventListener("click", async () => { await this.renderer.setCurrentVersion(entry.file); this.close(); new VersionLineageModal(this.app, this.renderer, entry.file).open(); });
      }
    }
    const actions = contentEl.createDiv({ cls:"lmd-db-modal-actions" });
    actions.createEl("button", { text:"關閉" }).addEventListener("click", () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}

class DatabaseFileView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.definition = null;
    this.databaseFile = null;
    this._localValueOverlay = new Map();
    // Keep one Local Markdown Database context menu at a time. A new right-click
    // replaces the previous menu instead of stacking or being ignored.
    this._activeTableContextMenu = null;
    this._editorDepth = 0;
    this._compositionDepth = 0;
    this._pendingExternalRefresh = false;
    this._pendingDefinitionRefresh = false;
  }

  getViewType() { return VIEW_TYPE_DATABASE; }
  getDisplayText() { return (this.definition && this.definition.name) || (this.file && this.file.basename) || "Database"; }
  getIcon() { return "table-2"; }

  showExclusiveTableContextMenu(menu, event) {
    // A fresh right-click replaces the previous Local Markdown Database menu.
    // Never remove generic `.menu` DOM: only hide the Menu instance that LMD
    // itself opened, so native Obsidian/other-plugin menus are untouched.
    const previous = this.plugin?._activeLmdContextMenu || this._activeTableContextMenu;
    if (previous && previous !== menu) {
      try { previous.hide?.(); } catch (_) {}
    }
    this._activeTableContextMenu = menu;
    if (this.plugin) this.plugin._activeLmdContextMenu = menu;
    try {
      menu.showAtMouseEvent(event);
    } catch (error) {
      if (this._activeTableContextMenu === menu) this._activeTableContextMenu = null;
      if (this.plugin?._activeLmdContextMenu === menu) this.plugin._activeLmdContextMenu = null;
      throw error;
    }
    return true;
  }

  async onLoadFile(file) {
    await super.onLoadFile(file);
    this.databaseFile = file;
    this.contentEl.toggleClass?.("lmd-db-mobile-runtime", isLmdMobileRuntime());
    this.plugin?.registerLiveDatabaseRenderer?.(this);
    try {
      await this.loadAndRender(file);
    } catch (error) {
      console.error("Local Markdown Database: view render failed", error);
      this.contentEl.empty();
      this.contentEl.addClass("lmd-db-view", "lmd-db-mobile-render-error");
      const box = this.contentEl.createDiv({ cls:"lmd-db-error" });
      box.createEl("h3", { text:"Database 載入失敗" });
      box.createEl("p", { text:"iPad / Mobile renderer 已啟動，但渲染過程發生錯誤。" });
      box.createEl("pre", { text:String(error?.stack || error || "未知錯誤") });
    }
  }

  async onUnloadFile(file) {
    this.plugin?.unregisterLiveDatabaseRenderer?.(this);
    this.definition = null;
    this.databaseFile = null;
    if (this._activeTableContextMenu) {
      try { this._activeTableContextMenu.hide?.(); } catch (_) {}
      if (this.plugin?._activeLmdContextMenu === this._activeTableContextMenu) this.plugin._activeLmdContextMenu = null;
    }
    this._activeTableContextMenu = null;
    this.contentEl.empty();
    await super.onUnloadFile(file);
  }

  getVerticalScrollOwner() {
    let el = this.contentEl;
    while (el) {
      try {
        const style = window.getComputedStyle(el);
        const oy = style.overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
      } catch (_) {}
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  captureScrollState() {
    const owner = this.getVerticalScrollOwner();
    const tableWrap = this.contentEl.querySelector(".lmd-db-table-wrap");
    return {
      owner,
      top: Number(owner?.scrollTop) || 0,
      left: Number(tableWrap?.scrollLeft) || 0,
    };
  }

  restoreScrollState(state) {
    if (!state) return;
    const restore = () => {
      try { if (state.owner?.isConnected) state.owner.scrollTop = state.top; } catch (_) {}
      try {
        const tableWrap = this.contentEl.querySelector(".lmd-db-table-wrap");
        if (tableWrap) tableWrap.scrollLeft = state.left;
      } catch (_) {}
    };
    restore();
    requestAnimationFrame(() => { restore(); requestAnimationFrame(restore); });
  }

  async loadAndRender(file, options = {}) {
    // Never tear down an active cell editor. Chromium/Windows IMEs keep their
    // composition target by DOM identity; rebuilding the table while a text field
    // is focused is what produces the detached Zhuyin box in the desktop corner.
    // Queue the refresh and apply it after the editor releases focus instead.
    if (options?.force !== true && ((this._editorDepth || 0) > 0 || (this._compositionDepth || 0) > 0)) {
      this._pendingExternalRefresh = true;
      return;
    }
    if (this.renderAbortController) this.renderAbortController.abort();
    this.renderAbortController = new AbortController();
    const scrollState = this.definition && this.databaseFile?.path === file.path ? this.captureScrollState() : null;
    this.contentEl.empty();
    this.contentEl.addClass("lmd-db-view");

    let parsed;
    if (this.isEmbedded === true && this.definition && this.databaseFile?.path === file.path) {
      // Embedded Database instances own a transient copy of the selected view.
      // Re-renders caused by editing rows must keep that local filter/sort state
      // instead of re-reading (and therefore mutating) the source .database view.
      parsed = this.definition;
    } else {
      const raw = await this.app.vault.read(file);
      try { parsed = JSON.parse(raw); }
      catch (error) {
        this.renderError("這個 .database 檔案不是有效的 JSON。", String(error));
        return;
      }
    }

    if (!isDatabaseDefinition(parsed)) {
      this.renderError("這個 .database 檔案不符合目前格式。", "需要 version、folder source 與 schema。" );
      return;
    }

    if (!Array.isArray(parsed.schema)) parsed.schema = [];
    // Plugin-owned metadata remains in Markdown frontmatter for identity/backlinks,
    // but it is never a user-facing database property. Also scrub legacy schemas
    // that accidentally persisted these fields in older versions.
    parsed.schema = parsed.schema.filter((field) => field?.id && !isSystemMetadataField(field.id));
    if (this.isEmbedded !== true && !parsed.id) {
      parsed.id = generateSourceId();
      try { await this.app.vault.modify(file, JSON.stringify(parsed, null, 2)); }
      catch (error) { console.error("Local Markdown Database: failed to assign database id", error); }
    }
    this.definition = parsed;
    await this.renderDatabase(file, parsed);
    this.restoreScrollState(scrollState);
  }

  async openDatabaseItem(file, databaseFile) {
    if (!(file instanceof TFile) || !(databaseFile instanceof TFile)) return;
    if (this.isCanvasItem(file)) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    // Keep one lightweight, human-visible return link in Properties. It follows the
    // database file path and is refreshed whenever the note is opened from a View.
    const backlink = `[[${databaseFile.path}]]`;
    try {
      const cache = this.app.metadataCache.getFileCache(file);
      const current = cache?.frontmatter?.["lmd-database"];
      if (current !== backlink) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => { frontmatter["lmd-database"] = backlink; });
      }
    } catch (error) { console.warn("Local Markdown Database: failed to write database backlink", error); }
    void this.app.workspace.openLinkText(file.path, databaseFile.path, false);
  }

  async noteHasBodyContent(file) {
    if (!(file instanceof TFile) || this.isCanvasItem(file)) return false;
    try {
      let text = await this.app.vault.cachedRead(file);
      if (text.startsWith("---")) {
        const end = text.indexOf("\n---", 3);
        if (end >= 0) text = text.slice(end + 4);
      }
      return text.trim().length > 0;
    } catch (_) { return false; }
  }

  filterOperatorLabel(operator) {
    return ({eq:"等於",neq:"不等於",gt:"大於",gte:"大於等於",lt:"小於",lte:"小於等於",before:"早於",after:"晚於",contains:"包含","not-contains":"不包含",starts:"開頭是",ends:"結尾是",empty:"為空","not-empty":"不為空",checked:"已勾選",unchecked:"未勾選"})[operator] || operator;
  }

  beginEditorSession() {
    this._editorDepth = (this._editorDepth || 0) + 1;
  }

  endEditorSession() {
    this._editorDepth = Math.max(0, (this._editorDepth || 0) - 1);
    this.flushDeferredRendererRefresh();
  }

  beginCompositionSession() {
    this._compositionDepth = (this._compositionDepth || 0) + 1;
  }

  endCompositionSession() {
    this._compositionDepth = Math.max(0, (this._compositionDepth || 0) - 1);
    this.flushDeferredRendererRefresh();
  }

  flushDeferredRendererRefresh() {
    if ((this._editorDepth || 0) > 0 || (this._compositionDepth || 0) > 0) return;
    if (!this.databaseFile || !this.contentEl?.isConnected) return;
    if (this._pendingDefinitionRefresh) {
      this._pendingDefinitionRefresh = false;
      this._pendingExternalRefresh = false;
      // Re-enter the normal definition refresh path after focus/composition ends so
      // embedded views keep their local tab/filter state while receiving fresh schema.
      void this.plugin?.broadcastDatabaseDefinitionChange?.(this.databaseFile);
      return;
    }
    if (!this._pendingExternalRefresh) return;
    this._pendingExternalRefresh = false;
    this._externalRefreshQueue = (this._externalRefreshQueue || Promise.resolve())
      .catch(() => {})
      .then(() => this.loadAndRender(this.databaseFile, { force: true }));
    void this._externalRefreshQueue.catch((error) => console.error("Local Markdown Database: deferred refresh failed", error));
  }

  repaintSelectOptionColors(field) {
    if (!field?.id || !this.contentEl) return;
    for (const cell of this.contentEl.querySelectorAll('.lmd-db-data-cell')) {
      if (cell.dataset.fieldId !== field.id) continue;
      for (const chip of cell.querySelectorAll('.lmd-db-option-chip')) {
        const value = chip.dataset.optionValue || chip.textContent || '';
        for (const color of OPTION_COLORS) chip.removeClass(`is-${color}`);
        chip.addClass(`is-${normalizeOptionColor(field.optionColors?.[value])}`);
      }
    }
  }

  renderError(title, detail) {
    const wrap = this.contentEl.createDiv({ cls: "lmd-db-error" });
    wrap.createEl("h2", { text: title });
    wrap.createEl("pre", { text: detail });
  }

  getEmbedStateKey(viewId = "") {
    if (this.embedInstancePrefix) return `${this.embedInstancePrefix}::${String(viewId || "")}`;
    return this.embedStateKey || "";
  }

  async applyEmbeddedViewState(definition, viewId) {
    if (this.isEmbedded !== true || !viewId) return;
    const key = this.getEmbedStateKey(viewId);
    const state = this.plugin?.getEmbeddedViewState?.(key);
    const entry = definition?.views?.find((item) => item?.id === viewId);
    if (state && entry) entry.state = Object.assign({}, entry.state || {}, state);
  }

  async saveViewStructure(databaseFile, definition) {
    if (this.isEmbedded !== true) {
      await this.saveDefinition(databaseFile, definition);
      return;
    }
    // Embedded tab structure belongs to this Markdown embed instance only.
    // Never write add/rename/delete/reorder operations back into the source .database.
    if (this.embedInstancePrefix && this.plugin?.saveEmbeddedViewStructure) {
      await this.plugin.saveEmbeddedViewStructure(this.embedInstancePrefix, definition);
    }
    if (this.embedInstancePrefix && this.plugin?.saveEmbeddedActiveView) {
      await this.plugin.saveEmbeddedActiveView(this.embedInstancePrefix, definition?.activeViewId || "");
    }
  }

  async saveCurrentViewState(databaseFile, definition) {
    if (this.isEmbedded === true) {
      await this.saveDefinition(databaseFile, definition);
      return;
    }
    const activeId = String(definition?.activeViewId || "");
    const activeEntry = definition?.views?.find((item) => String(item?.id || "") === activeId);
    if (!activeEntry || !(databaseFile instanceof TFile)) {
      await this.saveDefinition(databaseFile, definition);
      return;
    }
    // Filters/sorts are view-local state. Merge only that active state into the
    // latest on-disk definition so another open renderer cannot overwrite it with
    // an older full-definition snapshot a moment later. The .database file remains
    // the portable source of truth, so desktop/mobile see the same filter state.
    try {
      const raw = await this.app.vault.read(databaseFile);
      const latest = JSON.parse(raw);
      if (!isDatabaseDefinition(latest)) throw new Error("Invalid database definition");
      const target = Array.isArray(latest.views) ? latest.views.find((item) => String(item?.id || "") === activeId) : null;
      if (!target) { await this.saveDefinition(databaseFile, definition); return; }
      target.state = JSON.parse(JSON.stringify(activeEntry.state || {}));
      latest.activeViewId = activeId;
      this._suppressOwnDefinitionRefreshUntil = Date.now() + 1200;
      await this.app.vault.modify(databaseFile, JSON.stringify(latest, null, 2));
      // Keep this renderer aligned with the merged on-disk definition.
      definition.views = latest.views;
      definition.activeViewId = latest.activeViewId;
      this.definition = definition;
    } catch (error) {
      console.warn("Local Markdown Database: active view state merge failed; falling back to full save", error);
      await this.saveDefinition(databaseFile, definition);
    }
  }

  async saveDefinition(databaseFile, definition) {
    if (this.isEmbedded === true) {
      // Embedded filters/sorts/layout are instance-local. Persist only the active
      // embedded view state in plugin data; never write the cloned definition back
      // to the source .database file.
      const key = this.getEmbedStateKey(definition?.activeViewId);
      if (key && this.plugin?.saveEmbeddedViewState) {
        const entry = definition?.views?.find((item) => item?.id === definition?.activeViewId);
        if (entry?.state) {
          await this.plugin.saveEmbeddedViewState(key, entry.state);
          // Keep a portable copy inside the .database file as well. Unlike plugin
          // data.json this travels with the vault to mobile and another computer.
          if (this.embedInstancePrefix && this.plugin?.savePortableEmbeddedViewState) {
            await this.plugin.savePortableEmbeddedViewState(this.databaseFile, this.embedInstancePrefix, definition?.activeViewId || "", entry.state);
          }
        }
      }
      if (this.embedInstancePrefix && this.plugin?.saveEmbeddedActiveView) await this.plugin.saveEmbeddedActiveView(this.embedInstancePrefix, definition?.activeViewId || "");
      return;
    }
    // Serialize definition writes. Table drag/resize/filter operations can finish
    // close together; an older async write must never land after a newer manualOrder.
    const payload = JSON.stringify(definition, null, 2);
    this._definitionSaveQueue = (this._definitionSaveQueue || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // 0.14.5 — this renderer already owns the in-memory definition it is saving.
        // Obsidian will emit a vault "modify" event for the same write; do not let
        // that event immediately full-render this same renderer a second time. Other
        // live renderers still receive the definition change normally.
        this._suppressOwnDefinitionRefreshUntil = Date.now() + 1200;
        await this.app.vault.modify(databaseFile, payload);
      });
    await this._definitionSaveQueue;
  }

  getExpandedAttachmentRows() {
    if (!(this._expandedAttachmentRows instanceof Set)) this._expandedAttachmentRows = new Set();
    return this._expandedAttachmentRows;
  }

  getAttachmentOwnerKey(file) {
    return this.getStableItemId(file) || file.path;
  }

  async resolveContextAttachmentRef(ref) {
    if (!ref) return null;
    let file = ref.itemId ? await this.plugin.findMarkdownFileByStableId(ref.itemId) : null;
    if (!(file instanceof TFile) && ref.path) file = this.app.vault.getAbstractFileByPath(normalizePath(ref.path));
    if (!(file instanceof TFile)) return null;
    if (file.path !== ref.path) ref.path = file.path;
    return file;
  }

  async renderInlineAttachmentTree(container, ownerFile) {
    container.empty();
    const ownerId = await this.plugin.ensureStableItemIdForFile(ownerFile);
    const model = this.plugin.getContextAttachmentModel(ownerId) || { version: 1, groups: [] };
    if (!model.groups.length) {
      container.createDiv({ cls: "lmd-db-inline-attachment-empty", text: "尚無附屬（右鍵筆記 → 附屬… 可新增）" });
      return;
    }
    for (const group of model.groups) {
      const groupEl = container.createDiv({ cls: "lmd-db-inline-attachment-group", attr: { "data-group-id": group.id } });
      const head = groupEl.createEl("button", { cls: "lmd-db-inline-attachment-group-head", attr: { type: "button" } });
      const chev = head.createSpan({ cls: "lmd-db-inline-attachment-chevron" }); setIcon(chev, group.collapsed ? "chevron-right" : "chevron-down");
      head.createSpan({ cls: "lmd-db-inline-attachment-group-name", text: group.name || "附屬" });
      head.createSpan({ cls: "lmd-db-inline-attachment-group-count", text: String(group.items.length) });
      head.addEventListener("click", async (event) => {
        event.preventDefault(); event.stopPropagation();
        group.collapsed = !group.collapsed;
        await this.plugin.saveContextAttachmentModel(ownerId, model);
        await this.renderInlineAttachmentTree(container, ownerFile);
      });
      if (group.collapsed) continue;
      const list = groupEl.createDiv({ cls: "lmd-db-inline-attachment-list" });
      if (!group.items.length) list.createDiv({ cls: "lmd-db-inline-attachment-empty-group", text: "（空）" });
      group.items.forEach((ref, index) => {
        const item = list.createDiv({ cls: "lmd-db-inline-attachment-item", attr: { "data-index": String(index) } });
        const branch = item.createSpan({ cls: "lmd-db-inline-attachment-branch" });
        branch.setText(index === group.items.length - 1 ? "└" : "├");
        const link = item.createEl("button", { cls: "lmd-db-inline-attachment-link", attr: { type: "button" } });
        const icon = link.createSpan({ cls: "lmd-db-inline-attachment-file-icon" }); setIcon(icon, "file");
        const title = link.createSpan({ text: pathBasenameNoExt(ref.path || ref.itemId || "遺失附屬") });
        void this.resolveContextAttachmentRef(ref).then((file) => {
          if (!item.isConnected) return;
          if (file) { title.setText(file.basename); link.title = file.path; }
          else { item.addClass("is-missing"); link.title = "找不到原始 Markdown"; }
        });
        link.addEventListener("click", async (event) => {
          event.preventDefault(); event.stopPropagation();
          const file = await this.resolveContextAttachmentRef(ref);
          if (file) await this.app.workspace.getLeaf(false).openFile(file);
          else new Notice("找不到這個附屬的原始 Markdown。");
        });
        const noteText = String(ref.note || "").trim();
        if (noteText) {
          const note = item.createSpan({ cls: "lmd-db-inline-attachment-note", text: noteText });
          note.title = noteText;
        }
        item.addEventListener("contextmenu", (event) => {
          event.preventDefault(); event.stopPropagation();
          const menu = new Menu();
          menu.addItem((entry) => entry.setTitle("移出附屬").setIcon("x").onClick(async () => {
            group.items.splice(index, 1);
            await this.plugin.saveContextAttachmentModel(ownerId, model);
            await this.renderInlineAttachmentTree(container, ownerFile);
          }));
          menu.showAtMouseEvent(event);
        });

        // Inline list ordering is intentionally a long-press gesture: quick click opens
        // the Markdown, while holding for ~260 ms arms drag-to-reorder within the group.
        let armTimer = 0; let armed = false;
        const disarm = () => { if (armTimer) window.clearTimeout(armTimer); armTimer = 0; if (!item.matches(':active')) item.draggable = false; };
        item.addEventListener("pointerdown", (event) => {
          if (!isLmdPrimaryPointer(event)) return;
          armTimer = window.setTimeout(() => { armed = true; item.draggable = true; item.addClass("is-reorder-armed"); }, 260);
        });
        item.addEventListener("pointerup", () => { disarm(); window.setTimeout(() => { armed = false; item.draggable = false; item.removeClass("is-reorder-armed"); }, 0); });
        item.addEventListener("pointercancel", () => { disarm(); armed = false; item.draggable = false; item.removeClass("is-reorder-armed"); });
        item.addEventListener("dragstart", (event) => {
          if (!armed) { event.preventDefault(); return; }
          item.addClass("is-dragging");
          if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/lmd-inline-attachment", JSON.stringify({ groupId: group.id, index })); }
        });
        item.addEventListener("dragend", () => { item.removeClass("is-dragging", "is-drag-before", "is-drag-after", "is-reorder-armed"); item.draggable = false; armed = false; });
        item.addEventListener("dragover", (event) => {
          const raw = event.dataTransfer?.getData("text/lmd-inline-attachment") || "";
          if (!raw) return; event.preventDefault();
          list.querySelectorAll('.is-drag-before,.is-drag-after').forEach((el) => { el.removeClass('is-drag-before'); el.removeClass('is-drag-after'); });
          const rect = item.getBoundingClientRect(); item.addClass(event.clientY < rect.top + rect.height / 2 ? "is-drag-before" : "is-drag-after");
        });
        item.addEventListener("drop", async (event) => {
          const raw = event.dataTransfer?.getData("text/lmd-inline-attachment") || "";
          if (!raw) return; event.preventDefault(); event.stopPropagation();
          let data = null; try { data = JSON.parse(raw); } catch (_) {}
          if (!data || data.groupId !== group.id || data.index === index) return;
          const rect = item.getBoundingClientRect(); let toIndex = index + (event.clientY < rect.top + rect.height / 2 ? 0 : 1);
          const fromIndex = Number(data.index); const [moved] = group.items.splice(fromIndex, 1);
          if (toIndex > fromIndex) toIndex -= 1;
          group.items.splice(Math.max(0, Math.min(toIndex, group.items.length)), 0, moved);
          await this.plugin.saveContextAttachmentModel(ownerId, model);
          await this.renderInlineAttachmentTree(container, ownerFile);
        });
      });
    }
  }

  async ensureInlineAttachmentRow(ownerTr, file, columnCount) {
    if (!(ownerTr instanceof HTMLElement) || !ownerTr.isConnected) return null;
    const ownerKey = this.getAttachmentOwnerKey(file);
    const next = ownerTr.nextElementSibling;
    if (next instanceof HTMLElement && next.hasClass("lmd-db-attachment-inline-row") && next.dataset.ownerKey === ownerKey) return next;
    const detail = document.createElement("tr");
    detail.className = "lmd-db-attachment-inline-row"; detail.dataset.ownerKey = ownerKey; detail.dataset.ownerPath = file.path;
    const td = document.createElement("td"); td.className = "lmd-db-attachment-inline-cell"; td.colSpan = Math.max(1, Number(columnCount) || 1);
    const tree = document.createElement("div"); tree.className = "lmd-db-inline-attachment-tree"; td.appendChild(tree); detail.appendChild(td);
    ownerTr.insertAdjacentElement("afterend", detail);
    await this.renderInlineAttachmentTree(tree, file);
    return detail;
  }

  async toggleInlineAttachments(ownerTr, file, columnCount) {
    const ownerKey = this.getAttachmentOwnerKey(file);
    const expanded = this.getExpandedAttachmentRows();
    const next = ownerTr.nextElementSibling;
    if (next instanceof HTMLElement && next.hasClass("lmd-db-attachment-inline-row") && next.dataset.ownerKey === ownerKey) {
      next.remove(); expanded.delete(ownerKey); return false;
    }
    expanded.add(ownerKey); await this.ensureInlineAttachmentRow(ownerTr, file, columnCount); return true;
  }

  async refreshInlineAttachmentRowsForFile(file) {
    if (!(this.contentEl instanceof HTMLElement)) return;
    for (const row of this.contentEl.querySelectorAll(".lmd-db-attachment-inline-row")) {
      if (!(row instanceof HTMLElement) || row.dataset.ownerPath !== file.path) continue;
      const tree = row.querySelector(".lmd-db-inline-attachment-tree");
      if (tree instanceof HTMLElement) await this.renderInlineAttachmentTree(tree, file);
    }
  }

  installMobileContextMenuFallback(root) {
    if (!isLmdMobileRuntime() || !(root instanceof HTMLElement)) return;
    const signal = this.renderAbortController?.signal;
    root.addClass("lmd-db-mobile-pointer-compat");
    let holdTimer = 0;
    let startX = 0, startY = 0, startTarget = null;
    const clearHold = () => { if (holdTimer) window.clearTimeout(holdTimer); holdTimer = 0; startTarget = null; };
    const fireContext = (target, event) => {
      if (!(target instanceof HTMLElement) || !target.isConnected) return;
      const synthetic = new MouseEvent("contextmenu", { bubbles:true, cancelable:true, clientX:event.clientX, clientY:event.clientY, screenX:event.screenX || 0, screenY:event.screenY || 0, button:2, buttons:0 });
      target.dispatchEvent(synthetic);
    };
    root.addEventListener("pointerdown", (event) => {
      if (!isLmdPrimaryPointer(event)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || target.closest("input, textarea, select")) return;
      // Long-press fallback is only for touch/pen. Trackpad/mouse keeps native
      // secondary-click behavior so normal selection is never delayed.
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      clearHold(); startX = event.clientX; startY = event.clientY; startTarget = target;
      holdTimer = window.setTimeout(() => { const t = startTarget; holdTimer = 0; startTarget = null; if (t) fireContext(t, event); }, 520);
    }, { capture:true, signal });
    root.addEventListener("pointermove", (event) => { if (holdTimer && Math.hypot(event.clientX-startX, event.clientY-startY) > 10) clearHold(); }, { capture:true, signal });
    root.addEventListener("pointerup", clearHold, { capture:true, signal });
    root.addEventListener("pointercancel", clearHold, { capture:true, signal });
  }

  installCtrlWheelZoom(target, databaseFile, definition, view, onZoom = null) {
    if (!(target instanceof HTMLElement)) return;
    const signal = this.renderAbortController?.signal;
    if (isLmdMobileRuntime()) {
      target.style.zoom = "1";
      if (target.matches?.(".lmd-db-table")) target.style.setProperty("--lmd-table-grid-width", "1px");
      if (typeof onZoom === "function") onZoom(1);
      return;
    }
    const apply = () => {
      const scale = Math.max(0.5, Math.min(1.6, Number(view.zoom) || 1));
      target.style.zoom = String(scale);
      // A physical 1px border becomes sub-pixel under CSS zoom (e.g. 0.5px at
      // 50%), and Chromium may rasterize alternating table borders away. Keep
      // the table grid approximately one visible pixel by compensating in the
      // table's own pre-zoom coordinate space. Other view types simply ignore
      // this custom property.
      if (target.matches?.(".lmd-db-table")) {
        target.style.setProperty("--lmd-table-grid-width", `${1 / scale}px`);
      }
      if (typeof onZoom === "function") onZoom(scale);
    };
    apply();
    let saveTimer = 0;
    const saveLater = () => {
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = 0;
        void this.saveDefinition(databaseFile, definition);
      }, 240);
    };
    target.addEventListener("wheel", (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const current = Math.max(0.5, Math.min(1.6, Number(view.zoom) || 1));
      const direction = event.deltaY < 0 ? 1 : -1;
      let next = Math.round((current + direction * 0.05) * 20) / 20;
      next = Math.max(0.5, Math.min(1.6, next));
      if (next === current) return;
      view.zoom = next;
      apply();
      saveLater();
    }, { passive: false, signal });
    signal?.addEventListener("abort", () => {
      if (saveTimer) window.clearTimeout(saveTimer);
    }, { once: true });
  }

  installHorizontalWheelPriority(target) {
    if (!(target instanceof HTMLElement)) return;
    if (isLmdMobileRuntime()) return;
    const signal = this.renderAbortController?.signal;
    target.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const max = Math.max(0, target.scrollWidth - target.clientWidth);
      if (max <= 2) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const before = target.scrollLeft;
      const next = Math.max(0, Math.min(max, before + delta));
      // If this View has a horizontal overflow, the wheel belongs to the View for
      // the whole hover session — including its left/right edges. Do not suddenly
      // hand the same vertical wheel gesture back to the outer Markdown page.
      event.preventDefault(); event.stopPropagation();
      target.scrollLeft = next;
    }, { passive:false, signal });
  }

  installEmbeddedHorizontalWheelRouting(root) {
    if (this.isEmbedded !== true || !(root instanceof HTMLElement)) return;
    if (isLmdMobileRuntime()) return;
    const signal = this.renderAbortController?.signal;
    root.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      let target = event.target instanceof HTMLElement ? event.target : null;
      let scrollTarget = null;
      while (target && target !== root) {
        if (target.scrollWidth > target.clientWidth + 2) { scrollTarget = target; break; }
        target = target.parentElement;
      }
      if (!scrollTarget) {
        const candidates = root.querySelectorAll(".lmd-db-table-wrap,.lmd-db-board,.lmd-db-calendar,.lmd-db-calendar-week,.lmd-db-calendar-year,.lmd-db-timeline-scroll,.lmd-db-timeline");
        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement)) continue;
          if (candidate.scrollWidth <= candidate.clientWidth + 2) continue;
          const rect = candidate.getBoundingClientRect();
          if (event.clientY >= rect.top && event.clientY <= rect.bottom) { scrollTarget = candidate; break; }
        }
      }
      if (!scrollTarget) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      const max = Math.max(0, scrollTarget.scrollWidth - scrollTarget.clientWidth);
      scrollTarget.scrollLeft = Math.max(0, Math.min(max, scrollTarget.scrollLeft + delta));
    }, { passive: false, capture: true, signal });
  }

  installViewportHorizontalScrollbar(source, contentWidthProvider = null) {
    if (!(source instanceof HTMLElement)) return () => {};
    const signal = this.renderAbortController?.signal;

    // iPadOS / Obsidian Mobile: never create a body-level fixed scrollbar. Mobile
    // WebKit can position fixed overlays against the visual viewport and intercept
    // pointer events. Keep the table's native two-axis scrolling instead.
    if (isLmdMobileRuntime()) {
      source.addClass("lmd-db-mobile-native-scroll");
      source.removeClass("has-sticky-x-scroll");
      const updateMobile = () => source.toggleClass("is-horizontally-scrollable", source.scrollWidth > source.clientWidth + 2);
      const ro = new ResizeObserver(updateMobile);
      ro.observe(source);
      const first = source.firstElementChild;
      if (first instanceof HTMLElement) ro.observe(first);
      signal?.addEventListener("abort", () => ro.disconnect(), { once: true });
      requestAnimationFrame(() => { updateMobile(); requestAnimationFrame(updateMobile); });
      return updateMobile;
    }

    // Embedded database views own their horizontal scrolling. A body-level floating
    // scrollbar belongs to a full database leaf and is actively harmful when several
    // embeds live in the same Markdown note. Keep the native scrollbar on each embed.
    if (this.isEmbedded === true) {
      source.addClass("lmd-db-embed-x-scroll");
      source.removeClass("has-sticky-x-scroll");
      const updateEmbedded = () => {
        if (!source.isConnected) return;
        source.toggleClass("is-horizontally-scrollable", source.scrollWidth > source.clientWidth + 2);
      };
      const ro = new ResizeObserver(updateEmbedded);
      ro.observe(source);
      const first = source.firstElementChild;
      if (first instanceof HTMLElement) ro.observe(first);
      signal?.addEventListener("abort", () => ro.disconnect(), { once: true });
      requestAnimationFrame(() => { updateEmbedded(); requestAnimationFrame(updateEmbedded); });
      return updateEmbedded;
    }

    source.addClass("has-sticky-x-scroll");

    // The bar must live under <body>, not inside .view-content. Obsidian themes and
    // Electron panes can create containing blocks that make a nested fixed element
    // behave as if it were part of the document flow.
    const bar = document.body.createDiv({ cls: "lmd-db-sticky-x-scroll", attr: { "aria-label": "水平捲動" } });
    const inner = bar.createDiv({ cls: "lmd-db-sticky-x-scroll-inner" });
    signal?.addEventListener("abort", () => bar.remove(), { once: true });

    const viewContent = this.contentEl.closest(".view-content");
    let syncing = false;

    const getContentWidth = () => {
      try {
        const provided = typeof contentWidthProvider === "function" ? Number(contentWidthProvider()) : 0;
        return Math.max(provided || 0, Number(source.scrollWidth) || 0);
      } catch (_) {
        return Number(source.scrollWidth) || 0;
      }
    };

    const update = () => {
      if (!source.isConnected || !this.contentEl.isConnected) {
        bar.remove();
        return;
      }
      const sourceRect = source.getBoundingClientRect();
      const rootRect = this.contentEl.getBoundingClientRect();
      const viewRect = viewContent instanceof HTMLElement
        ? viewContent.getBoundingClientRect()
        : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
      // 0.9.4: anchor to the actual pane/window bottom. Do not reserve extra
      // space for Obsidian's status bar; the floating horizontal scrollbar should
      // visually meet the bottom edge just like the native vertical scrollbar.
      const viewportBottom = Math.min(viewRect.bottom, window.innerHeight);

      // Use the pane viewport as the clipping boundary. The scroll source itself can
      // be wider than the pane, so sourceRect.right is not a reliable visible edge.
      const left = Math.max(viewRect.left, sourceRect.left, 0);
      const right = Math.min(viewRect.right, window.innerWidth);
      const width = Math.max(0, right - left);
      const contentWidth = Math.max(width, getContentWidth());
      const verticallyRelevant = rootRect.bottom > viewRect.top && rootRect.top < viewportBottom;
      const needsScroll = contentWidth > width + 2;

      bar.style.left = `${Math.round(left)}px`;
      bar.style.width = `${Math.round(width)}px`;
      bar.style.bottom = `${Math.max(0, Math.round(window.innerHeight - viewportBottom)) + 2}px`;
      inner.style.width = `${Math.ceil(contentWidth)}px`;
      bar.toggleClass("is-visible", verticallyRelevant && needsScroll && width > 40);
      if (!syncing) bar.scrollLeft = source.scrollLeft;
    };

    source.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      bar.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    }, { passive: true, signal });
    bar.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      source.scrollLeft = bar.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    }, { passive: true, signal });
    if (viewContent instanceof HTMLElement) {
      viewContent.addEventListener("scroll", update, { passive: true, signal });
    }
    window.addEventListener("resize", update, { signal });
    window.addEventListener("scroll", update, { passive: true, signal });

    const ro = new ResizeObserver(update);
    ro.observe(source);
    const first = source.firstElementChild;
    if (first instanceof HTMLElement) ro.observe(first);
    signal?.addEventListener("abort", () => ro.disconnect(), { once: true });

    requestAnimationFrame(() => { update(); requestAnimationFrame(update); });
    return update;
  }

  ensureViewState(definition, schema) {
    const makeId = () => `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const legacyView = definition.view && typeof definition.view === "object" ? definition.view : {};
    if (!Array.isArray(definition.views) || definition.views.length === 0) {
      definition.views = [{ id: makeId(), name: "表格", type: "table", state: legacyView }];
      definition.activeViewId = definition.views[0].id;
    }
    definition.views = definition.views.filter((entry) => entry && typeof entry === "object").map((entry, index) => ({
      id: typeof entry.id === "string" && entry.id ? entry.id : makeId(),
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `View ${index + 1}`,
      type: ["board", "calendar", "timeline"].includes(entry.type) ? entry.type : "table",
      state: entry.state && typeof entry.state === "object" ? entry.state : {},
    }));
    let activeEntry = definition.views.find((entry) => entry.id === definition.activeViewId);
    if (!activeEntry) activeEntry = definition.views[0];
    definition.activeViewId = activeEntry.id;
    const state = activeEntry.state;
    if (!Array.isArray(state.columnOrder)) state.columnOrder = [];
    if (!state.columnWidths || typeof state.columnWidths !== "object") state.columnWidths = {};
    if (!Array.isArray(state.manualOrder)) state.manualOrder = [];
    state.manualOrder = Array.from(new Set(state.manualOrder.filter((path) => typeof path === "string" && path)));
    if (!Array.isArray(state.sort)) state.sort = [];
    if (!Array.isArray(state.filters)) state.filters = [];
    if (typeof state.wrap !== "boolean") state.wrap = false;
    if (typeof state.toolbarCollapsed !== "boolean") state.toolbarCollapsed = false;
    if (!Array.isArray(state.hiddenColumns)) state.hiddenColumns = [];
    if (!Number.isFinite(state.zoom)) state.zoom = 1;
    state.zoom = Math.max(0.5, Math.min(1.6, Number(state.zoom) || 1));
    if (!Number.isInteger(state.freezeColumns) || state.freezeColumns < 0) state.freezeColumns = 0;
    if (!state.rowColors || typeof state.rowColors !== "object" || Array.isArray(state.rowColors)) state.rowColors = {};
    if (!state.columnColors || typeof state.columnColors !== "object" || Array.isArray(state.columnColors)) state.columnColors = {};
    if (!state.cellColors || typeof state.cellColors !== "object" || Array.isArray(state.cellColors)) state.cellColors = {};
    if (!state.headerColors || typeof state.headerColors !== "object" || Array.isArray(state.headerColors)) state.headerColors = {};
    if (typeof state.headerRowColor !== "string") state.headerRowColor = "default";
    if (typeof state.titleColumnName !== "string") state.titleColumnName = "名稱";
    if (typeof state.boardGroupBy !== "string") state.boardGroupBy = "";
    if (!Array.isArray(state.boardGroupOrder)) state.boardGroupOrder = [];
    if (!Array.isArray(state.boardHiddenGroups)) state.boardHiddenGroups = [];
    if (!Array.isArray(state.boardCardFields)) state.boardCardFields = [];
    if (typeof state.tableGroupBy !== "string") state.tableGroupBy = "";
    if (!Array.isArray(state.tableCollapsedGroups)) state.tableCollapsedGroups = [];
    if (!Array.isArray(state.tableCollapsedParents)) state.tableCollapsedParents = [];
    if (!["direct", "descendants"].includes(state.tableProgressScope)) state.tableProgressScope = "descendants";
    if (typeof state.tableProgressField !== "string") state.tableProgressField = "";
    if (!Array.isArray(state.tableGroupOrder)) state.tableGroupOrder = [];
    if (!Array.isArray(state.tableHiddenGroups)) state.tableHiddenGroups = [];
    if (typeof state.calendarDateField !== "string") state.calendarDateField = "";
    if (!Array.isArray(state.calendarCardFields)) state.calendarCardFields = [];
    if (!Array.isArray(state.calendarShadowSources)) state.calendarShadowSources = [];
    state.calendarShadowSources = state.calendarShadowSources.filter((entry) => entry && typeof entry === "object" && typeof entry.databasePath === "string").map((entry) => ({ databasePath: normalizePath(entry.databasePath), dateField: typeof entry.dateField === "string" ? entry.dateField : "", enabled: entry.enabled !== false }));
    if (!["year", "month", "week", "day"].includes(state.calendarScale)) state.calendarScale = "month";
    if (typeof state.calendarFocusDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(state.calendarFocusDate)) state.calendarFocusDate = "";
    if (typeof state.timelineDateField !== "string") state.timelineDateField = "";
    if (typeof state.timelineStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(state.timelineStart)) {
      const now = new Date();
      state.timelineStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    }
    if (typeof state.timelineRangeStart !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(state.timelineRangeStart)) state.timelineRangeStart = `${state.timelineStart}T08:00`;
    if (typeof state.timelineRangeEnd !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(state.timelineRangeEnd) || new Date(state.timelineRangeEnd) <= new Date(state.timelineRangeStart)) { const d=new Date(state.timelineRangeStart); d.setHours(d.getHours()+12); state.timelineRangeEnd=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}T${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
    if (![5,10,15,30,60].includes(Number(state.timelineSnapMinutes))) state.timelineSnapMinutes = 10;
    if (typeof state.timelinePlayhead !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(state.timelinePlayhead)) state.timelinePlayhead = state.timelineRangeStart;
    if (!["log", "inspector"].includes(state.timelineSidePanelMode)) state.timelineSidePanelMode = "log";
    if (!["static", "playback"].includes(state.timelineInteractionMode)) state.timelineInteractionMode = "playback";
    if (!state.timelineBarColors || typeof state.timelineBarColors !== "object" || Array.isArray(state.timelineBarColors)) state.timelineBarColors = {};
    for (const key of Object.keys(state.timelineBarColors)) state.timelineBarColors[key] = normalizeOptionColor(state.timelineBarColors[key]);
    if (!Array.isArray(state.timelineLaneOrder)) state.timelineLaneOrder = [];
    state.timelineLaneOrder = Array.from(new Set(state.timelineLaneOrder.filter((value) => typeof value === "string" && value)));
    if (!state.timelineLaneColors || typeof state.timelineLaneColors !== "object" || Array.isArray(state.timelineLaneColors)) state.timelineLaneColors = {};
    for (const key of Object.keys(state.timelineLaneColors)) state.timelineLaneColors[key] = normalizeOptionColor(state.timelineLaneColors[key]);
    if (!Array.isArray(state.timelineShadowSources)) state.timelineShadowSources = [];
    state.timelineShadowSources = state.timelineShadowSources.filter((entry)=>entry&&typeof entry==="object"&&typeof entry.databasePath==="string").map((entry)=>({databasePath:normalizePath(entry.databasePath),dateField:typeof entry.dateField==="string"?entry.dateField:"",enabled:entry.enabled!==false}));
    if (typeof state.calendarMonth !== "string" || !/^\d{4}-\d{2}$/.test(state.calendarMonth)) {
      const now = new Date();
      state.calendarMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }
    if (typeof state.calendarAnchor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(state.calendarAnchor)) {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      state.calendarAnchor = state.calendarMonth === currentMonth
        ? `${currentMonth}-${String(now.getDate()).padStart(2, "0")}`
        : `${state.calendarMonth}-01`;
    }

    const validIds = ["file.name", ...schema.map((field) => field.id)];
    state.hiddenColumns = Array.from(new Set(state.hiddenColumns.filter((id) => validIds.includes(id) && id !== "file.name")));
    const seen = new Set();
    state.columnOrder = state.columnOrder.filter((id) => validIds.includes(id) && !seen.has(id) && seen.add(id));
    for (const id of validIds) if (!state.columnOrder.includes(id)) state.columnOrder.push(id);
    if (!state.boardGroupBy || !schema.some((field) => field.id === state.boardGroupBy)) {
      state.boardGroupBy = schema[0]?.id || "";
    }
    state.boardGroupOrder = state.boardGroupOrder.filter((value, index, array) => typeof value === "string" && value && array.indexOf(value) === index);
    state.boardHiddenGroups = state.boardHiddenGroups.filter((value, index, array) => typeof value === "string" && value && array.indexOf(value) === index);
    const boardCardSeen = new Set();
    // Empty Board card fields is intentional: title-only cards.
    state.boardCardFields = state.boardCardFields.filter((id) => schema.some((field) => field.id === id) && !boardCardSeen.has(id) && boardCardSeen.add(id));
    if (state.tableGroupBy && !schema.some((field) => field.id === state.tableGroupBy)) state.tableGroupBy = "";
    const checkboxFieldsForProgress = schema.filter((field) => field?.type === "checkbox");
    if (!state.tableProgressField || !checkboxFieldsForProgress.some((field) => field.id === state.tableProgressField)) state.tableProgressField = checkboxFieldsForProgress[0]?.id || "";
    if (!state.calendarDateField || !schema.some((field) => field.id === state.calendarDateField && field.type === "date")) {
      state.calendarDateField = schema.find((field) => field.type === "date")?.id || "";
    }
    if (!state.timelineDateField || !schema.some((field) => field.id === state.timelineDateField && field.type === "date")) {
      state.timelineDateField = schema.find((field) => field.type === "date")?.id || "";
    }
    const calendarCardSeen = new Set();
    // 0.10.3 — an empty Calendar card field list is intentional: it means
    // “title only”. Do not repopulate properties after the user unchecks all.
    state.calendarCardFields = state.calendarCardFields.filter((id) => schema.some((field) => field.id === id) && !calendarCardSeen.has(id) && calendarCardSeen.add(id));
    state.tableCollapsedGroups = state.tableCollapsedGroups.filter((value, index, array) => typeof value === "string" && array.indexOf(value) === index);
    state.tableCollapsedParents = state.tableCollapsedParents.filter((value, index, array) => typeof value === "string" && value && array.indexOf(value) === index);
    state.tableGroupOrder = state.tableGroupOrder.filter((value, index, array) => typeof value === "string" && value && array.indexOf(value) === index);
    state.tableHiddenGroups = state.tableHiddenGroups.filter((value, index, array) => typeof value === "string" && value && array.indexOf(value) === index);

    // Freeze tracks column identity, not merely the first N positions.
    if (!Array.isArray(state.frozenColumnIds)) {
      const legacyCount = Math.max(0, Math.min(state.columnOrder.length, Number(state.freezeColumns) || 0));
      state.frozenColumnIds = state.columnOrder.slice(0, legacyCount);
    }
    const frozenSeen = new Set();
    state.frozenColumnIds = state.frozenColumnIds.filter((id) => validIds.includes(id) && !frozenSeen.has(id) && frozenSeen.add(id));
    const frozenSet = new Set(state.frozenColumnIds);
    state.columnOrder = [
      ...state.columnOrder.filter((id) => frozenSet.has(id)),
      ...state.columnOrder.filter((id) => !frozenSet.has(id)),
    ];
    state.freezeColumns = state.frozenColumnIds.length;

    if (!Number.isFinite(state.columnWidths["file.name"])) state.columnWidths["file.name"] = 220;
    for (const field of schema) {
      const defaultWidth = field.type === "checkbox" ? (field.hierarchicalProgress === true ? 148 : 56) : field.type === "date" ? 128 : 160;
      if (!Number.isFinite(state.columnWidths[field.id])) state.columnWidths[field.id] = Number(field.width) || defaultWidth;
      if (field.type === "checkbox" && field.hierarchicalProgress !== true && state.columnWidths[field.id] > 90 && !Number(field.width)) state.columnWidths[field.id] = 56;
      if (field.type === "checkbox" && field.hierarchicalProgress === true && state.columnWidths[field.id] < 118 && !Number(field.width)) state.columnWidths[field.id] = 148;
    }
    // Keep the old key as a live alias to the active state for backward-compatible code paths.
    definition.view = state;
    return state;
  }

  getAllViewStates(definition) {
    if (Array.isArray(definition?.views) && definition.views.length) {
      return definition.views.map((entry) => entry?.state).filter((state) => state && typeof state === "object");
    }
    return definition?.view && typeof definition.view === "object" ? [definition.view] : [];
  }

  getStableItemId(file) {
    if (!(file instanceof TFile)) return "";
    const local = this._itemIdByPath?.get(file.path);
    if (local) return local;
    if (this.isCanvasItem(file)) {
      const meta = this.getCanvasMeta(file);
      return typeof meta?.id === "string" ? meta.id : "";
    }
    const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.["lmd-id"];
    return typeof raw === "string" ? raw.trim() : "";
  }

  getItemIdByPath(path) {
    return this._itemIdByPath?.get(normalizePath(path || "")) || "";
  }

  getItemPathById(id) {
    return this._itemPathById?.get(String(id || "")) || "";
  }

  makeStableItemId() {
    return `lmd-item-${generateSourceId()}`;
  }

  async ensureStableItemIds(files) {
    const byPath = new Map();
    const byId = new Map();
    const seen = new Set();
    const writes = [];
    let canvasChanged = false;
    const canvasStore = this.ensureCanvasStore();
    for (const file of files || []) {
      if (!(file instanceof TFile)) continue;
      let id = "";
      if (this.isCanvasItem(file)) {
        let meta = Object.values(canvasStore).find((entry) => entry && normalizePath(entry.path || "") === normalizePath(file.path));
        if (!meta) {
          id = this.makeStableItemId().replace("lmd-item-", "lmd-canvas-");
          meta = { id, path: file.path, properties: {} };
          canvasStore[id] = meta;
          canvasChanged = true;
        } else {
          id = String(meta.id || "").trim();
          if (!id || seen.has(id)) {
            const oldKey = Object.keys(canvasStore).find((key) => canvasStore[key] === meta);
            id = this.makeStableItemId().replace("lmd-item-", "lmd-canvas-");
            const next = { ...meta, id, path: file.path, properties: meta.properties && typeof meta.properties === "object" ? meta.properties : {} };
            if (oldKey) delete canvasStore[oldKey];
            canvasStore[id] = next;
            meta = next;
            canvasChanged = true;
          }
          if (meta.path !== file.path) { meta.path = file.path; canvasChanged = true; }
          if (!meta.properties || typeof meta.properties !== "object" || Array.isArray(meta.properties)) { meta.properties = {}; canvasChanged = true; }
        }
      } else {
        id = this.app.metadataCache.getFileCache(file)?.frontmatter?.["lmd-id"];
        id = typeof id === "string" ? id.trim() : "";
        if (!id || seen.has(id)) {
          id = this.makeStableItemId();
          writes.push({ file, id });
        }
      }
      seen.add(id);
      byPath.set(file.path, id);
      byId.set(id, file.path);
    }
    this._itemIdByPath = byPath;
    this._itemPathById = byId;
    for (const { file, id } of writes) {
      try {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => { frontmatter["lmd-id"] = id; });
      } catch (error) {
        console.error("Local Markdown Database: failed to assign stable item id", file.path, error);
      }
    }
    return canvasChanged;
  }

  migrateManualOrderToStableIds(manualOrder, files) {
    const order = Array.isArray(manualOrder) ? manualOrder.filter((value) => typeof value === "string" && value) : [];
    const filesByPath = new Map((files || []).map((file) => [file.path, file]));
    const ids = new Set();
    const basenameMap = new Map();
    for (const file of files || []) {
      const id = this.getStableItemId(file);
      if (id) ids.add(id);
      const key = file.name;
      if (!basenameMap.has(key)) basenameMap.set(key, []);
      basenameMap.get(key).push(file);
    }
    const migrated = [];
    const used = new Set();
    for (const entry of order) {
      let id = "";
      if (ids.has(entry)) id = entry;
      else {
        const direct = filesByPath.get(normalizePath(entry));
        if (direct) id = this.getStableItemId(direct);
        else {
          const name = String(entry).split("/").pop() || "";
          const matches = basenameMap.get(name) || [];
          if (matches.length === 1) id = this.getStableItemId(matches[0]);
        }
      }
      if (id && !used.has(id)) { used.add(id); migrated.push(id); }
    }
    for (const file of files || []) {
      const id = this.getStableItemId(file);
      if (id && !used.has(id)) { used.add(id); migrated.push(id); }
    }
    return migrated;
  }

  orderFiles(files, manualOrder) {
    const byId = new Map();
    for (const file of files || []) {
      const id = this.getStableItemId(file);
      if (id) byId.set(id, file);
    }
    const ordered = [];
    for (const id of manualOrder || []) {
      const file = byId.get(id);
      if (file) { ordered.push(file); byId.delete(id); }
    }
    const rest = Array.from(byId.values()).sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" }));
    return ordered.concat(rest);
  }

  getColumnValue(file, column) {
    if (column.id === "file.name") return file.basename;
    const overlayKey = `${file.path}\u0000${column.id}`;
    if (this._localValueOverlay?.has(overlayKey)) return this._localValueOverlay.get(overlayKey);
    if (this.isCanvasItem(file)) {
      const meta = this.getCanvasMeta(file);
      return meta?.properties?.[column.id];
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = (cache && cache.frontmatter) || {};
    return frontmatter[column.id];
  }

  rememberLocalColumnValue(file, field, value) {
    if (!file?.path || !field?.id) return;
    if (!this._localValueOverlay) this._localValueOverlay = new Map();
    const key = `${file.path}\u0000${field.id}`;
    this._localValueOverlay.set(key, value);
    // The overlay is only a bridge over Obsidian's metadata-cache latency. Keep it
    // long enough for an immediate filtered re-render, then retire it once cache
    // has caught up. A later external edit can therefore take over normally.
    window.setTimeout(() => {
      try {
        const cached = this.getColumnValue(file, field);
        const same = JSON.stringify(cached) === JSON.stringify(value);
        if (same) this._localValueOverlay?.delete(key);
      } catch (_) {}
    }, 1800);
  }

  buildFilterSuggestions(columns, files) {
    const out = {};
    for (const column of columns || []) {
      if (!column?.id || !["single-select", "multi-select", "relation"].includes(column.type)) continue;
      const values = new Set(column.type === "single-select" || column.type === "multi-select" ? (Array.isArray(column.options) ? column.options.map(String) : []) : []);
      for (const file of files || []) {
        const raw = this.getColumnValue(file, column);
        const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === "" ? [] : [raw]);
        for (const item of list) {
          const text = column.type === "relation" ? pathBasenameNoExt(stripWikiLink(item)) : String(item).trim();
          if (text) values.add(text);
        }
      }
      out[column.id] = Array.from(values).sort((a,b)=>String(a).localeCompare(String(b), "zh-Hant", {numeric:true}));
    }
    return out;
  }

  matchesFilter(file, filter, columnById) {
    const column = columnById.get(filter.field); if (!column) return true;
    const raw = this.getColumnValue(file, column);
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (filter.operator === "empty") return empty;
    if (filter.operator === "not-empty") return !empty;
    if (column.type === "checkbox") {
      const checked = raw === true || String(raw).toLocaleLowerCase() === "true";
      if (filter.operator === "checked") return checked;
      if (filter.operator === "unchecked") return !checked;
    }
    const wanted = String(filter.value ?? "").trim();
    if (column.type === "number") {
      const a=Number(raw), b=Number(wanted); if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return filter.operator === "eq" ? a===b : filter.operator === "neq" ? a!==b : filter.operator === "gt" ? a>b : filter.operator === "gte" ? a>=b : filter.operator === "lt" ? a<b : filter.operator === "lte" ? a<=b : true;
    }
    if (column.type === "date") { const a=String(raw||""), b=wanted; return filter.operator === "eq" ? a===b : filter.operator === "before" ? a<b : filter.operator === "after" ? a>b : true; }
    if (Array.isArray(raw)) {
      const vals=raw.map(v=>String(v).toLocaleLowerCase()); const w=wanted.toLocaleLowerCase();
      if (filter.operator === "contains") return vals.some(v=>v.includes(w));
      if (filter.operator === "not-contains") return !vals.some(v=>v.includes(w));
      if (filter.operator === "eq") return vals.join(", ") === w;
    }
    const a=String(raw ?? "").toLocaleLowerCase(), b=wanted.toLocaleLowerCase();
    return filter.operator === "contains" ? a.includes(b) : filter.operator === "not-contains" ? !a.includes(b) : filter.operator === "eq" ? a===b : filter.operator === "neq" ? a!==b : filter.operator === "starts" ? a.startsWith(b) : filter.operator === "ends" ? a.endsWith(b) : true;
  }

  applySortAndFilters(files, columns, view) {
    const columnById = new Map(columns.map(c => [c.id,c]));
    let out = files.filter(file => (view.filters || []).every(f => this.matchesFilter(file, f, columnById)));
    const sorts=(view.sort||[]).filter(s=>columnById.has(s.field));
    if (sorts.length) {
      const manualIndex = new Map(files.map((f,i)=>[f.path,i]));
      out = out.slice().sort((fa,fb)=>{
        for (const rule of sorts) {
          const col=columnById.get(rule.field); let a=this.getColumnValue(fa,col), b=this.getColumnValue(fb,col);
          const ae=a===undefined||a===null||a==="", be=b===undefined||b===null||b===""; if (ae!==be) return ae?1:-1;
          let cmp=0;
          if (col.type === "number") cmp=(Number(a)||0)-(Number(b)||0);
          else cmp=formatProperty(a).localeCompare(formatProperty(b), undefined, { numeric:true, sensitivity:"base" });
          if (cmp) return rule.direction === "desc" ? -cmp : cmp;
        }
        return (manualIndex.get(fa.path)||0)-(manualIndex.get(fb.path)||0);
      });
    }
    return out;
  }

  async updateSource(databaseFile, definition, path) {
    definition.source = { type: "folder", path, managed: false };
    await this.saveDefinition(databaseFile, definition);
    await this.loadAndRender(databaseFile);
    new Notice(`資料來源已改為：${path || "/"}`);
  }


  getParentItemId(file) {
    if (!(file instanceof TFile)) return "";
    if (this.isCanvasItem(file)) {
      const meta = this.getCanvasMeta(file);
      return typeof meta?.parentId === "string" ? meta.parentId.trim() : "";
    }
    const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.["lmd-parent"];
    return typeof raw === "string" ? raw.trim() : "";
  }

  async setParentItem(file, parentFile = null) {
    if (!(file instanceof TFile)) return false;
    const itemId = this.getStableItemId(file);
    const parentId = parentFile instanceof TFile ? this.getStableItemId(parentFile) : "";
    if (!itemId || (parentId && parentId === itemId)) return false;
    const allFiles = this.collectDatabaseSourceFiles?.(this.definition) || [];
    const parentById = new Map(allFiles.map((candidate) => [this.getStableItemId(candidate), this.getParentItemId(candidate)]));
    let cursor = parentId;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      if (cursor === itemId) { new Notice("不能把項目放到自己的子孫底下。"); return false; }
      seen.add(cursor);
      cursor = parentById.get(cursor) || "";
    }
    if (this.isCanvasItem(file)) {
      const id = this.getStableItemId(file);
      const store = this.ensureCanvasStore();
      const meta = store[id] || { id, path: file.path, properties: {} };
      if (parentId) meta.parentId = parentId; else delete meta.parentId;
      meta.path = file.path; store[id] = meta;
      await this.saveDefinition(this.databaseFile, this.definition);
    } else {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (parentId) fm["lmd-parent"] = parentId; else delete fm["lmd-parent"];
      });
      await this.waitForMetadataRefresh(file, 800);
    }
    return true;
  }


  getVersionMeta(file) {
    if (!(file instanceof TFile)) return { familyId:"", prevId:"", status:"" };
    if (this.isCanvasItem(file)) {
      const meta = this.getCanvasMeta(file) || {};
      return { familyId:String(meta.versionFamilyId || "").trim(), prevId:String(meta.versionPrevId || "").trim(), status:String(meta.versionStatus || "").trim() };
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    return { familyId:String(fm["lmd-version-family"] || "").trim(), prevId:String(fm["lmd-version-prev"] || "").trim(), status:String(fm["lmd-version-status"] || "").trim() };
  }

  isDefaultVisibleVersionItem(file) {
    const meta = this.getVersionMeta(file);
    // Ordinary items are not version-managed and remain visible. Once an item belongs to a
    // version family, the normal Database/Embed views expose only the current version. Historical
    // versions remain real source files and are still reachable from Version Lineage.
    if (!meta.familyId) return true;
    return meta.status === "current";
  }

  async setVersionMeta(file, patch = {}) {
    if (!(file instanceof TFile)) return false;
    if (this.isCanvasItem(file)) {
      const id = this.getStableItemId(file); if (!id) return false;
      const store = this.ensureCanvasStore(); const meta = store[id] || { id, path:file.path, properties:{} };
      if (patch.familyId !== undefined) patch.familyId ? meta.versionFamilyId = patch.familyId : delete meta.versionFamilyId;
      if (patch.prevId !== undefined) patch.prevId ? meta.versionPrevId = patch.prevId : delete meta.versionPrevId;
      if (patch.status !== undefined) patch.status ? meta.versionStatus = patch.status : delete meta.versionStatus;
      meta.path=file.path; store[id]=meta; await this.saveDefinition(this.databaseFile, this.definition); return true;
    }
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (patch.familyId !== undefined) patch.familyId ? fm["lmd-version-family"] = patch.familyId : delete fm["lmd-version-family"];
      if (patch.prevId !== undefined) patch.prevId ? fm["lmd-version-prev"] = patch.prevId : delete fm["lmd-version-prev"];
      if (patch.status !== undefined) patch.status ? fm["lmd-version-status"] = patch.status : delete fm["lmd-version-status"];
    });
    await this.waitForMetadataRefresh(file, 800); return true;
  }

  async ensureVersionFamily(file) {
    const current = this.getVersionMeta(file);
    if (current.familyId) return current.familyId;
    const familyId = `lmd-version-${generateSourceId()}`;
    await this.setVersionMeta(file, { familyId, prevId:"", status:"current" });
    return familyId;
  }

  async getVersionLineage(file) {
    if (!(file instanceof TFile)) return [];
    const familyId = await this.ensureVersionFamily(file);
    const files = this.collectDatabaseSourceFiles(this.definition).filter((candidate) => candidate instanceof TFile);
    const members = files.filter((candidate) => this.getVersionMeta(candidate).familyId === familyId);
    const byId = new Map(members.map((candidate) => [this.getStableItemId(candidate), candidate]));
    const prevOf = new Map(members.map((candidate) => [this.getStableItemId(candidate), this.getVersionMeta(candidate).prevId]));
    const nextOf = new Map();
    for (const [id, prev] of prevOf) if (prev && byId.has(prev) && !nextOf.has(prev)) nextOf.set(prev, id);
    let root = members.find((candidate) => { const id=this.getStableItemId(candidate); const prev=prevOf.get(id); return !prev || !byId.has(prev); }) || members[0];
    const out=[], seen=new Set();
    while (root) {
      const id=this.getStableItemId(root); if (!id || seen.has(id)) break; seen.add(id);
      const meta=this.getVersionMeta(root); out.push({ file:root, id, status:meta.status || (nextOf.has(id)?"superseded":"current") });
      const nextId=nextOf.get(id); root=nextId?byId.get(nextId):null;
    }
    for (const candidate of members) { const id=this.getStableItemId(candidate); if (!seen.has(id)) { const meta=this.getVersionMeta(candidate); out.push({file:candidate,id,status:meta.status||"superseded"}); } }
    return out;
  }

  async setCurrentVersion(file) {
    const lineage = await this.getVersionLineage(file);
    for (const entry of lineage) await this.setVersionMeta(entry.file, { status: entry.file.path === file.path ? "current" : "superseded" });
    if (this.databaseFile) await this.loadAndRender(this.databaseFile);
  }

  getNextVersionPath(file) {
    const folder = file.parent?.path || "";
    const base = file.basename;
    const m = /^(.*?)(?:\s+v(\d+))$/i.exec(base);
    const stem = m ? m[1].trim() : base;
    let n = m ? Number(m[2]) + 1 : 2;
    let path = normalizePath(`${folder ? folder + "/" : ""}${stem} v${n}.${file.extension}`);
    while (this.app.vault.getAbstractFileByPath(path)) { n += 1; path = normalizePath(`${folder ? folder + "/" : ""}${stem} v${n}.${file.extension}`); }
    return path;
  }

  async createNextVersion(file) {
    if (!(file instanceof TFile)) return null;
    if (this.isCanvasItem(file)) { new Notice("版本鏈 V1 先支援 Markdown；Canvas 版本會在後續接上。"); return null; }
    const lineage = await this.getVersionLineage(file);
    const current = lineage.find((entry) => entry.status === "current") || lineage[lineage.length - 1];
    if (current && current.file.path !== file.path) { new Notice(`請從目前版本「${current.file.basename}」建立下一版。`); return null; }
    const familyId = await this.ensureVersionFamily(file);
    const prevId = this.getStableItemId(file);
    const targetPath = this.getNextVersionPath(file);
    const content = await this.app.vault.read(file);
    const created = await this.app.vault.create(targetPath, content);
    const newId = `lmd-item-${generateSourceId()}`;
    await this.app.fileManager.processFrontMatter(created, (fm) => {
      fm["lmd-id"] = newId;
      fm["lmd-version-family"] = familyId;
      fm["lmd-version-prev"] = prevId;
      fm["lmd-version-status"] = "current";
      fm["lmd-database"] = `[[${this.databaseFile.path}]]`;
    });
    await this.setVersionMeta(file, { familyId, status:"superseded" });
    try {
      for (const entry of this.definition.views || []) { const order=entry?.state?.manualOrder; if (Array.isArray(order) && !order.includes(newId)) { const oldIndex=order.indexOf(prevId); oldIndex>=0 ? order.splice(oldIndex+1,0,newId) : order.push(newId); } }
      await this.saveDefinition(this.databaseFile, this.definition);
    } catch (error) { console.warn("Local Markdown Database: version manual order update failed", error); }
    new Notice(`已建立下一版本：${created.basename}`);
    await this.loadAndRender(this.databaseFile);
    void this.app.workspace.openLinkText(created.path, file.path, false);
    return created;
  }

  buildParentHierarchy(files, view) {
    const ordered = Array.isArray(files) ? files.slice() : [];
    const fileById = new Map();
    for (const file of ordered) { const id = this.getStableItemId(file); if (id) fileById.set(id, file); }
    const children = new Map();
    const roots = [];
    for (const file of ordered) {
      const id = this.getStableItemId(file);
      const parentId = this.getParentItemId(file);
      if (parentId && parentId !== id && fileById.has(parentId)) {
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(file);
      } else roots.push(file);
    }
    const collapsed = new Set(Array.isArray(view?.tableCollapsedParents) ? view.tableCollapsedParents : []);
    const out = [], depthByPath = new Map(), hasChildren = new Set();
    for (const [id, list] of children) if (list.length) hasChildren.add(id);
    const visiting = new Set();
    const rendered = new Set();
    const visit = (file, depth) => {
      const id = this.getStableItemId(file);
      if (!id || visiting.has(id) || rendered.has(id)) return;
      visiting.add(id);
      rendered.add(id);
      out.push(file); depthByPath.set(file.path, depth);
      // A collapsed parent owns its descendants even while they are hidden. Do not
      // append those hidden children again as fallback roots; that was the cause of
      // children/grandchildren "escaping" and appearing elsewhere when a parent closed.
      if (!collapsed.has(id)) for (const child of children.get(id) || []) visit(child, depth + 1);
      visiting.delete(id);
    };
    for (const root of roots) visit(root, 0);
    return { files: out, depthByPath, hasChildren };
  }


  getHierarchyProgressStats(files, checkboxField, scope = "descendants") {
    const list = Array.isArray(files) ? files.filter((file) => file instanceof TFile) : [];
    const field = checkboxField?.id ? checkboxField : null;
    const result = new Map();
    if (!field || !list.length) return result;
    const byId = new Map();
    const children = new Map();
    for (const file of list) {
      const id = this.getStableItemId(file);
      if (id) byId.set(id, file);
    }
    for (const file of list) {
      const id = this.getStableItemId(file);
      const parentId = this.getParentItemId(file);
      if (!id || !parentId || !byId.has(parentId) || parentId === id) continue;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(file);
    }
    const isDone = (file) => {
      const raw = this.getColumnValue(file, field);
      return raw === true || String(raw).toLowerCase() === "true";
    };
    const collectDescendants = (id, trail = new Set()) => {
      if (!id || trail.has(id)) return [];
      const nextTrail = new Set(trail);
      nextTrail.add(id);
      const direct = children.get(id) || [];
      if (scope === "direct") return direct.slice();
      const out = [];
      for (const child of direct) {
        out.push(child);
        const childId = this.getStableItemId(child);
        if (childId) out.push(...collectDescendants(childId, nextTrail));
      }
      return out;
    };
    for (const [id] of children) {
      const targets = collectDescendants(id);
      if (!targets.length) continue;
      const done = targets.filter(isDone).length;
      const total = targets.length;
      result.set(id, { done, total, percent: total ? Math.round((done / total) * 100) : 0 });
    }
    return result;
  }

  async persistCheckboxHierarchyFieldDefinition(field) {
    if (!field?.id || !this.databaseFile) return;
    try {
      if (this.isEmbedded !== true) {
        await this.saveDefinition(this.databaseFile, this.definition);
      } else {
        const raw = await this.app.vault.read(this.databaseFile);
        const sourceDef = JSON.parse(raw);
        const target = Array.isArray(sourceDef.schema) ? sourceDef.schema.find((item) => item?.id === field.id) : null;
        if (!target) return;
        target.hierarchicalProgress = field.hierarchicalProgress === true;
        target.hierarchyProgressScope = field.hierarchyProgressScope === "direct" ? "direct" : "descendants";
        await this.app.vault.modify(this.databaseFile, JSON.stringify(sourceDef, null, 2));
      }
      void this.plugin?.broadcastDatabaseDefinitionChange?.(this.databaseFile);
    } catch (error) {
      console.error("Local Markdown Database: persist hierarchical checkbox schema failed", error);
    }
  }

  buildParentChildIndex(files) {
    const list = Array.isArray(files) ? files.filter((file) => file instanceof TFile) : [];
    const byId = new Map();
    const children = new Map();
    const parentById = new Map();
    for (const file of list) {
      const id = this.getStableItemId(file);
      if (id) byId.set(id, file);
    }
    for (const file of list) {
      const id = this.getStableItemId(file);
      const parentId = this.getParentItemId(file);
      if (!id || !parentId || !byId.has(parentId) || parentId === id) continue;
      parentById.set(id, parentId);
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(file);
    }
    return { list, byId, children, parentById };
  }

  async writeHierarchicalCheckbox(file, field, targetChecked) {
    const files = this.collectDatabaseSourceFiles(this.definition);
    const index = this.buildParentChildIndex(files);
    const rootId = this.getStableItemId(file);
    if (!rootId) return false;
    const descendants = [];
    const visit = (id, trail = new Set()) => {
      if (!id || trail.has(id)) return;
      const nextTrail = new Set(trail);
      nextTrail.add(id);
      for (const child of index.children.get(id) || []) {
        descendants.push(child);
        const childId = this.getStableItemId(child);
        if (childId) visit(childId, nextTrail);
      }
    };
    visit(rootId);
    for (const item of [file, ...descendants]) {
      const ok = await this.writeProperty(item, field, targetChecked === true);
      if (!ok) return false;
    }
    let parentId = index.parentById.get(rootId);
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parentFile = index.byId.get(parentId);
      if (!parentFile) break;
      const directChildren = index.children.get(parentId) || [];
      const allDone = directChildren.length > 0 && directChildren.every((child) => {
        const raw = this.getColumnValue(child, field);
        return raw === true || String(raw).toLowerCase() === "true";
      });
      await this.writeProperty(parentFile, field, allDone);
      parentId = index.parentById.get(parentId);
    }
    return true;
  }

  refreshHierarchyProgressBadges() {
    if (this.databaseFile) void this.loadAndRender(this.databaseFile);
  }

  async createChildRow(parentFile, sourceFolder, view, schema) {
    const parentId = this.getStableItemId(parentFile);
    if (!parentId) return;
    const defaults = this.getCreateDefaultsFromView(view, schema);
    defaults["lmd-parent"] = parentId;
    await this.createRow(sourceFolder, null, undefined, defaults);
  }

  collectMarkdownFiles(folder) {
    // Database source items can be Markdown or Canvas. Canvas files never enter
    // the Markdown/frontmatter pipeline; they use external metadata stored in
    // the .database definition instead.
    const out = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile)) continue;
      const ext = String(child.extension || "").toLowerCase();
      if (ext === "md" || ext === "canvas") out.push(child);
    }
    return out;
  }

  isCanvasItem(file) {
    return file instanceof TFile && String(file.extension || "").toLowerCase() === "canvas";
  }

  ensureCanvasStore() {
    if (!this.definition) return {};
    if (!this.definition.canvasItems || typeof this.definition.canvasItems !== "object" || Array.isArray(this.definition.canvasItems)) this.definition.canvasItems = {};
    return this.definition.canvasItems;
  }

  getCanvasMeta(file) {
    if (!this.isCanvasItem(file)) return null;
    const store = this.ensureCanvasStore();
    const byPath = Object.values(store).find((entry) => entry && normalizePath(entry.path || "") === normalizePath(file.path));
    return byPath || null;
  }

  getCanvasMetaById(id) {
    if (!id) return null;
    return this.ensureCanvasStore()[id] || null;
  }

  inferSchema(files) {
    const fields = new Map();
    for (const file of files.slice(0, 200)) {
      let properties = null;
      if (this.isCanvasItem(file)) properties = this.getCanvasMeta(file)?.properties || {};
      else {
        const cache = this.app.metadataCache.getFileCache(file);
        properties = cache && cache.frontmatter;
      }
      if (!properties) continue;
      for (const key of Object.keys(properties)) {
        if (key === "position" || isSystemMetadataField(key)) continue;
        if (!fields.has(key)) fields.set(key, { id: key, name: key, type: inferFieldType(properties[key]), width: 160 });
      }
    }
    return Array.from(fields.values());
  }

  getEffectiveSchema(definition, files) {
    if (Array.isArray(definition.schema) && definition.schema.length) return definition.schema.filter((field) => field?.id && !isSystemMetadataField(field.id));
    return this.inferSchema(files);
  }

  async ensureSchemaPersisted(databaseFile, definition, files) {
    if (definition.schema && definition.schema.length) {
      const cleaned = definition.schema.filter((field) => field?.id && !isSystemMetadataField(field.id));
      if (cleaned.length !== definition.schema.length) { definition.schema = cleaned; await this.saveDefinition(databaseFile, definition); }
      return cleaned;
    }
    definition.schema = this.inferSchema(files);
    await this.saveDefinition(databaseFile, definition);
    return definition.schema;
  }

  async addField(databaseFile, definition, files, field) {
    if (isSystemMetadataField(field?.id)) { new Notice("這是插件保留的系統欄位。", 2500); return; }
    const schema = await this.ensureSchemaPersisted(databaseFile, definition, files);
    if (schema.some((existing) => existing?.id === field?.id)) {
      new Notice("這個欄位已經存在。");
      return;
    }
    schema.push(field);
    // Canonicalize schema IDs before rendering. A duplicated field definition can
    // otherwise manifest as two editors visually occupying a single logical cell.
    definition.schema = schema.filter((entry, index, array) => entry?.id && array.findIndex((candidate) => candidate?.id === entry.id) === index);
    await this.saveDefinition(databaseFile, definition);
    await this.loadAndRender(databaseFile);
  }

  shouldPreserveEmptyProperties() {
    return this.plugin?.settings?.emptyValuePolicy === "preserve";
  }

  emptyValueForField(field) {
    const type = String(field?.type || "text");
    if (type === "checkbox") return false;
    if (type === "multi-select" || type === "relation") return [];
    if (type === "number") return null;
    // Text/date/single-select remain strings so CMS templates do not receive an
    // unexpected array/object merely because a value was cleared.
    return "";
  }

  storedValueForField(field, value) {
    if (value !== undefined) return value;
    return this.shouldPreserveEmptyProperties() ? this.emptyValueForField(field) : undefined;
  }

  isUserSchemaField(field) {
    if (!field?.id || field.id === "file.name") return false;
    return !["lmd-id", "lmd-database", "lmd-parent", "lmd-version-family", "lmd-version-prev", "lmd-version-status"].includes(field.id);
  }

  getCreateDefaultsFromView(view, schema) {
    const fields = new Map((schema || []).map((field) => [field.id, field]));
    const defaults = {};
    for (const rule of view?.filters || []) {
      const field = fields.get(rule.field);
      if (!field || field.id === "file.name") continue;
      const raw = String(rule.value ?? "").trim();
      if (field.type === "checkbox") {
        if (rule.operator === "checked") defaults[field.id] = true;
        else if (rule.operator === "unchecked") defaults[field.id] = false;
        continue;
      }
      if (!raw) continue;
      if (field.type === "multi-select" && (rule.operator === "contains" || rule.operator === "eq")) defaults[field.id] = [raw];
      else if (field.type === "single-select" && rule.operator === "eq") defaults[field.id] = raw;
      else if (field.type === "relation" && (rule.operator === "contains" || rule.operator === "eq")) defaults[field.id] = [formatRelationWikiLink(raw)];
      else if (["text", "number", "date"].includes(field.type) && rule.operator === "eq") {
        defaults[field.id] = field.type === "number" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
      }
    }
    return defaults;
  }

  async createRowForView(sourceFolder, view, schema, explicitField = null, explicitValue = undefined) {
    const defaults = this.getCreateDefaultsFromView(view, schema);
    if (explicitField && explicitValue !== undefined && explicitValue !== null && explicitValue !== "") defaults[explicitField.id] = explicitValue;
    return this.createRow(sourceFolder, null, undefined, defaults);
  }

  async createRow(sourceFolder, initialField = null, initialValue = undefined, initialValues = null) {
    if (sourceFolder?.__lmdAggregate === true) {
      const targets = (sourceFolder.targets || []).filter((target) => target.folder instanceof TFolder);
      if (!targets.length) { new Notice("聚合 Database 目前沒有可寫入的原始來源。"); return; }
      if (targets.length === 1) { await this.createRow(targets[0].folder, initialField, initialValue, initialValues); return; }
      new AggregateCreateTargetModal(this.app, targets, async (target) => {
        await this.createRow(target.folder, initialField, initialValue, initialValues);
      }).open();
      return;
    }
    let index = 1;
    let baseName = "Untitled";
    let filePath = normalizePath(sourceFolder.path ? `${sourceFolder.path}/${baseName}.md` : `${baseName}.md`);
    while (this.app.vault.getAbstractFileByPath(filePath)) {
      index += 1;
      baseName = `Untitled ${index}`;
      filePath = normalizePath(sourceFolder.path ? `${sourceFolder.path}/${baseName}.md` : `${baseName}.md`);
    }
    const file = await this.app.vault.create(filePath, "");
    const itemId = this.makeStableItemId();
    const seedValues = { ...(initialValues && typeof initialValues === "object" ? initialValues : {}) };
    if (initialField && initialValue !== undefined && initialValue !== null && initialValue !== "") seedValues[initialField.id] = initialValue;
    const initializeSchema = this.plugin?.settings?.initializeSchemaFieldsOnCreate === true;
    const schemaFields = Array.isArray(this.definition?.schema) ? this.definition.schema : [];
    if (initializeSchema) {
      for (const field of schemaFields) {
        if (!this.isUserSchemaField(field) || Object.prototype.hasOwnProperty.call(seedValues, field.id)) continue;
        seedValues[field.id] = this.emptyValueForField(field);
      }
    }
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter["lmd-id"] = itemId;
        for (const [key, seed] of Object.entries(seedValues)) {
          // In initialization mode null/empty-string/[] are deliberate schema
          // placeholders and must be written instead of silently skipped.
          if (!initializeSchema && (seed === undefined || seed === null || seed === "")) continue;
          if (seed === undefined) continue;
          frontmatter[key] = seed;
        }
      });
    } catch (error) {
      console.error("Local Markdown Database: failed to initialize row properties", error);
    }
    if (!this._itemIdByPath) this._itemIdByPath = new Map();
    if (!this._itemPathById) this._itemPathById = new Map();
    this._itemIdByPath.set(file.path, itemId);
    this._itemPathById.set(itemId, file.path);
    // Filters read from metadataCache. Wait until the freshly seeded frontmatter
    // is visible there so a filter-aware new row appears immediately.
    await this.waitForMetadataRefresh(file, 1000);
    if (this.definition && this.definition.source?.type !== "database-set") {
      const schema = Array.isArray(this.definition.schema) ? this.definition.schema : [];
      this.ensureViewState(this.definition, schema);
      for (const view of this.getAllViewStates(this.definition)) {
        if (!Array.isArray(view.manualOrder)) view.manualOrder = [];
        if (!view.manualOrder.includes(itemId)) view.manualOrder.push(itemId);
      }
      await this.saveDefinition(this.databaseFile, this.definition);
    }
    new Notice(`已新增：${file.basename}`);
    await this.loadAndRender(this.databaseFile);
  }

  async renameRow(file, requestedName) {
    const cleanName = sanitizeFileName(requestedName);
    if (!cleanName || cleanName === file.basename) return file.basename;
    const parentPath = file.parent ? file.parent.path : "";
    const ext = String(file.extension || "md");
    const newPath = normalizePath(parentPath ? `${parentPath}/${cleanName}.${ext}` : `${cleanName}.${ext}`);
    const existing = this.app.vault.getAbstractFileByPath(newPath);
    if (existing && existing !== file) {
      new Notice("改名失敗：同名檔案已存在。");
      return file.basename;
    }
    try {
      const oldPath = file.path;
      await this.app.fileManager.renameFile(file, newPath);
      if (this.definition) {
        const stableItemId = this.getItemIdByPath(oldPath);
        if (stableItemId) {
          this._itemIdByPath?.delete(oldPath);
          this._itemIdByPath?.set(newPath, stableItemId);
          this._itemPathById?.set(stableItemId, newPath);
          if (this.isCanvasItem(file)) {
            // Canvas identity/properties live outside the .canvas JSON. A rename is
            // only a path change: keep the same stable id and metadata record.
            const meta = this.ensureCanvasStore()[stableItemId];
            if (meta) meta.path = newPath;
          }
        }
        for (const view of this.getAllViewStates(this.definition)) {
          if (view.rowColors?.[oldPath]) {
            view.rowColors[newPath] = view.rowColors[oldPath];
            delete view.rowColors[oldPath];
          }
          if (view.cellColors?.[oldPath]) {
            view.cellColors[newPath] = view.cellColors[oldPath];
            delete view.cellColors[oldPath];
          }
        }
        await this.saveDefinition(this.databaseFile, this.definition);
      }
      new Notice(`已改名為：${cleanName}`);
      return cleanName;
    } catch (error) {
      console.error("Local Markdown Database: rename failed", error);
      new Notice("改名失敗。請查看開發者主控台。");
      return file.basename;
    }
  }

  async readDatabaseDefinitionAt(path) {
    const file = this.app.vault.getAbstractFileByPath(path || "");
    if (!(file instanceof TFile) || file.extension !== DATABASE_EXTENSION) return { file: null, definition: null };
    try {
      const definition = JSON.parse(await this.app.vault.read(file));
      return { file, definition: isDatabaseDefinition(definition) ? definition : null };
    } catch (_) {
      return { file, definition: null };
    }
  }

  collectDatabaseSourceFiles(definition) {
    const sourcePath = normalizePath(definition?.source?.path || "");
    const source = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : this.app.vault.getRoot();
    if (!(source instanceof TFolder)) return [];
    return source.children.filter((item) => item instanceof TFile && ["md", "canvas"].includes(String(item.extension || "").toLowerCase()));
  }

  uniqueSchemaFieldId(schema, wanted) {
    const base = normalizeFieldId(wanted) || "relation";
    const used = new Set((schema || []).map((field) => field.id));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  async ensureReverseRelationField(field) {
    if (isFlexibleRelation(field) || !field?.relationTarget || !this.databaseFile) return null;
    const target = await this.readDatabaseDefinitionAt(field.relationTarget);
    if (!(target.file instanceof TFile) || !target.definition) return null;
    if (!Array.isArray(target.definition.schema)) target.definition.schema = [];

    let reverse = field.reverseFieldId
      ? target.definition.schema.find((item) => item.id === field.reverseFieldId)
      : null;
    const desiredName = String(field.reverseFieldName || this.definition?.name || this.databaseFile.basename || "反向關聯").trim();

    if (!reverse) {
      const id = this.uniqueSchemaFieldId(target.definition.schema, desiredName);
      reverse = {
        id,
        name: desiredName || id,
        type: "relation",
        width: 220,
        relationTarget: this.databaseFile.path,
        bidirectional: false,
        reciprocalOf: { database: this.databaseFile.path, field: field.id },
      };
      target.definition.schema.push(reverse);
      field.reverseFieldId = id;
    } else {
      reverse.type = "relation";
      reverse.relationTarget = this.databaseFile.path;
      if (desiredName) reverse.name = desiredName;
      reverse.bidirectional = false;
      reverse.reciprocalOf = { database: this.databaseFile.path, field: field.id };
    }
    field.reverseFieldName = reverse.name;
    await this.app.vault.modify(target.file, JSON.stringify(target.definition, null, 2));
    return { ...target, reverseField: reverse };
  }

  relationTargetPaths(rawValue) {
    const values = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
    return Array.from(new Set(values.map((value) => stripWikiLink(value)).filter(Boolean)));
  }

  async updateReverseProperty(targetFile, reverseField, sourceFile, shouldContain) {
    // Never run Obsidian frontmatter APIs against a .canvas file. Cross-database
    // reverse writes for Canvas need the target database's external metadata store
    // and are intentionally deferred; skipping is safer than corrupting Canvas JSON.
    if (this.isCanvasItem(targetFile)) {
      console.warn("Local Markdown Database: skipped reverse relation write to Canvas item", targetFile.path);
      return;
    }
    const sourceTarget = stripMdExtension(sourceFile.path);
    try {
      await this.app.fileManager.processFrontMatter(targetFile, (frontmatter) => {
        const raw = frontmatter[reverseField.id];
        const current = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        const targets = current.map((value) => stripWikiLink(value)).filter(Boolean);
        const next = targets.filter((value) => value !== sourceTarget);
        if (shouldContain) next.push(sourceTarget);
        const unique = Array.from(new Set(next));
        if (unique.length) frontmatter[reverseField.id] = unique.map((value) => formatRelationWikiLink(value));
        else if (this.shouldPreserveEmptyProperties()) frontmatter[reverseField.id] = [];
        else delete frontmatter[reverseField.id];
      });
    } catch (error) {
      console.error("Local Markdown Database: bidirectional relation update failed", error);
    }
  }

  async syncBidirectionalRelation(sourceFile, field, oldRawValue, newRawValue) {
    if (field?.type !== "relation" || isFlexibleRelation(field) || field.bidirectional !== true) return;
    const ensured = await this.ensureReverseRelationField(field);
    if (!ensured?.reverseField) return;
    const oldSet = new Set(this.relationTargetPaths(oldRawValue));
    const newSet = new Set(this.relationTargetPaths(newRawValue));
    const resolve = (target) => this.resolveRelationFile(target, sourceFile.path);

    for (const target of oldSet) {
      if (newSet.has(target)) continue;
      const targetFile = resolve(target);
      if (targetFile) await this.updateReverseProperty(targetFile, ensured.reverseField, sourceFile, false);
    }
    for (const target of newSet) {
      if (oldSet.has(target)) continue;
      const targetFile = resolve(target);
      if (targetFile) await this.updateReverseProperty(targetFile, ensured.reverseField, sourceFile, true);
    }
  }

  async rebuildBidirectionalRelation(field) {
    if (field?.type !== "relation" || isFlexibleRelation(field) || field.bidirectional !== true) return;
    const ensured = await this.ensureReverseRelationField(field);
    if (!ensured?.reverseField) return;
    const sourceFiles = this.collectDatabaseSourceFiles(this.definition);
    for (const sourceFile of sourceFiles) {
      const cache = this.app.metadataCache.getFileCache(sourceFile);
      const raw = cache?.frontmatter?.[field.id];
      for (const target of this.relationTargetPaths(raw)) {
        const targetFile = this.resolveRelationFile(target, sourceFile.path);
        if (targetFile) await this.updateReverseProperty(targetFile, ensured.reverseField, sourceFile, true);
      }
    }
  }

  async removeBidirectionalLinks(field) {
    if (isFlexibleRelation(field) || !field?.relationTarget || !field.reverseFieldId) return;
    const target = await this.readDatabaseDefinitionAt(field.relationTarget);
    if (!target.definition) return;
    const reverseField = target.definition.schema?.find((item) => item.id === field.reverseFieldId);
    if (!reverseField) return;
    const sourceFiles = this.collectDatabaseSourceFiles(this.definition);
    for (const sourceFile of sourceFiles) {
      const cache = this.app.metadataCache.getFileCache(sourceFile);
      const raw = cache?.frontmatter?.[field.id];
      for (const targetPath of this.relationTargetPaths(raw)) {
        const targetFile = this.resolveRelationFile(targetPath, sourceFile.path);
        if (targetFile) await this.updateReverseProperty(targetFile, reverseField, sourceFile, false);
      }
    }
  }

  async writeProperty(file, field, rawValue) {
    const oldRawValue = this.getColumnValue(file, field);
    let value;
    if (field.type === "checkbox") {
      value = rawValue === true || rawValue === "true" || rawValue === 1 || rawValue === "1";
    } else if (field.type === "number") {
      if (rawValue === "") value = undefined;
      else {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) {
          new Notice("這個欄位只能輸入數字。");
          return false;
        }
        value = parsed;
      }
    } else if (field.type === "date") {
      const text = String(rawValue || "").trim();
      if (!text) value = undefined;
      else {
        const parsed = parseDateRangeValue(text);
        if (!parsed.startDate) { new Notice("請輸入有效的日期。"); return false; }
        if (parsed.hasEnd && parsed.endDate < parsed.startDate) { new Notice("結束日期不能早於開始日期。"); return false; }
        if (parsed.hasEnd && parsed.endDate === parsed.startDate && parsed.startTime && parsed.endTime && parsed.endTime < parsed.startTime) { new Notice("結束時間不能早於開始時間。"); return false; }
        value = formatDateRangeValue(parsed);
      }
    } else if (field.type === "relation") {
      const rawItems = Array.isArray(rawValue) ? rawValue : String(rawValue).split(",");
      const items = rawItems
        .map((item) => String(item).trim())
        .filter(Boolean)
        .map((item) => formatRelationWikiLink(item))
        .filter(Boolean);
      value = items.length ? items : undefined;
    } else if (field.type === "single-select") {
      const text = Array.isArray(rawValue) ? String(rawValue[0] || "").trim() : String(rawValue || "").trim();
      value = text || undefined;
    } else if (field.type === "multi-select") {
      const rawItems = Array.isArray(rawValue) ? rawValue : String(rawValue).split(",");
      const items = rawItems.map((item) => String(item).trim()).filter(Boolean);
      value = items.length ? Array.from(new Set(items)) : undefined;
    } else {
      const text = String(rawValue || "").trim();
      value = text ? text : undefined;
    }

    const storedValue = this.storedValueForField(field, value);
    try {
      if (this.isCanvasItem(file)) {
        const id = this.getStableItemId(file);
        const store = this.ensureCanvasStore();
        const meta = store[id] || { id, path: file.path, properties: {} };
        if (!meta.properties || typeof meta.properties !== "object") meta.properties = {};
        if (storedValue === undefined) delete meta.properties[field.id];
        else meta.properties[field.id] = storedValue;
        meta.path = file.path;
        store[id] = meta;
        await this.saveDefinition(this.databaseFile, this.definition);
      } else {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          if (storedValue === undefined) delete frontmatter[field.id];
          else frontmatter[field.id] = storedValue;
        });
      }
      this.rememberLocalColumnValue(file, field, storedValue);
      // A Markdown item can be visible in several live database renderers at once
      // (main .database leaves and one or more embedded views). Notify the other
      // renderers immediately instead of waiting for Obsidian's metadata cache or
      // for the user to poke the destination view. The receiving renderer gets the
      // same short-lived value overlay before it re-filters/re-renders.
      void this.plugin?.broadcastDatabaseRowChange?.(this, file, field, storedValue);
      if (!this.isCanvasItem(file) && field.type === "relation" && field.bidirectional === true) {
        await this.syncBidirectionalRelation(file, field, oldRawValue, value);
        await this.saveDefinition(this.databaseFile, this.definition);
      }
      return true;
    } catch (error) {
      console.error("Local Markdown Database: property write failed", error);
      new Notice(`寫入 ${field.name || field.id} 失敗。`);
      return false;
    }
  }

  async ensureSelectOptionRegistries(databaseFile, definition, files, schema) {
    let changed = false;
    for (const field of schema || []) {
      if (!field?.id || !["single-select", "multi-select"].includes(field.type)) continue;
      const options = Array.from(new Set((Array.isArray(field.options) ? field.options : []).map(String).map((v)=>v.trim()).filter(Boolean)));
      const seen = new Set(options);
      for (const file of files || []) {
        const raw = this.getColumnValue(file, field);
        const values = field.type === "multi-select" ? (Array.isArray(raw) ? raw : (raw ? [raw] : [])) : (raw === undefined || raw === null || raw === "" ? [] : [raw]);
        for (const item of values) { const value=String(item).trim(); if(value && !seen.has(value)){ seen.add(value); options.push(value); changed=true; } }
      }
      if (!Array.isArray(field.options) || JSON.stringify(field.options) !== JSON.stringify(options)) { field.options=options; changed=true; }
      if (!field.optionColors || typeof field.optionColors !== "object" || Array.isArray(field.optionColors)) { field.optionColors={}; changed=true; }
    }
    if (!changed) return;
    if (this.isEmbedded === true) {
      for (const field of schema || []) if (["single-select","multi-select"].includes(field?.type)) await this.persistSelectFieldDefinition(field);
    } else if (definition?.source?.type !== "database-set") await this.saveDefinition(databaseFile, definition);
  }

  async normalizeRelationAliases(files, schema) {
    const relationFields = (schema || []).filter((field) => field?.type === "relation" && field.id);
    if (!relationFields.length) return;
    for (const file of files || []) {
      // Relation alias normalization is a Markdown/frontmatter migration. Canvas
      // properties are external metadata and must never be sent to processFrontMatter.
      if (this.isCanvasItem(file)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = (cache && cache.frontmatter) || {};
      let needsChange = false;
      const updates = new Map();
      for (const field of relationFields) {
        const raw = frontmatter[field.id];
        if (raw === undefined || raw === null || raw === "") continue;
        const values = Array.isArray(raw) ? raw : [raw];
        const normalized = values.map((value) => formatRelationWikiLink(value)).filter(Boolean);
        const current = values.map((value) => String(value).trim()).filter(Boolean);
        if (normalized.length && JSON.stringify(normalized) !== JSON.stringify(current)) {
          updates.set(field.id, Array.isArray(raw) ? normalized : normalized[0]);
          needsChange = true;
        }
      }
      if (!needsChange) continue;
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          for (const [id, value] of updates) fm[id] = value;
        });
      } catch (error) {
        console.error("Local Markdown Database: relation alias normalization failed", file.path, error);
      }
    }
  }

  async deleteRow(file) {
    try {
      // Capture identity before trashing: after a Canvas file is removed from the
      // vault its path lookup can no longer recover the external metadata record.
      const deletedId = this.getStableItemId(file);
      if (deletedId && this.definition) {
        const allFiles = this.collectDatabaseSourceFiles?.(this.definition) || [];
        for (const child of allFiles) {
          if (child !== file && this.getParentItemId(child) === deletedId) {
            try { await this.setParentItem(child, null); } catch (error) { console.error("Local Markdown Database: failed to detach child before parent deletion", child.path, error); }
          }
        }
      }
      const deletedPath = file.path;
      const wasCanvas = this.isCanvasItem(file);
      await this.app.fileManager.trashFile(file);
      if (this.definition) {
        for (const view of this.getAllViewStates(this.definition)) {
          if (Array.isArray(view.manualOrder) && deletedId) view.manualOrder = view.manualOrder.filter((id) => id !== deletedId);
          if (view.rowColors) delete view.rowColors[deletedPath];
          if (view.cellColors) delete view.cellColors[deletedPath];
        }
        if (wasCanvas && deletedId && this.definition.canvasItems) delete this.definition.canvasItems[deletedId];
        this._itemIdByPath?.delete(deletedPath);
        if (deletedId) this._itemPathById?.delete(deletedId);
        await this.saveDefinition(this.databaseFile, this.definition);
      }
      new Notice(`已刪除：${file.basename}`);
      await this.loadAndRender(this.databaseFile);
    } catch (error) {
      console.error("Local Markdown Database: delete failed", error);
      new Notice("刪除失敗。請查看開發者主控台。");
    }
  }

  async waitForMetadataRefresh(file, timeout = 900) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; window.clearTimeout(timer); if (ref) this.app.metadataCache.offref(ref); resolve(); };
      const ref = this.app.metadataCache.on("changed", (changed) => { if (changed?.path === file.path) finish(); });
      const timer = window.setTimeout(finish, timeout);
    });
  }

  async refreshTableIfFilterAffected(file, field) {
    const entry = this.definition?.views?.find((item) => item?.id === this.definition?.activeViewId);
    if (!entry || entry.type !== "table") return;
    const state = entry.state || {};
    if (!(state.filters || []).some((rule) => rule?.field === field?.id)) return;
    // Do not wait for metadataCache here. writeProperty installs a short-lived
    // local value overlay, so filter membership can be recomputed in the same
    // interaction that committed the edit.
    await this.loadAndRender(this.databaseFile);
  }

  resolveRelationFile(linkText, sourcePath) {
    const target = stripWikiLink(linkText);
    if (!target) return null;
    const direct = this.app.vault.getAbstractFileByPath(`${target}.md`);
    if (direct instanceof TFile) return direct;
    const resolved = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath || "");
    if (resolved instanceof TFile) return resolved;
    const byName = this.app.metadataCache.getFirstLinkpathDest(pathBasenameNoExt(target), sourcePath || "");
    return byName instanceof TFile ? byName : null;
  }

  createRelationCell(td, file, field, currentValue) {
    td.addClass("lmd-db-relation-cell");
    td.toggleClass("is-wrap", this.currentViewWrap === true);
    td.toggleClass("is-truncate", this.currentViewWrap !== true);
    const values = Array.isArray(currentValue) ? currentValue : (currentValue ? [currentValue] : []);
    const chips = td.createDiv({ cls: "lmd-db-relation-chips" });
    if (!values.length && !field.relationTarget && !isFlexibleRelation(field)) chips.createSpan({ cls: "lmd-db-empty-value", text: "尚未綁定資料庫" });
    if (!values.length && isFlexibleRelation(field)) chips.createSpan({ cls: "lmd-db-empty-value", text: "未連結" });
    for (const raw of values) {
      const target = stripWikiLink(raw);
      const resolved = this.resolveRelationFile(target, file.path);
      const label = resolved?.basename || pathBasenameNoExt(target);
      const chip = chips.createEl("button", { cls: "lmd-db-relation-chip", text: label, attr: { type: "button" } });
      chip.title = resolved?.path || target;
      chip.addEventListener("pointerdown", (event) => event.stopPropagation());
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const link = resolved ? stripMdExtension(resolved.path) : target;
        void this.app.workspace.openLinkText(link, file.path, false);
      });
    }
    const openPicker = (event) => {
      event?.preventDefault();
      event?.stopPropagation();
      const openRelationItems = () => {
        new RelationPickerModal(this.app, field.relationTarget, currentValue, async (values) => {
          const ok = await this.writeProperty(file, field, values);
          if (!ok) return;
          await this.waitForMetadataRefresh(file);
          chips.empty();
          for (const raw of values) {
            const resolved = this.resolveRelationFile(raw, file.path);
            const label = resolved?.basename || pathBasenameNoExt(raw);
            const chip = chips.createEl("button", { cls: "lmd-db-relation-chip", text: label, attr: { type: "button" } });
            chip.title = resolved?.path || raw;
            chip.addEventListener("pointerdown", (event) => event.stopPropagation());
            chip.addEventListener("click", (event) => {
              event.preventDefault(); event.stopPropagation();
              const link = resolved ? stripMdExtension(resolved.path) : raw;
              void this.app.workspace.openLinkText(link, file.path, false);
            });
          }
          await this.refreshTableIfFilterAffected(file, field);
        }).open();
      };
      if (isFlexibleRelation(field)) {
        new FlexibleRelationPickerModal(this.app, this.databaseFile?.path || "", file.path, currentValue, async (values) => {
          const ok = await this.writeProperty(file, field, values);
          if (!ok) return;
          await this.waitForMetadataRefresh(file);
          chips.empty();
          if (!values.length) chips.createSpan({ cls: "lmd-db-empty-value", text: "未連結" });
          for (const raw of values) {
            const resolved = this.resolveRelationFile(raw, file.path);
            const label = resolved?.basename || pathBasenameNoExt(raw);
            const chip = chips.createEl("button", { cls: "lmd-db-relation-chip", text: label, attr: { type: "button" } });
            chip.title = resolved?.path || raw;
            chip.addEventListener("pointerdown", (event) => event.stopPropagation());
            chip.addEventListener("click", (event) => {
              event.preventDefault(); event.stopPropagation();
              const link = resolved ? stripMdExtension(resolved.path) : raw;
              void this.app.workspace.openLinkText(link, file.path, false);
            });
          }
          await this.refreshTableIfFilterAffected(file, field);
        }).open();
        return;
      }
      if (field.relationTarget) { openRelationItems(); return; }
      new RelationTargetModal(this.app, this.databaseFile?.path || "", "", async (targetPath) => {
        field.relationMode = "fixed";
        field.relationTarget = targetPath;
        await this.saveDefinition(this.databaseFile, this.definition);
        await this.loadAndRender(this.databaseFile);
        new Notice(`Relation 已綁定：${targetPath}`);
      }).open();
    };
    td.addEventListener("click", openPicker);
  }

  async applySelectOptionsChange(field, rawFiles, result) {
    if (!field?.id || !result) return;
    const renames=result.renames||{}; const deleted=new Set(result.deleted||[]);
    field.options=Array.from(new Set((result.options||[]).map(String).map((v)=>v.trim()).filter(Boolean)));
    field.optionColors={...(result.colors||{})};
    for (const note of rawFiles || []) {
      const raw=this.getColumnValue(note,field);
      let changed=false, next=raw;
      if(field.type==="multi-select"){
        const values=Array.isArray(raw)?raw.map(String):(raw?[String(raw)]:[]); const out=[];
        for(const value of values){ if(deleted.has(value)){changed=true;continue;} const mapped=renames[value]||value; if(mapped!==value)changed=true; if(mapped&&!out.includes(mapped))out.push(mapped); }
        next=out.length?out:undefined;
      } else {
        const value=raw===undefined||raw===null?"":String(raw); if(deleted.has(value)){next=undefined;changed=true;} else if(renames[value]){next=renames[value];changed=true;}
      }
      if(!changed) continue;
      const storedNext=this.storedValueForField(field,next);
      try {
        if(this.isCanvasItem(note)){
          const id=this.getStableItemId(note); const store=this.ensureCanvasStore(); const meta=store[id]||{id,path:note.path,properties:{}};
          if(!meta.properties||typeof meta.properties!=="object")meta.properties={};
          if(storedNext===undefined)delete meta.properties[field.id];else meta.properties[field.id]=storedNext;
          meta.path=note.path; store[id]=meta;
        } else {
          await this.app.fileManager.processFrontMatter(note,(fm)=>{ if(storedNext===undefined) delete fm[field.id]; else fm[field.id]=storedNext; });
        }
        this.rememberLocalColumnValue(note,field,storedNext); void this.plugin?.broadcastDatabaseRowChange?.(this,note,field,storedNext);
      }
      catch(error){console.error("Local Markdown Database: select option migration failed",note.path,error);}
    }
    await this.persistSelectFieldDefinition(field);
    await this.loadAndRender(this.databaseFile);
  }

  async persistSelectFieldDefinition(field) {
    if (!field?.id || !this.databaseFile) return;
    try {
      if (this.isEmbedded !== true) {
        await this.saveDefinition(this.databaseFile, this.definition);
      } else {
        const raw = await this.app.vault.read(this.databaseFile);
        const sourceDef = JSON.parse(raw);
        const target = Array.isArray(sourceDef.schema) ? sourceDef.schema.find((item)=>item?.id===field.id) : null;
        if (!target) return;
        target.options = Array.isArray(field.options) ? field.options.slice() : [];
        target.optionColors = { ...(field.optionColors || {}) };
        await this.app.vault.modify(this.databaseFile, JSON.stringify(sourceDef, null, 2));
      }
      this.repaintSelectOptionColors(field);
      // Schema colors are global to the Database. Refresh other live renderers so
      // every A chip changes together instead of only the cell that opened picker.
      void this.plugin?.broadcastDatabaseDefinitionChange?.(this.databaseFile);
    } catch (error) { console.error("Local Markdown Database: persist select schema failed", error); }
  }

  collectMultiSelectSuggestions(field) {
    const sourcePath = normalizePath(this.definition?.source?.path || "");
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFolder)) return [];
    const values = new Set(Array.isArray(field?.options) ? field.options.map(String) : []);
    for (const candidate of this.collectMarkdownFiles(source)) {
      const cache = this.app.metadataCache.getFileCache(candidate);
      const raw = cache?.frontmatter?.[field.id];
      const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      for (const item of items) {
        const value = String(item).trim();
        if (value) values.add(value);
      }
    }
    return Array.from(values);
  }

  chipClassFor(field, value) {
    return `lmd-db-option-chip is-${normalizeOptionColor(field.optionColors?.[value])}`;
  }

  createSingleSelectCell(td, file, field, currentValue) {
    td.addClass("lmd-db-multiselect-cell", "lmd-db-single-select-cell");
    td.dataset.fieldId = field.id;
    td.toggleClass("is-wrap", this.currentViewWrap === true);
    td.toggleClass("is-truncate", this.currentViewWrap !== true);
    let value = currentValue === undefined || currentValue === null ? "" : String(currentValue);
    const chips = td.createDiv({ cls: "lmd-db-multiselect-chips lmd-db-single-select-chips" });
    const paint = () => { chips.empty(); if (value) { const chip = chips.createSpan({ cls: this.chipClassFor(field, value), text: value }); chip.dataset.optionValue = value; } };
    paint();
    td.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      const suggestions = this.collectMultiSelectSuggestions(field);
      new MultiSelectPickerModal(this.app, field, suggestions, value ? [value] : [], async (selected, colors, options) => {
        field.optionColors = colors;
        field.options = Array.from(new Set((options || []).map(String).map((v)=>v.trim()).filter(Boolean)));
        await this.persistSelectFieldDefinition(field);
        this.repaintSelectOptionColors(field);
        const next = selected[0] || "";
        const ok = await this.writeProperty(file, field, next);
        if (!ok) return;
        value = next; paint();
        await this.refreshTableIfFilterAffected(file, field);
      }).open();
    });
  }

  createMultiSelectCell(td, file, field, currentValue) {
    td.addClass("lmd-db-multiselect-cell");
    td.dataset.fieldId = field.id;
    td.toggleClass("is-wrap", this.currentViewWrap === true);
    td.toggleClass("is-truncate", this.currentViewWrap !== true);
    const values = Array.isArray(currentValue) ? currentValue.map(String) : (currentValue ? [String(currentValue)] : []);
    const chips = td.createDiv({ cls: "lmd-db-multiselect-chips" });
    
    for (const value of values) { const chip = chips.createSpan({ cls: this.chipClassFor(field, value), text: value }); chip.dataset.optionValue = value; }
    // Hidden editor preserves rectangular copy/paste compatibility from 0.3.
    const mirror = td.createEl("input", { cls: "lmd-db-cell-input lmd-db-multiselect-mirror", attr: { type: "text", tabindex: "-1", "aria-hidden": "true" } });
    mirror.value = values.join(", ");
    const open = (event) => {
      event?.preventDefault(); event?.stopPropagation();
      const suggestions = this.collectMultiSelectSuggestions(field);
      new MultiSelectPickerModal(this.app, field, suggestions, values, async (selected, colors, options) => {
        field.optionColors = colors;
        field.options = Array.from(new Set((options || []).map(String).map((v)=>v.trim()).filter(Boolean)));
        await this.persistSelectFieldDefinition(field);
        this.repaintSelectOptionColors(field);
        const metadataReady = this.waitForMetadataRefresh(file);
        const ok = await this.writeProperty(file, field, selected);
        if (!ok) return;
        await metadataReady;
        chips.empty();
        for (const value of selected) { const chip = chips.createSpan({ cls: this.chipClassFor(field, value), text: value }); chip.dataset.optionValue = value; }
        mirror.value = selected.join(", ");
        await this.refreshTableIfFilterAffected(file, field);
      }).open();
    };
    td.addEventListener("click", open);
  }

  createTextCell(td, file, field, currentValue) {
    td.toggleClass("is-wrap", this.currentViewWrap === true);
    td.toggleClass("is-truncate", this.currentViewWrap !== true);
    const value = formatProperty(currentValue);
    td.addClass("is-markdown-cell");
    const display = td.createDiv({ cls: "lmd-db-markdown-display" });
    const input = td.createEl("textarea", { cls: "lmd-db-cell-input lmd-db-markdown-editor", attr: { rows: "1", placeholder: "" } });
    input.dataset.fieldType = field.type;
    input.value = value;
    let initial = value;
    let isComposing = false;
    const render = async () => {
      display.empty();
      if (!initial) return;
      try { await MarkdownRenderer.render(this.app, prepareMarkdownForCell(initial), display, file.path, this); }
      catch (_) { display.setText(initial); }
    };
    void render();
    const syncEditorHeight = () => {
      if (!this.currentViewWrap) return;
      input.style.height = "auto";
      input.style.height = `${Math.max(28, input.scrollHeight)}px`;
    };
    const beginEdit = () => {
      if (td.hasClass("is-editing")) return;
      const renderedHeight = Math.max(28, display.getBoundingClientRect().height, td.getBoundingClientRect().height);
      td.addClass("is-editing");
      if (this.currentViewWrap) input.style.minHeight = `${Math.ceil(renderedHeight)}px`;
      input.focus({ preventScroll: true });
      syncEditorHeight();
    };
    display.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); beginEdit(); });
    const commit = async () => {
      if (input.value !== initial) {
        const ok = await this.writeProperty(file, field, input.value);
        if (ok) { initial = input.value; await this.refreshTableIfFilterAffected(file, field); } else input.value = initial;
      }
      td.removeClass("is-editing");
      input.style.height = "";
      input.style.minHeight = "";
      void render();
    };
    input.addEventListener("focus", () => this.beginEditorSession());
    input.addEventListener("compositionstart", () => { isComposing = true; this.beginCompositionSession(); });
    input.addEventListener("compositionend", () => { isComposing = false; this.endCompositionSession(); syncEditorHeight(); });
    input.addEventListener("blur", () => { if (!isComposing) void commit(); this.endEditorSession(); });
    input.addEventListener("input", syncEditorHeight);
    const wrapSelection = (before, after = before) => {
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      const selected = input.value.slice(start, end);
      input.setRangeText(`${before}${selected}${after}`, start, end, "end");
      if (selected) {
        input.setSelectionRange(start + before.length, end + before.length);
      } else {
        const caret = start + before.length;
        input.setSelectionRange(caret, caret);
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const handleMarkdownHotkey = (event) => {
      if (document.activeElement !== input) return false;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return false;
      const key = String(event.key || "").toLowerCase();
      if (key !== "b" && key !== "i") return false;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      wrapSelection(key === "b" ? "**" : "*", key === "b" ? "**" : "*");
      return true;
    };
    // Obsidian owns document-level Mod+B / Mod+I hotkeys. Listen on window capture
    // while this textarea is active so Markdown formatting wins before Obsidian handles them.
    const captureHotkey = (event) => { handleMarkdownHotkey(event); };
    input.addEventListener("focus", () => window.addEventListener("keydown", captureHotkey, true));
    input.addEventListener("blur", () => window.removeEventListener("keydown", captureHotkey, true));
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || isComposing || event.keyCode === 229) return;
      if (handleMarkdownHotkey(event)) return;
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); input.blur(); return; }
      if (event.key === "Escape") { event.preventDefault(); input.value = initial; td.removeClass("is-editing"); input.blur(); return; }
    });
  }


  getBoardGroupValues(file, field) {
    if (!field) return [];
    const raw = this.getColumnValue(file, field);
    if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) return [];
    if (Array.isArray(raw)) return raw.map((value) => String(value).trim()).filter(Boolean);
    return [String(raw).trim()].filter(Boolean);
  }

  getBoardGroupLabel(raw, field) {
    if (raw === "__lmd_ungrouped__") return "未分類";
    if (field?.type === "relation") return pathBasenameNoExt(stripWikiLink(raw));
    return raw;
  }

  getTableGroupKey(file, field) {
    if (!field) return "__lmd_all__";
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = (cache && cache.frontmatter) || {};
    const raw = frontmatter[field.id];
    if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) return "__lmd_ungrouped__";
    if (Array.isArray(raw)) return raw.map((value) => String(value).trim()).filter(Boolean).join(" · ") || "__lmd_ungrouped__";
    return String(raw).trim() || "__lmd_ungrouped__";
  }

  getTableGroupLabel(key, field = null) {
    if (key === "__lmd_ungrouped__") return "未分類";
    if (field?.type === "relation") {
      return String(key).split(" · ").map((part) => pathBasenameNoExt(stripWikiLink(part))).filter(Boolean).join(" · ") || "未分類";
    }
    return key;
  }

  async moveBoardCard(file, field, sourceGroup, targetGroup) {
    if (!field) return false;
    const ungrouped = "__lmd_ungrouped__";
    const target = targetGroup === ungrouped ? "" : targetGroup;
    const source = sourceGroup === ungrouped ? "" : sourceGroup;
    if (field.type === "multi-select" || field.type === "relation") {
      const current = this.getBoardGroupValues(file, field);
      let next = current.slice();
      if (source) next = next.filter((value) => value !== source);
      if (target && !next.includes(target)) next.push(target);
      if (!source && target && !next.includes(target)) next.push(target);
      return await this.writeProperty(file, field, next);
    }
    return await this.writeProperty(file, field, target);
  }

  async renderCalendarView(databaseFile, definition, activeViewEntry, view, source, rawFiles, schema, columns, files) {
    document.querySelectorAll(".lmd-db-calendar-year-preview").forEach((el)=>el.remove());
    const fieldById = new Map(schema.map((field) => [field.id, field]));
    const dateFields = schema.filter((field) => field?.type === "date" && field.id);
    let dateField = dateFields.find((field) => field.id === view.calendarDateField) || dateFields[0];
    if (!dateField) {
      this.contentEl.createDiv({ cls: "lmd-db-empty-state", text: "Calendar 需要至少一個日期（date）property。" });
      return;
    }
    view.calendarDateField = dateField.id;
    if (!["year", "month", "week", "day"].includes(view.calendarScale)) view.calendarScale = "month";


    const shadowSources = [];
    for (const configured of view.calendarShadowSources || []) {
      if (configured.enabled === false) continue;
      const shadowDb = this.app.vault.getAbstractFileByPath(normalizePath(configured.databasePath || ""));
      if (!(shadowDb instanceof TFile) || shadowDb.extension !== DATABASE_EXTENSION) continue;
      const shadowDef = await this.plugin.readDatabaseDefinition(shadowDb); if (!shadowDef || shadowDef.source?.type !== "folder") continue;
      const shadowSchema = Array.isArray(shadowDef.schema) ? shadowDef.schema : [];
      let shadowDateField = shadowSchema.find((field)=>field?.type === "date" && field.id === configured.dateField) || shadowSchema.find((field)=>field?.type === "date" && field.id);
      if (!shadowDateField) continue;
      let folder = shadowDef.source.path ? this.app.vault.getAbstractFileByPath(normalizePath(shadowDef.source.path)) : this.app.vault.getRoot();
      if (!(folder instanceof TFolder)) continue;
      shadowSources.push({ databaseFile:shadowDb, definition:shadowDef, dateField:shadowDateField, files:this.collectMarkdownFiles(folder), label:shadowDef.name || shadowDb.basename });
    }

    const pad = (n) => String(n).padStart(2, "0");
    const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const dateKeyParts = (y,m,d) => `${y}-${pad(m+1)}-${pad(d)}`;
    const rawDateKey = (value) => {
      if (value instanceof Date && Number.isFinite(value.getTime())) return dateKey(value);
      return parseDateRangeValue(value).startDate;
    };
    const rawTimeKey = (value) => parseDateRangeValue(value).startTime;
    const rawEndDateKey = (value) => parseDateRangeValue(value).endDate;
    const rawEndTimeKey = (value) => parseDateRangeValue(value).endTime;
    const dateTimeValue = (key, time) => `${key}T${time || "00:00"}`;
    const parseKey = (key) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
      return m ? new Date(Number(m[1]), Number(m[2])-1, Number(m[3])) : new Date();
    };
    let anchor = parseKey(view.calendarAnchor);
    if (!Number.isFinite(anchor.getTime())) anchor = new Date();
    if (!this._calendarFocusApplied) this._calendarFocusApplied = new Set();
    if (view.calendarFocusDate && !this._calendarFocusApplied.has(activeViewEntry.id)) {
      anchor = parseKey(view.calendarFocusDate);
      view.calendarAnchor = dateKey(anchor);
      view.calendarMonth = `${anchor.getFullYear()}-${pad(anchor.getMonth()+1)}`;
      this._calendarFocusApplied.add(activeViewEntry.id);
    }
    const setAnchor = async (d, rerender = true) => {
      view.calendarAnchor = dateKey(d);
      view.calendarMonth = `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
      await this.saveDefinition(databaseFile, definition);
      if (rerender) await this.loadAndRender(databaseFile);
    };
    const mondayOfWeek = (d) => {
      const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
      return copy;
    };
    const isoWeekInfo = (d) => {
      const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = x.getUTCDay() || 7;
      x.setUTCDate(x.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
      const week = Math.ceil((((x - yearStart) / 86400000) + 1) / 7);
      return { year: x.getUTCFullYear(), week };
    };
    const dateFromIsoWeek = (year, week) => {
      const jan4 = new Date(year, 0, 4);
      const start = mondayOfWeek(jan4);
      start.setDate(start.getDate() + (week - 1) * 7);
      return start;
    };

    const selectedCalendarPaths = new Set();
    let suppressCalendarClickUntil = 0;
    const clearNativeSelection = () => { try { window.getSelection()?.removeAllRanges(); } catch (_) {} };
    const clearCalendarDragVisuals = () => {
      document.body.removeClass("lmd-db-is-calendar-dragging", "lmd-db-is-row-marqueeing", "lmd-db-is-cell-selecting");
      for (const el of this.contentEl.querySelectorAll(".lmd-db-calendar .is-drop-target, .lmd-db-calendar-year .is-drop-target, .lmd-db-calendar-week .is-drop-target, .lmd-db-calendar-day-view .is-drop-target, .lmd-db-calendar .is-dragging, .lmd-db-calendar-undated .is-dragging")) {
        el.removeClass("is-drop-target", "is-dragging");
      }
      for (const marquee of document.querySelectorAll(".lmd-db-row-marquee")) marquee.remove();
      clearNativeSelection(); requestAnimationFrame(clearNativeSelection);
    };
    const paintCalendarSelection = () => {
      for (const el of this.contentEl.querySelectorAll("[data-calendar-path]")) el.classList.toggle("is-selected", selectedCalendarPaths.has(el.dataset.calendarPath || ""));
    };
    const calendarDragPathsFor = (path) => selectedCalendarPaths.has(path) && selectedCalendarPaths.size > 1
      ? files.map((file) => file.path).filter((candidate) => selectedCalendarPaths.has(candidate)) : [path];
    const writeCalendarDateAndRefresh = async (paths, key, explicitTime = "") => {
      const targets = paths.map((path) => this.app.vault.getAbstractFileByPath(path)).filter((file) => file instanceof TFile);
      if (!targets.length) return false;
      const waits = targets.map((file) => this.waitForMetadataRefresh(file, 1400));
      const results = await Promise.all(targets.map((file) => {
        const old = this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id];
        const r = parseDateRangeValue(old);
        const oldStart = r.startDate ? parseKey(r.startDate) : parseKey(key), newStart = parseKey(key);
        const deltaDays = Math.round((newStart-oldStart)/86400000);
        r.startDate=key;
        if (explicitTime) { r.hasTime=true; r.startTime=explicitTime; }
        if (r.hasEnd && r.endDate) { const e=parseKey(r.endDate);e.setDate(e.getDate()+deltaDays);r.endDate=dateKey(e); }
        return this.writeProperty(file,dateField,formatDateRangeValue(r));
      }));
      await Promise.all(waits);
      if (!results.some(Boolean)) return false;
      selectedCalendarPaths.clear(); clearCalendarDragVisuals(); await this.loadAndRender(databaseFile); return true;
    };

    // A fixed, button-anchored popover avoids Obsidian Menu drifting away when the
    // database pane scrolls. It repositions on every scroll/resize instead.
    const showAnchoredPicker = (button, rows) => {
      document.querySelectorAll(".lmd-db-calendar-anchor-menu").forEach((el) => el.remove());
      const pop = document.body.createDiv({ cls: "lmd-db-calendar-anchor-menu" });
      let raf = 0;
      const place = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (!pop.isConnected || !button.isConnected) return;
          const r = button.getBoundingClientRect();
          const width = Math.max(128, pop.offsetWidth || 128);
          let left = r.left;
          if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
          pop.style.left = `${Math.round(left)}px`;
          pop.style.top = `${Math.round(r.bottom + 5)}px`;
        });
      };
      const close = () => {
        cancelAnimationFrame(raf); pop.remove();
        window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place, true);
        document.removeEventListener("pointerdown", outside, true);
      };
      const outside = (event) => { if (!pop.contains(event.target) && !button.contains(event.target)) close(); };
      for (const row of rows) {
        const item = pop.createEl("button", { cls: "lmd-db-calendar-anchor-menu-item", attr: { type: "button" } });
        item.createSpan({ text: row.label });
        if (row.checked) { const check = item.createSpan({ cls: "lmd-db-calendar-anchor-menu-check" }); setIcon(check, "check"); }
        item.addEventListener("click", async (event) => { event.preventDefault(); event.stopPropagation(); close(); await row.onClick(); });
      }
      window.addEventListener("scroll", place, true); window.addEventListener("resize", place, true);
      setTimeout(() => document.addEventListener("pointerdown", outside, true), 0); place();
    };

    const showJumpPicker = (button) => {
      document.querySelectorAll(".lmd-db-calendar-anchor-menu").forEach((el) => el.remove());
      const pop = document.body.createDiv({ cls: "lmd-db-calendar-anchor-menu lmd-db-calendar-jump-menu" });
      const label = pop.createDiv({ cls: "lmd-db-calendar-jump-label", text: view.calendarScale === "year" ? "前往年份" : view.calendarScale === "month" ? "前往月份" : view.calendarScale === "week" ? "前往週" : "前往日期" });
      const input = pop.createEl("input", { cls: "lmd-db-calendar-jump-input" });
      if (view.calendarScale === "year") { input.type = "number"; input.min = "1"; input.max = "9999"; input.value = String(anchor.getFullYear()); }
      else if (view.calendarScale === "month") { input.type = "month"; input.value = `${anchor.getFullYear()}-${pad(anchor.getMonth()+1)}`; }
      else if (view.calendarScale === "week") { const w = isoWeekInfo(anchor); input.type = "week"; input.value = `${w.year}-W${pad(w.week)}`; }
      else { input.type = "date"; input.value = dateKey(anchor); }
      const go = pop.createEl("button", { cls: "mod-cta lmd-db-calendar-jump-go", text: "前往" });
      let raf = 0;
      const place = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (!pop.isConnected || !button.isConnected) return; const r=button.getBoundingClientRect(); const width=Math.max(190,pop.offsetWidth||190); let left=r.left; if(left+width>window.innerWidth-8) left=Math.max(8,window.innerWidth-width-8); pop.style.left=`${Math.round(left)}px`; pop.style.top=`${Math.round(r.bottom+5)}px`; }); };
      const close = () => { cancelAnimationFrame(raf); pop.remove(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place, true); document.removeEventListener("pointerdown", outside, true); };
      const outside = (event) => { if (!pop.contains(event.target) && !button.contains(event.target)) close(); };
      const submit = async () => {
        let d = null;
        if (view.calendarScale === "year") { const y=Number(input.value); if(Number.isInteger(y)&&y>0) d=new Date(y, anchor.getMonth(), 1); }
        else if (view.calendarScale === "month") { const m=/^(\d{4})-(\d{2})$/.exec(input.value); if(m) d=new Date(Number(m[1]),Number(m[2])-1,1); }
        else if (view.calendarScale === "week") { const w=/^(\d{4})-W(\d{2})$/.exec(input.value); if(w) d=dateFromIsoWeek(Number(w[1]),Number(w[2])); }
        else { const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value); if(m) d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3])); }
        if (!d || !Number.isFinite(d.getTime())) { new Notice("請輸入有效日期。"); return; }
        close(); await setAnchor(d);
      };
      go.addEventListener("click", () => void submit()); input.addEventListener("keydown", (event) => { if(event.key === "Enter") { event.preventDefault(); void submit(); } });
      window.addEventListener("scroll", place, true); window.addEventListener("resize", place, true); setTimeout(()=>document.addEventListener("pointerdown",outside,true),0); place(); setTimeout(()=>input.focus(),0);
    };

    const toolbar = this.contentEl.createDiv({ cls: "lmd-db-toolbar lmd-db-calendar-toolbar" });
    const navButton = (icon, label, fn) => {
      const button = toolbar.createEl("button", { cls: "lmd-db-toolbar-button", attr: { title: label, "aria-label": label } });
      const iconEl = button.createSpan({ cls: "lmd-db-toolbar-icon" }); setIcon(iconEl, icon);
      button.createSpan({ cls: "lmd-db-toolbar-label", text: label }); button.addEventListener("click", fn); return button;
    };
    const scale = view.calendarScale;
    const shiftAnchor = (amount) => {
      const d = new Date(anchor);
      if (scale === "year") d.setFullYear(d.getFullYear() + amount);
      else if (scale === "month") d.setMonth(d.getMonth() + amount);
      else if (scale === "week") d.setDate(d.getDate() + amount * 7);
      else d.setDate(d.getDate() + amount);
      return d;
    };
    const prevLabel = scale === "year" ? "上一年" : scale === "month" ? "上個月" : scale === "week" ? "上週" : "上一天";
    const nextLabel = scale === "year" ? "下一年" : scale === "month" ? "下個月" : scale === "week" ? "下週" : "下一天";
    navButton("chevron-left", prevLabel, async () => await setAnchor(shiftAnchor(-1)));
    navButton("calendar-days", "今天", async () => await setAnchor(new Date()));
    navButton("chevron-right", nextLabel, async () => await setAnchor(shiftAnchor(1)));

    const weekInfoForAnchor = isoWeekInfo(anchor);
    const jumpLabel = scale === "year" ? `${anchor.getFullYear()} 年` : scale === "month" ? `${anchor.getFullYear()} 年 ${anchor.getMonth()+1} 月` : scale === "week" ? `${weekInfoForAnchor.year} · 第 ${weekInfoForAnchor.week} 週` : `${anchor.getFullYear()}/${anchor.getMonth()+1}/${anchor.getDate()}`;
    const jumpButton = navButton("calendar-search", jumpLabel, () => showJumpPicker(jumpButton));

    const focusButton = navButton("pin", view.calendarFocusDate ? "故事焦點" : "設定焦點", (event) => {
      event.preventDefault(); event.stopPropagation();
      const rows = [];
      if (view.calendarFocusDate) rows.push({ label: `前往焦點 · ${view.calendarFocusDate}`, checked: false, onClick: async () => await setAnchor(parseKey(view.calendarFocusDate)) });
      rows.push({ label: `將目前日期設為焦點 · ${dateKey(anchor)}`, checked: view.calendarFocusDate === dateKey(anchor), onClick: async () => { view.calendarFocusDate = dateKey(anchor); await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile); } });
      if (view.calendarFocusDate) rows.push({ label: "清除預設焦點", checked: false, onClick: async () => { view.calendarFocusDate = ""; await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile); } });
      showAnchoredPicker(focusButton, rows);
    });

    const filterButton = navButton("list-filter", "篩選", () => new AddFilterModal(this.app, allColumns, async (rule) => { view.filters.push(rule); await this.saveCurrentViewState(databaseFile, definition); await this.loadAndRender(databaseFile); }, this.buildFilterSuggestions(columns, rawFiles)).open());
    const shadowButton = navButton("layers", `影子${shadowSources.length ? ` · ${shadowSources.length}` : ""}`, () => {
      new CalendarShadowSourcesModal(this.app, this.plugin, databaseFile.path, view.calendarShadowSources || [], async (sources) => {
        view.calendarShadowSources = sources; await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile);
      }).open();
    });
    if (view.filters.length) filterButton.createSpan({ cls: "lmd-db-toolbar-badge", text: String(view.filters.length) });

    const scaleButton = toolbar.createEl("button", { cls: "lmd-db-toolbar-button", attr: { title: "Calendar 尺度", "aria-label": "Calendar 尺度" } });
    const scaleIcon = scaleButton.createSpan({ cls: "lmd-db-toolbar-icon" }); setIcon(scaleIcon, "calendar-clock");
    const scaleLabels = { year: "年", month: "月", week: "週", day: "日" };
    scaleButton.createSpan({ cls: "lmd-db-toolbar-label", text: scaleLabels[scale] });
    scaleButton.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      showAnchoredPicker(scaleButton, ["year","month","week","day"].map((value) => ({
        label: scaleLabels[value], checked: value === view.calendarScale,
        onClick: async () => { view.calendarScale = value; await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile); }
      })));
    });

    const fieldButton = toolbar.createEl("button", { cls: "lmd-db-toolbar-button" });
    const fieldIcon = fieldButton.createSpan({ cls: "lmd-db-toolbar-icon" }); setIcon(fieldIcon, "calendar-range");
    fieldButton.createSpan({ cls: "lmd-db-toolbar-label", text: dateField.name || dateField.id });
    fieldButton.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      showAnchoredPicker(fieldButton, dateFields.map((field) => ({
        label: field.name || field.id, checked: field.id === dateField.id,
        onClick: async () => { view.calendarDateField = field.id; await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile); }
      })));
    });
    const cardFieldsButton = toolbar.createEl("button", { cls: "lmd-db-toolbar-button", attr: { title: "卡片內容", "aria-label": "卡片內容" } });
    const cardFieldsIcon = cardFieldsButton.createSpan({ cls: "lmd-db-toolbar-icon" }); setIcon(cardFieldsIcon, "layout-list");
    cardFieldsButton.createSpan({ cls: "lmd-db-toolbar-label", text: "卡片內容" });
    cardFieldsButton.addEventListener("click", () => {
      new BoardCardFieldsModal(this.app, schema, view.calendarCardFields, async (fieldIds) => {
        view.calendarCardFields = fieldIds; await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile);
      }, "Calendar").open();
    });

    const calendarRuleBar = this.contentEl.createDiv({ cls: "lmd-db-rule-bar lmd-db-calendar-rule-bar" });
    for (let i=0;i<view.filters.length;i++) {
      const r=view.filters[i], c=columns.find((x)=>x.id===r.field);
      const val=(["empty","not-empty","checked","unchecked"].includes(r.operator))?"":` ${r.value}`;
      const chip=calendarRuleBar.createEl("button", { cls:"lmd-db-rule-chip", text:`篩選：${c?.name||r.field} ${this.filterOperatorLabel(r.operator)}${val} ×` });
      chip.addEventListener("click", async()=>{ view.filters.splice(i,1); await this.saveCurrentViewState(databaseFile,definition); await this.loadAndRender(databaseFile); });
    }
    if (!view.filters.length) calendarRuleBar.style.display = "none";

    const calendarPreviewFields = (view.calendarCardFields || []).map((id) => fieldById.get(id)).filter(Boolean);
    const renderCalendarCard = (item, file, compact = false) => {
      const head = item.createDiv({ cls: "lmd-db-calendar-item-head" });
      const icon = head.createSpan({ cls: "lmd-db-calendar-item-icon" }); setIcon(icon, "file-text");
      head.createSpan({ cls: "lmd-db-calendar-item-title", text: file.basename });
      {
        const rawDate = this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id];
        const rr = parseDateRangeValue(rawDate);
        if (rr.startTime) head.createSpan({ cls: "lmd-db-calendar-item-time", text: rr.hasEnd && rr.endTime ? `${rr.startTime}–${rr.endTime}` : rr.startTime });
      }
      if (compact || !calendarPreviewFields.length) return;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const props = item.createDiv({ cls: "lmd-db-calendar-item-properties" });
      for (const field of calendarPreviewFields) {
        const value = frontmatter[field.id];
        if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
        const line = props.createDiv({ cls: `lmd-db-calendar-item-property is-${field.type}` });
        line.createSpan({ cls: "lmd-db-calendar-item-property-name", text: field.name || field.id });
        const valueHost = line.createDiv({ cls: "lmd-db-calendar-item-property-value" });
        if (field.type === "multi-select") {
          valueHost.addClass("lmd-db-multiselect-chips");
          const values = Array.isArray(value) ? value.map(String) : [String(value)];
          for (const chipValue of values) valueHost.createSpan({ cls: this.chipClassFor(field, chipValue), text: chipValue });
        } else if (field.type === "relation") {
          valueHost.addClass("lmd-db-relation-chips");
          const values = Array.isArray(value) ? value : [value];
          for (const raw of values) {
            const target = stripWikiLink(raw); const resolved = this.resolveRelationFile(target, file.path); const label = resolved?.basename || pathBasenameNoExt(target);
            const chip = valueHost.createEl("button", { cls: "lmd-db-relation-chip", text: label, attr: { type: "button" } });
            chip.title = resolved?.path || target; chip.draggable = false;
            chip.addEventListener("pointerdown", (event) => event.stopPropagation());
            chip.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void this.app.workspace.openLinkText(resolved ? stripMdExtension(resolved.path) : target, file.path, false); });
          }
        } else if (field.type === "text") {
          valueHost.addClass("lmd-db-calendar-markdown");
          void MarkdownRenderer.render(this.app, prepareMarkdownForCell(formatProperty(value)), valueHost, file.path, this).catch(() => valueHost.setText(formatProperty(value)));
        } else valueHost.setText(formatProperty(value));
      }
      if (!props.childElementCount) props.remove();
    };

    const enumerateRangeKeys = (range) => {
      if (!range?.startDate) return [];
      const endKey = range.hasEnd && range.endDate ? range.endDate : range.startDate;
      const startDate = parseKey(range.startDate), endDate = parseKey(endKey);
      if (!startDate || !endDate || endDate < startDate) return [range.startDate];
      const keys = []; const cursor = new Date(startDate);
      for (let guard = 0; guard < 3700 && cursor <= endDate; guard++) { keys.push(dateKey(cursor)); cursor.setDate(cursor.getDate()+1); }
      return keys;
    };
    const byDate = new Map(); const undated = [];
    for (const file of files) {
      const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id];
      const range = parseDateRangeValue(raw); const keys = enumerateRangeKeys(range);
      if (!keys.length) { undated.push(file); continue; }
      for (const key of keys) { if (!byDate.has(key)) byDate.set(key, []); byDate.get(key).push(file); }
    }
    const shadowByDate = new Map(); const shadowUndated = [];
    for (const sourceEntry of shadowSources) {
      for (const file of sourceEntry.files) {
        const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.[sourceEntry.dateField.id];
        const range = parseDateRangeValue(raw); const keys = enumerateRangeKeys(range); const record = { file, source:sourceEntry };
        if (!keys.length) { shadowUndated.push(record); continue; }
        for (const key of keys) { if (!shadowByDate.has(key)) shadowByDate.set(key, []); shadowByDate.get(key).push(record); }
      }
    }
    for (const list of shadowByDate.values()) list.sort((a,b)=>{
      const av=this.app.metadataCache.getFileCache(a.file)?.frontmatter?.[a.source.dateField.id];
      const bv=this.app.metadataCache.getFileCache(b.file)?.frontmatter?.[b.source.dateField.id];
      return rawTimeKey(av).localeCompare(rawTimeKey(bv));
    });

    for (const list of byDate.values()) list.sort((a, b) => {
      const av = this.app.metadataCache.getFileCache(a)?.frontmatter?.[dateField.id];
      const bv = this.app.metadataCache.getFileCache(b)?.frontmatter?.[dateField.id];
      return rawTimeKey(av).localeCompare(rawTimeKey(bv));
    });
    const today = new Date(); const todayKey = dateKey(today);

    const wireCard = (item, file) => {
      item.dataset.calendarPath = file.path;
      item.addEventListener("click", (event) => {
        if (Date.now() < suppressCalendarClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
        if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopPropagation(); selectedCalendarPaths.has(file.path) ? selectedCalendarPaths.delete(file.path) : selectedCalendarPaths.add(file.path); paintCalendarSelection(); return; }
        void this.openDatabaseItem(file, databaseFile);
      });
      item.addEventListener("dragstart", (event) => {
        event.stopPropagation(); suppressCalendarClickUntil = Date.now() + 350; document.body.addClass("lmd-db-is-calendar-dragging"); clearNativeSelection(); event.dataTransfer.effectAllowed = "move";
        const dragPaths = calendarDragPathsFor(file.path); event.dataTransfer.setData("text/lmd-calendar-file", file.path); event.dataTransfer.setData("text/lmd-calendar-group", JSON.stringify(dragPaths));
        for (const path of dragPaths) this.contentEl.querySelector(`[data-calendar-path="${CSS.escape(path)}"]`)?.addClass("is-dragging");
      });
      item.addEventListener("dragend", () => { suppressCalendarClickUntil = Date.now() + 180; clearCalendarDragVisuals(); });
    };
    const renderShadowCard = (item, record, compact = false) => {
      item.addClass("lmd-db-calendar-shadow-item");
      const head=item.createDiv({cls:"lmd-db-calendar-item-head"});
      const icon=head.createSpan({cls:"lmd-db-calendar-item-icon"}); setIcon(icon,"ghost");
      head.createSpan({cls:"lmd-db-calendar-item-title",text:record.file.basename});
      const raw=this.app.metadataCache.getFileCache(record.file)?.frontmatter?.[record.source.dateField.id];
      const timeLabel=rawTimeKey(raw); if(timeLabel) head.createSpan({cls:"lmd-db-calendar-item-time",text:timeLabel});
      item.createDiv({cls:"lmd-db-calendar-shadow-source",text:record.source.label});
    };
    const wireShadowCard = (item, record) => {
      item.dataset.calendarShadowPath = record.file.path; item.draggable = true;
      item.addEventListener("click",(event)=>{ if(Date.now()<suppressCalendarClickUntil){event.preventDefault();event.stopPropagation();return;} void this.openDatabaseItem(record.file,databaseFile); });
      item.addEventListener("dragstart",(event)=>{ event.stopPropagation(); suppressCalendarClickUntil=Date.now()+350; document.body.addClass("lmd-db-is-calendar-dragging"); clearNativeSelection(); event.dataTransfer.effectAllowed="move"; event.dataTransfer.setData("text/lmd-calendar-shadow",JSON.stringify({path:record.file.path,dateField:record.source.dateField.id,databasePath:record.source.databaseFile.path})); item.addClass("is-dragging"); });
      item.addEventListener("dragend",()=>{suppressCalendarClickUntil=Date.now()+180; clearCalendarDragVisuals();});
    };
    const writeShadowDateAndRefresh = async (payload,key,explicitTime="") => {
      const file=this.app.vault.getAbstractFileByPath(payload?.path||""); if(!(file instanceof TFile)) return false;
      const source=shadowSources.find((entry)=>normalizePath(entry.databaseFile.path)===normalizePath(payload.databasePath||"") && entry.dateField.id===payload.dateField);
      if(!source) return false;
      const old=this.app.metadataCache.getFileCache(file)?.frontmatter?.[source.dateField.id]; const r=parseDateRangeValue(old); const oldStart=r.startDate?parseKey(r.startDate):parseKey(key), newStart=parseKey(key); const deltaDays=Math.round((newStart-oldStart)/86400000); r.startDate=key; if(explicitTime){r.hasTime=true;r.startTime=explicitTime;} if(r.hasEnd&&r.endDate){const e=parseKey(r.endDate);e.setDate(e.getDate()+deltaDays);r.endDate=dateKey(e);} const nextValue=formatDateRangeValue(r);
      const wait=this.waitForMetadataRefresh(file,1400); const ok=await this.writeProperty(file,source.dateField,nextValue); await wait;
      clearCalendarDragVisuals(); if(ok) await this.loadAndRender(databaseFile); return ok;
    };

    const wireDropDate = (host, key) => {
      host.dataset.date = key;
      host.addEventListener("dragover", (event) => { if (!event.dataTransfer.types.includes("text/lmd-calendar-file") && !event.dataTransfer.types.includes("text/lmd-calendar-shadow")) return; event.preventDefault(); host.addClass("is-drop-target"); });
      host.addEventListener("dragleave", () => host.removeClass("is-drop-target"));
      host.addEventListener("drop", async (event) => {
        const shadowRaw=event.dataTransfer.getData("text/lmd-calendar-shadow");
        if(shadowRaw){event.preventDefault();event.stopPropagation();host.removeClass("is-drop-target");let payload=null;try{payload=JSON.parse(shadowRaw);}catch(_){} suppressCalendarClickUntil=Date.now()+350; if(payload) await writeShadowDateAndRefresh(payload,key); return;}
        const path = event.dataTransfer.getData("text/lmd-calendar-file"); if (!path) return;
        event.preventDefault(); event.stopPropagation(); host.removeClass("is-drop-target"); let dragPaths = [];
        try { dragPaths = JSON.parse(event.dataTransfer.getData("text/lmd-calendar-group") || "[]"); } catch (_) {}
        if (!Array.isArray(dragPaths) || !dragPaths.length) dragPaths = [path]; suppressCalendarClickUntil = Date.now() + 350; await writeCalendarDateAndRefresh(dragPaths, key);
      });
    };
    const renderFullDay = (host, key, opts = {}) => {
      host.dataset.date = key; if (key === todayKey) host.addClass("is-today"); wireDropDate(host, key);
      host.addEventListener("dblclick",(event)=>{ if(event.target.closest(".lmd-db-calendar-item,button,a,input,textarea")) return; event.preventDefault(); event.stopPropagation(); void this.createRow(source,dateField,key); });
      const items = host.createDiv({ cls: "lmd-db-calendar-items" });
      for (const file of byDate.get(key) || []) { const rr=parseDateRangeValue(this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id]); if(opts.skipMultiDay && rr.hasEnd && rr.endDate && rr.endDate!==rr.startDate) continue; const item = items.createDiv({ cls: "lmd-db-calendar-item", attr: { draggable: "true" } }); renderCalendarCard(item, file, false); wireCard(item, file); }
      for (const record of shadowByDate.get(key) || []) { const item=items.createDiv({cls:"lmd-db-calendar-item lmd-db-calendar-shadow-item",attr:{draggable:"true"}}); renderShadowCard(item,record,false); wireShadowCard(item,record); }
    };

    if (scale === "year") {
      this.contentEl.createDiv({ cls: "lmd-db-calendar-month-title", text: `${anchor.getFullYear()} 年` });
      const yearGrid = this.contentEl.createDiv({ cls: "lmd-db-calendar-year lmd-db-calendar-selection-safe" }); this.installCtrlWheelZoom(yearGrid, databaseFile, definition, view);
      const year = anchor.getFullYear();
      for (let month=0; month<12; month++) {
        const panel = yearGrid.createDiv({ cls: "lmd-db-calendar-year-month" });
        const monthTitle = panel.createEl("button", { cls: "lmd-db-calendar-year-month-title lmd-db-calendar-year-month-button", text: `${month+1} 月` });
        monthTitle.addEventListener("click", async () => { view.calendarScale = "month"; await setAnchor(new Date(year, month, 1)); });
        const mini = panel.createDiv({ cls: "lmd-db-calendar-year-mini" });
        for (const w of ["一","二","三","四","五","六","日"]) mini.createDiv({ cls: "lmd-db-calendar-year-weekday", text: w });
        const first = new Date(year, month, 1), offset = (first.getDay()+6)%7, count = new Date(year, month+1, 0).getDate();
        for (let i=0; i<42; i++) {
          const dayNum = i-offset+1; const cell = mini.createDiv({ cls: "lmd-db-calendar-year-day" });
          if (dayNum < 1 || dayNum > count) { cell.addClass("is-empty"); continue; }
          const key = dateKeyParts(year, month, dayNum); if (key === todayKey) cell.addClass("is-today"); wireDropDate(cell, key);
          cell.createSpan({ cls: "lmd-db-calendar-year-day-number", text: String(dayNum) });
          const dayFiles = byDate.get(key) || []; const dayShadows = shadowByDate.get(key) || []; const n = dayFiles.length + dayShadows.length;
          if (n) {
            const count = cell.createSpan({ cls: "lmd-db-calendar-year-day-count", text: String(n) });
            let preview = null;
            const closePreview = () => { if (preview) preview.remove(); preview = null; };
            count.addEventListener("mouseenter", () => {
              closePreview(); preview = document.body.createDiv({ cls: "lmd-db-calendar-year-preview" });
              preview.createDiv({ cls: "lmd-db-calendar-year-preview-title", text: `${year}/${month+1}/${dayNum} · ${n} 筆` });
              const previewRows=[...dayFiles.map((file)=>({text:file.basename})),...dayShadows.map((record)=>({text:`${record.file.basename} · ${record.source.label}`}))];
              for (const row of previewRows.slice(0, 8)) preview.createDiv({ cls: "lmd-db-calendar-year-preview-item", text: row.text });
              if (previewRows.length > 8) preview.createDiv({ cls: "lmd-db-calendar-year-preview-more", text: `還有 ${previewRows.length-8} 筆…` });
              const r=count.getBoundingClientRect(); let left=r.left; const width=220; if(left+width>window.innerWidth-8) left=window.innerWidth-width-8; preview.style.left=`${Math.max(8,left)}px`; preview.style.top=`${Math.min(window.innerHeight-20, r.bottom+6)}px`;
            });
            count.addEventListener("mouseleave", closePreview);
            cell.addEventListener("pointerdown", closePreview, { capture:true });
          }
          cell.addEventListener("click", async () => { document.querySelectorAll(".lmd-db-calendar-year-preview").forEach((el)=>el.remove()); view.calendarScale = "day"; await setAnchor(new Date(year, month, dayNum)); });
        }
      }
    } else if (scale === "month") {
      const year = anchor.getFullYear(), month = anchor.getMonth();
      this.contentEl.createDiv({ cls: "lmd-db-calendar-month-title", text: `${year} 年 ${month + 1} 月` });
      const calendar = this.contentEl.createDiv({ cls: "lmd-db-calendar lmd-db-calendar-selection-safe" }); this.installCtrlWheelZoom(calendar, databaseFile, definition, view);
      for (const label of ["一","二","三","四","五","六","日"]) calendar.createDiv({ cls: "lmd-db-calendar-weekday", text: label });
      const first = new Date(year, month, 1), startOffset = (first.getDay()+6)%7, daysInMonth = new Date(year, month+1, 0).getDate(), prevDays = new Date(year, month, 0).getDate();
      for (let index=0; index<42; index++) {
        const logical = index-startOffset+1; let cy=year, cm=month, cd=logical, outside=false;
        if (logical<=0) { outside=true; const d=new Date(year,month-1,prevDays+logical); cy=d.getFullYear(); cm=d.getMonth(); cd=d.getDate(); }
        else if (logical>daysInMonth) { outside=true; const d=new Date(year,month+1,logical-daysInMonth); cy=d.getFullYear(); cm=d.getMonth(); cd=d.getDate(); }
        const key=dateKeyParts(cy,cm,cd); const day=calendar.createDiv({ cls:"lmd-db-calendar-day" }); if(outside) day.addClass("is-outside-month");
        day.createDiv({ cls:"lmd-db-calendar-day-number", text:String(cd) }); renderFullDay(day,key);
      }
    } else if (scale === "week") {
      const start = mondayOfWeek(anchor), end = new Date(start); end.setDate(start.getDate()+6);
      const weekMeta = isoWeekInfo(start);
      this.contentEl.createDiv({ cls:"lmd-db-calendar-month-title", text:`第 ${weekMeta.week} 週 · ${start.getFullYear()}/${start.getMonth()+1}/${start.getDate()} – ${end.getFullYear()}/${end.getMonth()+1}/${end.getDate()}` });
      const week = this.contentEl.createDiv({ cls:"lmd-db-calendar-week lmd-db-calendar-selection-safe" }); this.installCtrlWheelZoom(week, databaseFile, definition, view);
      const cleanupWeekSelection=()=>{clearCalendarDragVisuals(); clearNativeSelection();};
      week.addEventListener("dragend",cleanupWeekSelection,true); week.addEventListener("drop",()=>requestAnimationFrame(cleanupWeekSelection),true); week.addEventListener("pointerup",()=>{if(document.body.hasClass("lmd-db-is-calendar-dragging"))requestAnimationFrame(cleanupWeekSelection);},true);
      const durationArea = week.createDiv({ cls:"lmd-db-calendar-week-duration-area" });
      const weekStartKey=dateKey(start), weekEndKey=dateKey(end);
      const durationRecords=[];
      for(const file of files){const r=parseDateRangeValue(this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id]);if(r.hasEnd&&r.endDate&&r.endDate!==r.startDate&&!(r.endDate<weekStartKey||r.startDate>weekEndKey))durationRecords.push({file,r});}
      for(const rec of durationRecords){const sd=parseKey(rec.r.startDate<weekStartKey?weekStartKey:rec.r.startDate),ed=parseKey(rec.r.endDate>weekEndKey?weekEndKey:rec.r.endDate);const startCol=Math.max(1,Math.floor((sd-start)/86400000)+1),span=Math.max(1,Math.floor((ed-sd)/86400000)+1);const bar=durationArea.createDiv({cls:"lmd-db-calendar-week-duration-bar",attr:{draggable:"true"}});bar.style.gridColumn=`${startCol} / span ${span}`;bar.createSpan({cls:"lmd-db-calendar-week-duration-title",text:rec.file.basename});bar.createSpan({cls:"lmd-db-calendar-week-duration-meta",text:`${rec.r.startDate} → ${rec.r.endDate}`});wireCard(bar,rec.file);}
      const names=["一","二","三","四","五","六","日"];
      for(let i=0;i<7;i++) { const d=new Date(start); d.setDate(start.getDate()+i); const key=dateKey(d); const col=week.createDiv({ cls:"lmd-db-calendar-week-day" });
        col.createDiv({ cls:"lmd-db-calendar-week-day-head", text:`週${names[i]} · ${d.getMonth()+1}/${d.getDate()}` }); renderFullDay(col,key,{skipMultiDay:true}); }
    } else {
      const key=dateKey(anchor); this.contentEl.createDiv({ cls:"lmd-db-calendar-month-title", text:`${anchor.getFullYear()} 年 ${anchor.getMonth()+1} 月 ${anchor.getDate()} 日` });
      const dayView=this.contentEl.createDiv({ cls:"lmd-db-calendar-day-view lmd-db-calendar-selection-safe" }); this.installCtrlWheelZoom(dayView, databaseFile, definition, view);
      dayView.createDiv({ cls:"lmd-db-calendar-day-view-head", text:["日","一","二","三","四","五","六"][anchor.getDay()] ? `星期${["日","一","二","三","四","五","六"][anchor.getDay()]}` : "" });
      {
        const relevant = files.filter((file)=>{const r=parseDateRangeValue(this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id]);const e=r.hasEnd&&r.endDate?r.endDate:r.startDate;return r.startDate&&key>=r.startDate&&key<=e;});
        const allDay = relevant.filter((file)=>!parseDateRangeValue(this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id]).startTime);
        const timed = relevant.filter((file)=>parseDateRangeValue(this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id]).startTime);
        const allDayHost=dayView.createDiv({cls:"lmd-db-calendar-day-all-day"});allDayHost.createDiv({cls:"lmd-db-calendar-day-all-day-label",text:"全天"});const allDayItems=allDayHost.createDiv({cls:"lmd-db-calendar-day-all-day-items"});
        for(const file of allDay){const item=allDayItems.createDiv({cls:"lmd-db-calendar-item",attr:{draggable:"true"}});renderCalendarCard(item,file,false);wireCard(item,file);}
        const grid = dayView.createDiv({ cls:"lmd-db-calendar-time-grid" });
        const eventLayer=grid.createDiv({cls:"lmd-db-calendar-time-event-layer"});
        const timedLayout = timed.map((file)=>{ const r=parseDateRangeValue(this.app.metadataCache.getFileCache(file)?.frontmatter?.[dateField.id]); let startMinutes=0; if(key===r.startDate&&r.startTime){const [h,m]=r.startTime.split(":").map(Number);startMinutes=h*60+m;} let endMinutes=startMinutes+45; if(r.hasEnd){ if(r.endDate>key) endMinutes=1440; else if(r.endDate===key&&r.endTime){const [h,m]=r.endTime.split(":").map(Number);endMinutes=h*60+m;} } return {file,r,startMinutes,endMinutes:Math.max(endMinutes,startMinutes+20),column:0}; }).sort((a,b)=>a.startMinutes-b.startMinutes||a.endMinutes-b.endMinutes);
        const columnEnds=[];
        for(const ev of timedLayout){ let col=columnEnds.findIndex((end)=>end<=ev.startMinutes); if(col<0) col=columnEnds.length; ev.column=col; columnEnds[col]=ev.endMinutes; }
        const renderTimedCard = (item,file) => {
          renderCalendarCard(item,file,true);
          const frontmatter=this.app.metadataCache.getFileCache(file)?.frontmatter||{};
          const side=item.createDiv({cls:"lmd-db-calendar-time-event-side"});
          let hasSide=false;
          for(const field of calendarPreviewFields){ const value=frontmatter[field.id]; if(value===undefined||value===null||value===""||(Array.isArray(value)&&!value.length)) continue;
            if(field.type==="multi-select"){ hasSide=true; const host=side.createDiv({cls:"lmd-db-multiselect-chips"}); const values=Array.isArray(value)?value.map(String):[String(value)]; for(const chipValue of values) host.createSpan({cls:this.chipClassFor(field,chipValue),text:chipValue}); }
            else if(field.type==="relation"){ hasSide=true; const host=side.createDiv({cls:"lmd-db-relation-chips"}); const values=Array.isArray(value)?value:[value]; for(const raw of values){const target=stripWikiLink(raw);const resolved=this.resolveRelationFile(target,file.path);const label=resolved?.basename||pathBasenameNoExt(target);const chip=host.createEl("button",{cls:"lmd-db-relation-chip",text:label,attr:{type:"button"}});chip.draggable=false;chip.addEventListener("pointerdown",(event)=>event.stopPropagation());chip.addEventListener("click",(event)=>{event.preventDefault();event.stopPropagation();void this.app.workspace.openLinkText(resolved?stripMdExtension(resolved.path):target,file.path,false);});} }
            else if(field.type==="text"){ const text=formatProperty(value).trim(); if(!text) continue; hasSide=true; const btn=side.createEl("button",{cls:"lmd-db-calendar-time-text-preview",text:"…",attr:{type:"button","aria-label":field.name||field.id}}); btn.title=text; btn.addEventListener("pointerdown",(event)=>event.stopPropagation()); btn.addEventListener("click",(event)=>{event.preventDefault();event.stopPropagation(); document.querySelectorAll(".lmd-db-calendar-text-popover").forEach((el)=>el.remove()); const pop=document.body.createDiv({cls:"lmd-db-calendar-text-popover"}); pop.createDiv({cls:"lmd-db-calendar-text-popover-title",text:field.name||field.id}); const body=pop.createDiv({cls:"lmd-db-calendar-text-popover-body"}); void MarkdownRenderer.render(this.app,text,body,file.path,this); const r=btn.getBoundingClientRect(); const pw=Math.min(360,Math.max(220,pop.offsetWidth||280)); let left=r.left; if(left+pw>window.innerWidth-8) left=Math.max(8,window.innerWidth-pw-8); const ph=pop.offsetHeight||160; let top=r.bottom+6; if(top+ph>window.innerHeight-8) top=Math.max(8,r.top-ph-6); pop.style.left=`${Math.round(left)}px`; pop.style.top=`${Math.round(top)}px`; const close=(ev)=>{if(pop.contains(ev.target)||btn.contains(ev.target))return;pop.remove();document.removeEventListener("pointerdown",close,true);}; setTimeout(()=>document.addEventListener("pointerdown",close,true),0); }); }
          }
          if(!hasSide) side.remove(); else item.addClass("has-side-content");
        };
        const renderedTimed=[];
        for(const ev of timedLayout){const item=eventLayer.createDiv({cls:"lmd-db-calendar-time-event",attr:{draggable:"true"}});item.style.top=`${(ev.startMinutes/60)*54}px`;item.style.height=`${Math.max(32,((ev.endMinutes-ev.startMinutes)/60)*54)}px`;renderTimedCard(item,ev.file);wireCard(item,ev.file);renderedTimed.push({ev,item});}
        requestAnimationFrame(()=>{ const maxCol=Math.max(-1,...renderedTimed.map(({ev})=>ev.column)); const widths=Array(maxCol+1).fill(0); for(const {ev,item} of renderedTimed) widths[ev.column]=Math.max(widths[ev.column],Math.ceil(item.getBoundingClientRect().width)); const offsets=[]; let x=0; for(let i=0;i<widths.length;i++){offsets[i]=x;x+=Math.max(148,widths[i])+8;} for(const {ev,item} of renderedTimed)item.style.left=`${offsets[ev.column]||0}px`; });
        for (let hour=0; hour<24; hour++) {
          const row = grid.createDiv({ cls:"lmd-db-calendar-time-row" }); row.createDiv({ cls:"lmd-db-calendar-time-label", text:`${pad(hour)}:00` }); const lane = row.createDiv({ cls:"lmd-db-calendar-time-lane" }); lane.dataset.date=key;
          lane.addEventListener("dblclick",(event)=>{ if(event.target.closest(".lmd-db-calendar-item,.lmd-db-calendar-time-event,button,a,input,textarea")) return; event.preventDefault(); event.stopPropagation(); void this.createRow(source,dateField,`${key}T${pad(hour)}:00`); });
          lane.addEventListener("dragover",(event)=>{if(!event.dataTransfer.types.includes("text/lmd-calendar-file")&&!event.dataTransfer.types.includes("text/lmd-calendar-shadow"))return;event.preventDefault();lane.addClass("is-drop-target");});lane.addEventListener("dragleave",()=>lane.removeClass("is-drop-target"));lane.addEventListener("drop",async(event)=>{const shadowRaw=event.dataTransfer.getData("text/lmd-calendar-shadow");if(shadowRaw){event.preventDefault();event.stopPropagation();lane.removeClass("is-drop-target");let payload=null;try{payload=JSON.parse(shadowRaw);}catch(_){}if(payload)await writeShadowDateAndRefresh(payload,key,`${pad(hour)}:00`);return;}const path=event.dataTransfer.getData("text/lmd-calendar-file");if(!path)return;event.preventDefault();event.stopPropagation();lane.removeClass("is-drop-target");let dragPaths=[];try{dragPaths=JSON.parse(event.dataTransfer.getData("text/lmd-calendar-group")||"[]");}catch(_){}if(!Array.isArray(dragPaths)||!dragPaths.length)dragPaths=[path];await writeCalendarDateAndRefresh(dragPaths,key,`${pad(hour)}:00`);});
          for(const record of shadowByDate.get(key)||[]){const raw=this.app.metadataCache.getFileCache(record.file)?.frontmatter?.[record.source.dateField.id];if(Number((rawTimeKey(raw)||"00:00").slice(0,2))!==hour)continue;const item=lane.createDiv({cls:"lmd-db-calendar-item lmd-db-calendar-shadow-item",attr:{draggable:"true"}});renderShadowCard(item,record,false);wireShadowCard(item,record);}
        }
      }
    }

    if (undated.length) {
      const tray = this.contentEl.createDiv({ cls: "lmd-db-calendar-undated" }); tray.createDiv({ cls: "lmd-db-calendar-undated-head", text: `未排日期 · ${undated.length}` });
      const list = tray.createDiv({ cls: "lmd-db-calendar-undated-list" });
      for (const file of undated) { const item = list.createDiv({ cls: "lmd-db-calendar-undated-item", attr: { draggable: "true" } }); renderCalendarCard(item, file, true); wireCard(item, file); }
    }
    const shadowCount=shadowSources.reduce((sum,entry)=>sum+entry.files.length,0);
    this.contentEl.createDiv({ cls: "lmd-db-footer", text: `${files.length} / ${rawFiles.length} 筆主資料${shadowCount ? ` · ${shadowCount} 筆影子` : ""} · Calendar ${scaleLabels[scale]}視圖 · 使用「${dateField.name || dateField.id}」` });
  }

  async renderTimelineView(databaseFile, definition, activeViewEntry, view, source, rawFiles, schema, columns, files) {
    if (this.timelinePlaybackFrame) { try { cancelAnimationFrame(this.timelinePlaybackFrame); } catch (_) {} this.timelinePlaybackFrame = null; }
    const dateFields = schema.filter((field) => field?.type === "date" && field.id);
    let dateField = dateFields.find((field) => field.id === view.timelineDateField) || dateFields[0];
    if (!dateField) {
      const empty = this.contentEl.createDiv({ cls: "lmd-db-timeline-empty" });
      empty.createEl("h3", { text: "Timeline 需要日期欄位" });
      empty.createEl("p", { text: "先建立一個 Date property，再用它作為主資料庫的時間來源。" });
      return;
    }
    view.timelineDateField = dateField.id;
    const pad=(n)=>String(n).padStart(2,"0");
    const localKey=(d)=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const parseLocal=(value)=>{const d=new Date(String(value||""));return Number.isFinite(d.getTime())?d:null;};
    let rangeStart=parseLocal(view.timelineRangeStart), rangeEnd=parseLocal(view.timelineRangeEnd);
    if(!rangeStart||!rangeEnd||rangeEnd<=rangeStart){rangeStart=new Date();rangeStart.setMinutes(0,0,0);rangeEnd=new Date(rangeStart);rangeEnd.setHours(rangeEnd.getHours()+12);}
    const snap=[5,10,15,30,60].includes(Number(view.timelineSnapMinutes))?Number(view.timelineSnapMinutes):10;
    view.timelineSnapMinutes=snap;
    let pxPerMinute=Math.max(0.25,Math.min(16,Number(view.timelinePxPerMinute)||2));
    view.timelinePxPerMinute=pxPerMinute;
    let durationMinutes=Math.max(1,(rangeEnd-rangeStart)/60000);
    let contentWidth=Math.max(640,Math.ceil(durationMinutes*pxPerMinute));
    const snapMs=snap*60000;
    const snapDate=(d)=>new Date(rangeStart.getTime()+Math.round((d-rangeStart)/snapMs)*snapMs);
    const formatShort=(d)=>`${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const formatClock=(d)=>`${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const formatTimelineTick=(d)=>d.getHours()===0&&d.getMinutes()===0?`${d.getMonth()+1}/${d.getDate()} ${formatClock(d)}`:formatClock(d);
    const sameCalendarDay=(a,b)=>!!a&&!!b&&a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();

    const shadowSources=[];
    for(const configured of view.timelineShadowSources||[]){
      if(configured.enabled===false) continue;
      const db=this.app.vault.getAbstractFileByPath(normalizePath(configured.databasePath||""));
      if(!(db instanceof TFile)||db.extension!==DATABASE_EXTENSION) continue;
      const def=await this.plugin.readDatabaseDefinition(db); if(!def||def.source?.type!=="folder") continue;
      const sSchema=Array.isArray(def.schema)?def.schema:[];
      const sDate=sSchema.find((f)=>f?.type==="date"&&f.id===configured.dateField)||sSchema.find((f)=>f?.type==="date"); if(!sDate) continue;
      const folder=def.source.path?this.app.vault.getAbstractFileByPath(normalizePath(def.source.path)):this.app.vault.getRoot(); if(!(folder instanceof TFolder)) continue;
      shadowSources.push({databaseFile:db,definition:def,dateField:sDate,files:this.collectMarkdownFiles(folder),label:def.name||db.basename,isShadow:true});
    }
    const laneKey=(lane)=>normalizePath(lane.databaseFile?.path || lane.label || "");
    let lanes=[{databaseFile,definition,dateField,files,label:definition.name||databaseFile.basename,isShadow:false},...shadowSources];
    const availableLaneKeys=new Set(lanes.map(laneKey));
    const savedLaneOrder=(view.timelineLaneOrder||[]).filter((key)=>availableLaneKeys.has(key));
    const laneByKey=new Map(lanes.map((lane)=>[laneKey(lane),lane]));
    lanes=[...savedLaneOrder.map((key)=>laneByKey.get(key)).filter(Boolean),...lanes.filter((lane)=>!savedLaneOrder.includes(laneKey(lane)))];
    view.timelineLaneOrder=lanes.map(laneKey);

    // 0.13.11 — Horizontal Timeline uses an automatic data-driven range.
    // No manual start/end window is required: all events and pins are always included, with breathing room on both sides.
    const configuredPins=Array.isArray(view.timelinePins)?view.timelinePins.filter((pin)=>pin&&parseLocal(pin.time)):[];
    view.timelinePins=configuredPins;
    const extentTimes=[];
    let playbackStartAuto=null, playbackEndAuto=null;
    for(const lane of lanes){
      for(const file of lane.files){
        const raw=this.app.metadataCache.getFileCache(file)?.frontmatter?.[lane.dateField.id];
        const r=parseDateRangeValue(raw);
        const a=r?.startDate?new Date(`${r.startDate}T${r.startTime||"00:00"}`):null;
        const b=r?.hasEnd&&r.endDate?new Date(`${r.endDate}T${r.endTime||"00:00"}`):null;
        if(a&&Number.isFinite(a.getTime()))extentTimes.push(a);
        if(b&&Number.isFinite(b.getTime()))extentTimes.push(b);
      }
    }
    for(const pin of configuredPins){const d=parseLocal(pin.time);if(d)extentTimes.push(d);}
    const savedHead=parseLocal(view.timelinePlayhead);if(savedHead)extentTimes.push(savedHead);
    if(extentTimes.length){
      const minTime=new Date(Math.min(...extentTimes.map((d)=>d.getTime())));
      const maxTime=new Date(Math.max(...extentTimes.map((d)=>d.getTime())));
      playbackStartAuto=new Date(minTime);playbackEndAuto=new Date(maxTime);
      minTime.setMinutes(0,0,0); maxTime.setMinutes(0,0,0);
      rangeStart=new Date(minTime.getTime()-6*3600000);
      rangeEnd=new Date(maxTime.getTime()+12*3600000);
      if(rangeEnd-rangeStart<12*3600000)rangeEnd=new Date(rangeStart.getTime()+12*3600000);
    }else{
      const now=new Date();now.setMinutes(0,0,0);playbackStartAuto=new Date(now);playbackEndAuto=new Date(now.getTime()+12*3600000);
      rangeStart=new Date(now.getTime()-6*3600000);
      rangeEnd=new Date(now.getTime()+18*3600000);
    }
    durationMinutes=Math.max(1,(rangeEnd-rangeStart)/60000);
    contentWidth=Math.max(640,Math.ceil(durationMinutes*pxPerMinute));

    const toolbar=this.contentEl.createDiv({cls:"lmd-db-toolbar lmd-db-timeline-toolbar"});
    const tool=(icon,label,onClick)=>{const b=toolbar.createEl("button",{cls:"lmd-db-toolbar-button"});const i=b.createSpan({cls:"lmd-db-toolbar-icon"});setIcon(i,icon);b.createSpan({cls:"lmd-db-toolbar-label",text:label});b.addEventListener("click",onClick);return b;};
    const autoRangeButton=tool("expand",`自動範圍 · ${formatShort(rangeStart)} → ${formatShort(rangeEnd)}`,()=>new Notice("Timeline 目前會依事件與釘子自動延伸，不需要手動設定起訖。"));
    autoRangeButton.addClass("lmd-db-timeline-auto-range");
    tool("magnet",`磁吸 ${snap} 分`,(event)=>{const menu=new Menu();for(const n of [5,10,15,30,60])menu.addItem((item)=>item.setTitle(`${n} 分鐘`).setChecked(n===snap).onClick(async()=>{view.timelineSnapMinutes=n;await this.saveDefinition(databaseFile,definition);await this.loadAndRender(databaseFile);}));menu.showAtMouseEvent(event);});
    tool("calendar-clock",dateField.name||dateField.id,(event)=>{const menu=new Menu();for(const field of dateFields)menu.addItem((item)=>item.setTitle(field.name||field.id).setChecked(field.id===dateField.id).onClick(async()=>{view.timelineDateField=field.id;await this.saveDefinition(databaseFile,definition);await this.loadAndRender(databaseFile);}));menu.showAtMouseEvent(event);});
    tool("layers",`影子${shadowSources.length?` · ${shadowSources.length}`:""}`,()=>new CalendarShadowSourcesModal(this.app,this.plugin,databaseFile.path,view.timelineShadowSources||[],async(sources)=>{view.timelineShadowSources=sources;await this.saveDefinition(databaseFile,definition);await this.loadAndRender(databaseFile);}).open());
    const pinSource=tool("pin","",()=>new Notice("把釘子拖到 Timeline 上方時間尺或任一 Lane，即可固定時間點。"));
    pinSource.setAttribute("title","拖曳釘子");pinSource.setAttribute("aria-label","拖曳釘子");pinSource.querySelector(".lmd-db-toolbar-label")?.remove();
    pinSource.draggable=false;pinSource.addClass("lmd-db-timeline-pin-source");
    const pinLibraryButton=tool("list-ordered",`釘子庫 · ${configuredPins.length}`,()=>new TimelinePinLibraryModal(this.app,view.timelinePins||[],async(pins)=>{rememberTimelineViewport();view.timelinePins=pins.map((pin,index)=>({...pin,order:index}));await this.saveDefinition(databaseFile,definition);await this.loadAndRender(databaseFile);},(pin)=>{const time=parseLocal(pin?.time);if(!time)return;const x=timeToX(time);scroll.scrollLeft=Math.max(0,x-scroll.clientWidth*0.5);}).open());
    let interactionMode=view.timelineInteractionMode==="static"?"static":"playback";
    let toggleTimelineInteractionMode=()=>{};
    const modeButton=tool(interactionMode==="static"?"image":"clapperboard",interactionMode==="static"?"靜態":"播放模式",()=>toggleTimelineInteractionMode());
    modeButton.addClass("lmd-db-timeline-mode-button");
    let resetTimelinePlayhead=()=>{};
    const resetButton=tool("skip-back","回起點",()=>resetTimelinePlayhead());
    resetButton.addClass("lmd-db-timeline-playback-only");
    let jumpToTimelinePlayhead=()=>{};
    const locatePlayheadButton=tool("locate-fixed","找播放頭",()=>jumpToTimelinePlayhead());
    locatePlayheadButton.addClass("lmd-db-timeline-playback-only");
    let toggleTimelinePlayback=()=>{};
    const playButton=tool("play","播放",()=>toggleTimelinePlayback());
    playButton.addClass("lmd-db-timeline-playback-only");
    if(interactionMode!=="playback"){resetButton.addClass("is-hidden");locatePlayheadButton.addClass("is-hidden");playButton.addClass("is-hidden");}

    const shell=this.contentEl.createDiv({cls:`lmd-db-timeline-rebuild is-${interactionMode}`});
    const sideWidth=Math.max(180,Math.min(640,Number(view.timelineSidePanelWidth)||250));
    const sideHeight=Math.max(180,Math.min(900,Number(view.timelineSidePanelHeight)||Math.max(260,Math.min(560,44+lanes.length*64))));
    shell.style.setProperty("--lmd-timeline-side-width",`${sideWidth}px`);
    shell.style.setProperty("--lmd-timeline-side-height",`${sideHeight}px`);
    this.installCtrlWheelZoom(shell,databaseFile,definition,view);
    const laneNames=shell.createDiv({cls:"lmd-db-timeline-lane-names"});
    laneNames.createDiv({cls:"lmd-db-timeline-lane-corner",text:"來源"});
    const scroll=shell.createDiv({cls:"lmd-db-timeline-scroll"});
    const canvas=scroll.createDiv({cls:"lmd-db-timeline-canvas"}); canvas.style.width=`${contentWidth}px`; canvas.style.setProperty("--lmd-timeline-snap-px",`${snap*pxPerMinute}px`); canvas.style.setProperty("--lmd-timeline-hour-px",`${60*pxPerMinute}px`);
    // 0.13.5 — shared Log / Inspector side panel.
    const sidePanel=shell.createDiv({cls:`lmd-db-timeline-log lmd-db-timeline-side-panel${interactionMode==="playback"?"":" is-hidden"}`});
    const sideResizer=sidePanel.createDiv({cls:"lmd-db-timeline-side-resizer",attr:{title:"拖曳調整 Log / Inspector 寬度"}});
    let sideResize=null;
    sideResizer.addEventListener("pointerdown",(event)=>{if(!isLmdPrimaryPointer(event))return;event.preventDefault();sideResizer.setPointerCapture?.(event.pointerId);sideResize={id:event.pointerId,startX:event.clientX,startWidth:sidePanel.getBoundingClientRect().width};sidePanel.addClass("is-resizing");});
    sideResizer.addEventListener("pointermove",(event)=>{if(!sideResize||sideResize.id!==event.pointerId)return;const next=Math.max(180,Math.min(640,sideResize.startWidth-(event.clientX-sideResize.startX)));shell.style.setProperty("--lmd-timeline-side-width",`${Math.round(next)}px`);view.timelineSidePanelWidth=Math.round(next);});
    const endSideResize=(event)=>{if(!sideResize||sideResize.id!==event.pointerId)return;sideResize=null;sidePanel.removeClass("is-resizing");void this.saveDefinition(databaseFile,definition);};
    sideResizer.addEventListener("pointerup",endSideResize);sideResizer.addEventListener("pointercancel",endSideResize);
    const sideHeightResizer=sidePanel.createDiv({cls:"lmd-db-timeline-side-height-resizer",attr:{title:"拖曳調整 Log / Inspector 高度"}});
    let sideHeightResize=null;
    sideHeightResizer.addEventListener("pointerdown",(event)=>{if(!isLmdPrimaryPointer(event))return;event.preventDefault();event.stopPropagation();sideHeightResizer.setPointerCapture?.(event.pointerId);sideHeightResize={id:event.pointerId,startY:event.clientY,startHeight:sidePanel.getBoundingClientRect().height};sidePanel.addClass("is-height-resizing");});
    sideHeightResizer.addEventListener("pointermove",(event)=>{if(!sideHeightResize||sideHeightResize.id!==event.pointerId)return;const next=Math.max(180,Math.min(900,sideHeightResize.startHeight+(event.clientY-sideHeightResize.startY)));shell.style.setProperty("--lmd-timeline-side-height",`${Math.round(next)}px`);view.timelineSidePanelHeight=Math.round(next);});
    const endSideHeightResize=(event)=>{if(!sideHeightResize||sideHeightResize.id!==event.pointerId)return;sideHeightResize=null;sidePanel.removeClass("is-height-resizing");void this.saveDefinition(databaseFile,definition);};
    sideHeightResizer.addEventListener("pointerup",endSideHeightResize);sideHeightResizer.addEventListener("pointercancel",endSideHeightResize);
    const sideHead=sidePanel.createDiv({cls:"lmd-db-timeline-log-head lmd-db-timeline-side-head"});
    const sideTabs=sideHead.createDiv({cls:"lmd-db-timeline-side-tabs"});
    const logTab=sideTabs.createEl("button",{cls:"lmd-db-timeline-side-tab",text:"Log",attr:{type:"button"}});
    const inspectorTab=sideTabs.createEl("button",{cls:"lmd-db-timeline-side-tab",text:"Inspector",attr:{type:"button"}});
    let exportTimelineLog=()=>{};
    let printTimelineLog=()=>{};
    const logExport=sideHead.createEl("button",{cls:"lmd-db-timeline-log-clear lmd-db-timeline-log-export",attr:{title:"匯出 Log 為 Markdown","aria-label":"匯出 Log 為 Markdown"}}); setIcon(logExport,"download");
    const logPrint=sideHead.createEl("button",{cls:"lmd-db-timeline-log-clear lmd-db-timeline-log-print",attr:{title:"印出目前範圍到 Log","aria-label":"印出目前範圍到 Log"}}); setIcon(logPrint,"list-plus");
    const logClear=sideHead.createEl("button",{cls:"lmd-db-timeline-log-clear",attr:{title:"清除 Log","aria-label":"清除 Log"}}); setIcon(logClear,"trash-2");
    const logList=sidePanel.createDiv({cls:"lmd-db-timeline-log-list"});
    const timelineLogEntries=[];
    logExport.addEventListener("click",()=>void exportTimelineLog());
    logPrint.addEventListener("click",()=>printTimelineLog());
    logList.createDiv({cls:"lmd-db-timeline-log-empty",text:"拖曳播放頭、按下播放，或直接印出目前範圍。"});
    const inspectorList=sidePanel.createDiv({cls:"lmd-db-timeline-inspector-list"});
    const syncSidePanelMode=()=>{
      const mode=view.timelineSidePanelMode==="inspector"?"inspector":"log";
      logTab.toggleClass("is-active",mode==="log"); inspectorTab.toggleClass("is-active",mode==="inspector");
      logList.toggleClass("is-hidden",mode!=="log"); inspectorList.toggleClass("is-hidden",mode!=="inspector");
      logExport.toggleClass("is-hidden",mode!=="log"); logPrint.toggleClass("is-hidden",mode!=="log"); logClear.toggleClass("is-hidden",mode!=="log");
    };
    const setSidePanelMode=async(mode)=>{view.timelineSidePanelMode=mode;syncSidePanelMode();await this.saveDefinition(databaseFile,definition);};
    logTab.addEventListener("click",()=>void setSidePanelMode("log"));
    inspectorTab.addEventListener("click",()=>void setSidePanelMode("inspector"));
    logClear.addEventListener("click",()=>{timelineLogEntries.length=0;logList.empty();logList.createDiv({cls:"lmd-db-timeline-log-empty",text:"Log 已清除。"});});
    syncSidePanelMode();
    // 0.13.14 — one canonical time/X coordinate system.
    // Snap defines the ruler/grid cadence. Alt zoom changes only pixel density.
    const timeToX=(time)=>((time.getTime()-rangeStart.getTime())/60000)*pxPerMinute;
    const xToTime=(x)=>new Date(rangeStart.getTime()+(x/pxPerMinute)*60000);
    // 0.13.17 — the visible grid is no longer a repeating CSS background.
    // Every vertical grid line is rendered from the exact same snapped Date -> timeToX()
    // coordinate as the ruler tick. This avoids cumulative/sub-pixel drift on long ranges.
    const gridLayer=canvas.createDiv({cls:"lmd-db-timeline-grid-lines"});
    const ruler=canvas.createDiv({cls:"lmd-db-timeline-ruler"});
    const dayBands=ruler.createDiv({cls:"lmd-db-timeline-day-bands"});
    const rulerTicks=[];
    const gridLines=[];
    const dayBandItems=[];
    const renderDayBands=()=>{
      for(const item of dayBandItems)item.remove(); dayBandItems.length=0;
      let d=new Date(rangeStart);d.setHours(0,0,0,0);
      let dayIndex=0;
      for(let guard=0;d<rangeEnd&&guard<4000;guard++,dayIndex++){
        const next=new Date(d);next.setDate(next.getDate()+1);
        const visibleStart=d<rangeStart?rangeStart:d,visibleEnd=next>rangeEnd?rangeEnd:next;
        const band=dayBands.createDiv({cls:`lmd-db-timeline-day-band${dayIndex%2?" is-alt":""}`});
        band.style.left=`${timeToX(visibleStart)}px`;
        band.style.width=`${Math.max(0,timeToX(visibleEnd)-timeToX(visibleStart))}px`;
        band.dataset.day=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
        dayBandItems.push(band);d=next;
      }
    };
    const renderRulerTicks=()=>{
      for(const item of rulerTicks)item.tick.remove(); rulerTicks.length=0;
      for(const line of gridLines)line.remove(); gridLines.length=0;
      const stepMinutes=snap;
      const stepMs=stepMinutes*60000;
      const localAnchor=new Date(2000,0,1,0,0,0,0).getTime();
      let firstMs=localAnchor+Math.ceil((rangeStart.getTime()-localAnchor)/stepMs)*stepMs;
      for(let t=firstMs,guard=0;t<=rangeEnd.getTime()&&guard<30000;t+=stepMs,guard++){
        const tickTime=new Date(t);
        const isDayStart=tickTime.getHours()===0&&tickTime.getMinutes()===0;
        const x=timeToX(tickTime);
        const line=gridLayer.createDiv({cls:`lmd-db-timeline-grid-line${isDayStart?" is-day-start":""}`});
        line.style.left=`${x}px`;
        gridLines.push(line);
        const tick=ruler.createDiv({cls:`lmd-db-timeline-ruler-hour${isDayStart?" is-day-start":""}`});
        tick.style.left=`${x}px`;
        tick.createSpan({cls:"lmd-db-timeline-ruler-time",text:formatClock(tickTime)});
        tick.createSpan({cls:"lmd-db-timeline-ruler-date",text:isDayStart?`${tickTime.getMonth()+1}/${tickTime.getDate()}`:""});
        rulerTicks.push({tick,time:tickTime});
      }
      renderDayBands();
    };
    renderRulerTicks();
    const clearNative=()=>{try{window.getSelection()?.removeAllRanges();}catch(_){}};
    const eventRange=(file,field)=>parseDateRangeValue(this.app.metadataCache.getFileCache(file)?.frontmatter?.[field.id]);
    const dateFromRange=(r,startSide=true)=>{const date=startSide?r.startDate:r.endDate;const time=startSide?r.startTime:r.endTime;if(!date)return null;return new Date(`${date}T${time||"00:00"}`);};
    const saveMoved=async(lane,file,newStart)=>{
      const raw=this.app.metadataCache.getFileCache(file)?.frontmatter?.[lane.dateField.id]; const r=parseDateRangeValue(raw); const oldStart=dateFromRange(r,true); if(!oldStart)return;
      const delta=newStart-oldStart; const hasTime=!!r.startTime; r.startDate=`${newStart.getFullYear()}-${pad(newStart.getMonth()+1)}-${pad(newStart.getDate())}`; if(hasTime)r.startTime=`${pad(newStart.getHours())}:${pad(newStart.getMinutes())}`;
      if(r.hasEnd&&r.endDate){const oldEnd=dateFromRange(r,false)||oldStart;const newEnd=new Date(oldEnd.getTime()+delta);r.endDate=`${newEnd.getFullYear()}-${pad(newEnd.getMonth()+1)}-${pad(newEnd.getDate())}`;if(r.endTime)r.endTime=`${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}`;}
      rememberTimelineViewport();await this.writeProperty(file,lane.dateField,formatDateRangeValue(r)); await this.waitForMetadataRefresh(file,1200); await this.loadAndRender(databaseFile);
    };
    const saveResized=async(lane,file,newStart,newEnd)=>{
      const raw=this.app.metadataCache.getFileCache(file)?.frontmatter?.[lane.dateField.id];
      const r=parseDateRangeValue(raw);
      if(!r?.startDate)return;
      const minMs=Math.max(1,snap)*60000;
      if(newEnd.getTime()-newStart.getTime()<minMs)newEnd=new Date(newStart.getTime()+minMs);
      r.startDate=`${newStart.getFullYear()}-${pad(newStart.getMonth()+1)}-${pad(newStart.getDate())}`;
      r.startTime=`${pad(newStart.getHours())}:${pad(newStart.getMinutes())}`;
      r.hasEnd=true;
      r.endDate=`${newEnd.getFullYear()}-${pad(newEnd.getMonth()+1)}-${pad(newEnd.getDate())}`;
      r.endTime=`${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}`;
      rememberTimelineViewport();await this.writeProperty(file,lane.dateField,formatDateRangeValue(r));
      await this.waitForMetadataRefresh(file,1200);
      await this.loadAndRender(databaseFile);
    };

    document.querySelectorAll(".lmd-db-timeline-hover").forEach((el)=>el.remove());
    let timelineHover=null;
    const closeTimelineHover=()=>{ if(timelineHover){ timelineHover.remove(); timelineHover=null; } document.querySelectorAll(".lmd-db-timeline-hover").forEach((el)=>el.remove()); };
    scroll.addEventListener("scroll",closeTimelineHover,{passive:true});
    scroll.addEventListener("pointerdown",closeTimelineHover,true);
    window.addEventListener("blur",closeTimelineHover,{once:true});
    const showTimelineHover=(bar,file,lane,start,end)=>{
      closeTimelineHover();
      const rect=bar.getBoundingClientRect();
      const pop=document.body.createDiv({cls:"lmd-db-timeline-hover"});
      timelineHover=pop;
      pop.createDiv({cls:"lmd-db-timeline-hover-title",text:file.basename});
      pop.createDiv({cls:"lmd-db-timeline-hover-time",text:end?`${formatShort(start)} → ${formatShort(end)}`:`◆ ${formatShort(start)} · 瞬間事件`});
      pop.createDiv({cls:"lmd-db-timeline-hover-source",text:`來源：${lane.label}${lane.isShadow?" · 影子":""}`});
      const place=()=>{
        if(!timelineHover||!document.body.contains(pop))return;
        const pr=pop.getBoundingClientRect();
        let left=Math.min(window.innerWidth-pr.width-8,Math.max(8,rect.left+Math.min(rect.width/2,120)));
        let top=rect.bottom+8;
        if(top+pr.height>window.innerHeight-8)top=Math.max(8,rect.top-pr.height-8);
        pop.style.left=`${left}px`;pop.style.top=`${top}px`;
      };
      requestAnimationFrame(place);
    };

    const timelineEvents=[];
    // 0.13.16 — viewport/client coordinates are *visual* pixels, while scrollLeft,
    // canvas left/width and pxPerMinute live in the Timeline's unzoomed layout pixels.
    // Obsidian UI zoom is implemented with CSS `zoom`, so every pointer delta must be
    // divided by that UI zoom before it enters the canonical Timeline coordinate system.
    // Alt Timeline zoom is already represented by pxPerMinute and must NOT be applied here again.
    const timelineUiZoom=()=>Math.max(0.5,Math.min(1.6,Number(view.zoom)||1));
    const viewportPxToTimelinePx=(px)=>px/timelineUiZoom();
    const timelineContentXFromClientX=(clientX)=>{
      const rect=canvas.getBoundingClientRect();
      return Math.max(0,viewportPxToTimelinePx(clientX-rect.left));
    };
    const timelineTimeFromClientX=(clientX)=>snapDate(xToTime(timelineContentXFromClientX(clientX)));
    const rememberTimelineViewport=()=>{this.timelineRestoreTime=xToTime(scroll.scrollLeft);};
    const reloadTimelinePreserve=async()=>{rememberTimelineViewport();await this.loadAndRender(databaseFile);};
    const makeDateRangeValue=(start,isInstant)=>{
      const r={startDate:`${start.getFullYear()}-${pad(start.getMonth()+1)}-${pad(start.getDate())}`,startTime:`${pad(start.getHours())}:${pad(start.getMinutes())}`,hasTime:true,hasEnd:!isInstant,endDate:"",endTime:""};
      if(!isInstant){const end=new Date(start.getTime()+60*60000);r.endDate=`${end.getFullYear()}-${pad(end.getMonth()+1)}-${pad(end.getDate())}`;r.endTime=`${pad(end.getHours())}:${pad(end.getMinutes())}`;}
      return formatDateRangeValue(r);
    };
    const createTimelineNote=async(lane,time,isInstant)=>{
      const sourceDef=lane.definition?.source;
      if(sourceDef?.type!=="folder"){new Notice("這個來源目前不能直接建立 Markdown。");return;}
      const folder=sourceDef.path?this.app.vault.getAbstractFileByPath(normalizePath(sourceDef.path)):this.app.vault.getRoot();
      if(!(folder instanceof TFolder)){new Notice("找不到這個 Database 的來源資料夾。");return;}
      let index=1,name="Untitled",path=normalizePath(folder.path?`${folder.path}/${name}.md`:`${name}.md`);
      while(this.app.vault.getAbstractFileByPath(path)){index+=1;name=`Untitled ${index}`;path=normalizePath(folder.path?`${folder.path}/${name}.md`:`${name}.md`);}
      try{
        const file=await this.app.vault.create(path,"");
        await this.app.fileManager.processFrontMatter(file,(fm)=>{fm[lane.dateField.id]=makeDateRangeValue(time,isInstant);});
        new Notice(`已建立${isInstant?"瞬間":"持續"}事件：${file.basename}`);
        await this.waitForMetadataRefresh(file,1200);await reloadTimelinePreserve();
      }catch(error){console.error("[Local Markdown Database] create timeline note failed",error);new Notice("建立 Timeline 筆記失敗。");}
    };
    const deleteTimelineNote=async(file)=>{
      try{rememberTimelineViewport();await this.app.fileManager.trashFile(file);if(view.timelineBarColors)delete view.timelineBarColors[file.path];new Notice(`已刪除：${file.basename}`);await this.saveDefinition(databaseFile,definition);await this.loadAndRender(databaseFile);}
      catch(error){console.error("[Local Markdown Database] delete timeline note failed",error);new Notice("刪除筆記失敗。");}
    };
    const applyLaneOrderAndSave=async()=>{
      view.timelineLaneOrder=lanes.map(laneKey);
      await this.saveDefinition(databaseFile,definition);
      await this.loadAndRender(databaseFile);
    };
    lanes.forEach((lane,laneIndex)=>{
      const key=laneKey(lane);
      const laneColor=normalizeOptionColor(view.timelineLaneColors?.[key]);
      const colorClass=laneColor!=="default"&&laneColor!=="transparent"?` is-color-${laneColor}`:"";
      const name=laneNames.createDiv({cls:`lmd-db-timeline-lane-name${lane.isShadow?" is-shadow":""}${colorClass}`});
      name.dataset.laneKey=key; name.draggable=true;
      const titleRow=name.createDiv({cls:"lmd-db-timeline-lane-name-main"});
      const dragHandle=titleRow.createSpan({cls:"lmd-db-timeline-lane-drag",attr:{title:"拖曳交換 Lane 順序","aria-label":"拖曳交換 Lane 順序"}}); setIcon(dragHandle,"grip-vertical");
      titleRow.createSpan({cls:"lmd-db-timeline-lane-name-title",text:lane.label});
      const colorButton=titleRow.createEl("button",{cls:`lmd-db-timeline-lane-color${colorClass}`,attr:{title:"Lane 顏色","aria-label":"Lane 顏色"}}); setIcon(colorButton,"palette");
      colorButton.addEventListener("pointerdown",(event)=>event.stopPropagation());
      colorButton.addEventListener("click",(event)=>{event.preventDefault();event.stopPropagation();new DatabaseColorModal(this.app,{scope:"timeline-lane"},async({color})=>{if(!view.timelineLaneColors||typeof view.timelineLaneColors!=="object")view.timelineLaneColors={};const next=normalizeOptionColor(color);if(next==="default"||next==="transparent")delete view.timelineLaneColors[key];else view.timelineLaneColors[key]=next;await this.saveDefinition(databaseFile,definition);await this.loadAndRender(databaseFile);}).open();});
      if(lane.isShadow) name.createSpan({cls:"lmd-db-timeline-lane-name-shadow",text:"影子"});
      name.addEventListener("dragstart",(event)=>{event.dataTransfer?.setData("text/plain",key);event.dataTransfer.effectAllowed="move";name.addClass("is-dragging");});
      name.addEventListener("dragend",()=>{name.removeClass("is-dragging");laneNames.querySelectorAll(".lmd-db-timeline-lane-name").forEach((el)=>el.removeClass("is-drop-before","is-drop-after"));});
      name.addEventListener("dragover",(event)=>{event.preventDefault();const rect=name.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;name.toggleClass("is-drop-after",after);name.toggleClass("is-drop-before",!after);if(event.dataTransfer)event.dataTransfer.dropEffect="move";});
      name.addEventListener("dragleave",()=>name.removeClass("is-drop-before","is-drop-after"));
      name.addEventListener("drop",(event)=>{event.preventDefault();event.stopPropagation();const sourceKey=event.dataTransfer?.getData("text/plain");name.removeClass("is-drop-before","is-drop-after");if(!sourceKey||sourceKey===key)return;const from=lanes.findIndex((item)=>laneKey(item)===sourceKey);const target=lanes.findIndex((item)=>laneKey(item)===key);if(from<0||target<0)return;const rect=name.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;const [moved]=lanes.splice(from,1);let insert=lanes.findIndex((item)=>laneKey(item)===key);if(after)insert+=1;lanes.splice(Math.max(0,insert),0,moved);void applyLaneOrderAndSave();});
      const track=canvas.createDiv({cls:`lmd-db-timeline-track${lane.isShadow?" is-shadow":""}${colorClass}`}); track.style.top=`${44+laneIndex*64}px`; track.dataset.lane=lane.label;
      track.addEventListener("contextmenu",(event)=>{
        if(event.target.closest?.(".lmd-db-timeline-bar"))return;
        event.preventDefault();event.stopPropagation();closeTimelineHover();
        const at=timelineTimeFromClientX(event.clientX);
        const menu=new Menu();
        menu.addItem((item)=>item.setTitle(`新增 ◆ 瞬間事件 · ${formatShort(at)}`).setIcon("diamond").onClick(()=>void createTimelineNote(lane,at,true)));
        menu.addItem((item)=>item.setTitle(`新增持續事件 · ${formatShort(at)}`).setIcon("minus").onClick(()=>void createTimelineNote(lane,at,false)));
        menu.showAtMouseEvent(event);
      });
      for(const file of lane.files){
        const r=eventRange(file,lane.dateField); const start=dateFromRange(r,true); if(!start)continue;
        const parsedEnd=dateFromRange(r,false); const isInstant=!(r?.hasEnd&&parsedEnd&&parsedEnd>start); const end=isInstant?new Date(start):parsedEnd;
        if((isInstant&& (start<rangeStart||start>rangeEnd))||(!isInstant&&(end<rangeStart||start>rangeEnd)))continue;
        const visibleStart=isInstant?start:(start<rangeStart?rangeStart:start), visibleEnd=isInstant?start:(end>rangeEnd?rangeEnd:end);
        const x=((visibleStart-rangeStart)/60000)*pxPerMinute, w=isInstant?18:Math.max(14,((visibleEnd-visibleStart)/60000)*pxPerMinute);
        const barOverride=normalizeOptionColor(view.timelineBarColors?.[file.path]);
        const barColorClass=barOverride!=="default"&&barOverride!=="transparent"?` is-color-${barOverride}`:"";
        const bar=track.createDiv({cls:`lmd-db-timeline-bar${isInstant?" is-instant":""}${lane.isShadow?" is-shadow":""}${barColorClass}`});bar.style.left=`${x}px`;bar.style.width=`${w}px`;bar.dataset.path=file.path;
        timelineEvents.push({file,lane,start,end,bar,isInstant});
        const leftHandle=bar.createSpan({cls:"lmd-db-timeline-resize is-left",attr:{title:"拖曳調整開始時間","aria-label":"拖曳調整開始時間"}});
        if(isInstant)leftHandle.addClass("is-hidden");
        if(isInstant)bar.createSpan({cls:"lmd-db-timeline-point-glyph",text:"◆"});
        const title=bar.createSpan({cls:"lmd-db-timeline-bar-title",text:file.basename});
        const rightHandle=isInstant?null:bar.createSpan({cls:"lmd-db-timeline-resize is-right",attr:{title:"拖曳調整結束時間","aria-label":"拖曳調整結束時間"}});
        bar.addEventListener("mouseenter",()=>showTimelineHover(bar,file,lane,start,isInstant?null:end));
        bar.addEventListener("mouseleave",closeTimelineHover);
        bar.addEventListener("dblclick",()=>void this.openDatabaseItem(file,databaseFile));
        bar.addEventListener("contextmenu",(event)=>{
          event.preventDefault();event.stopPropagation();closeTimelineHover();
          const menu=new Menu();
          menu.addItem((item)=>item.setTitle("單獨設定條目顏色").setIcon("palette").onClick(()=>new DatabaseColorModal(this.app,{scope:"timeline-bar"},async({color})=>{
            if(!view.timelineBarColors||typeof view.timelineBarColors!=="object")view.timelineBarColors={};
            const next=normalizeOptionColor(color);
            if(next==="default"||next==="transparent")delete view.timelineBarColors[file.path];else view.timelineBarColors[file.path]=next;
            await this.saveDefinition(databaseFile,definition);await this.loadAndRender(databaseFile);
          }).open()));
          if(view.timelineBarColors?.[file.path])menu.addItem((item)=>item.setTitle("恢復 Lane 顏色").setIcon("rotate-ccw").onClick(async()=>{delete view.timelineBarColors[file.path];await this.saveDefinition(databaseFile,definition);await this.loadAndRender(databaseFile);}));
          menu.addSeparator();
          menu.addItem((item)=>item.setTitle("刪除筆記").setIcon("trash-2").onClick(()=>void deleteTimelineNote(file)));
          menu.showAtMouseEvent(event);
        });
        let drag=null;
        const beginInteraction=(event,mode)=>{
          if(!isLmdPrimaryPointer(event))return;
          event.preventDefault();event.stopPropagation();closeTimelineHover();clearNative();
          bar.setPointerCapture?.(event.pointerId);
          drag={pointerId:event.pointerId,startX:event.clientX,originalStart:start,originalEnd:end,deltaX:0,mode};
          bar.addClass(mode==="move"?"is-dragging":"is-resizing");
          bar.toggleClass("is-resize-left",mode==="resize-left");bar.toggleClass("is-resize-right",mode==="resize-right");
          document.body.addClass("lmd-db-is-timeline-dragging");
        };
        leftHandle.addEventListener("pointerdown",(event)=>{if(isInstant)return;beginInteraction(event,"resize-left");});
        rightHandle?.addEventListener("pointerdown",(event)=>beginInteraction(event,"resize-right"));
        bar.addEventListener("pointerdown",(event)=>{if(event.target===leftHandle||event.target===rightHandle)return;beginInteraction(event,"move");});
        bar.addEventListener("pointermove",(event)=>{
          if(!drag||event.pointerId!==drag.pointerId)return;
          drag.deltaX=viewportPxToTimelinePx(event.clientX-drag.startX);
          const mins=drag.deltaX/pxPerMinute;
          if(drag.mode==="move"){
            const snapped=snapDate(new Date(drag.originalStart.getTime()+mins*60000));
            const newX=((snapped-rangeStart)/60000)*pxPerMinute;
            const baseVisibleStart=drag.originalStart<rangeStart?rangeStart:drag.originalStart;
            const baseX=((baseVisibleStart-rangeStart)/60000)*pxPerMinute;
            bar.style.transform=`translateX(${newX-baseX}px)`;
            return;
          }
          if(drag.mode==="resize-left"){
            let next=snapDate(new Date(drag.originalStart.getTime()+mins*60000));
            const latest=new Date(drag.originalEnd.getTime()-snapMs);if(next>latest)next=latest;
            const vx=Math.max(rangeStart.getTime(),next.getTime());
            const ve=Math.min(rangeEnd.getTime(),drag.originalEnd.getTime());
            bar.style.left=`${((vx-rangeStart.getTime())/60000)*pxPerMinute}px`;
            bar.style.width=`${Math.max(14,((ve-vx)/60000)*pxPerMinute)}px`;
            drag.previewStart=next;drag.previewEnd=drag.originalEnd;
            return;
          }
          let next=snapDate(new Date(drag.originalEnd.getTime()+mins*60000));
          const earliest=new Date(drag.originalStart.getTime()+snapMs);if(next<earliest)next=earliest;
          const vs=Math.max(rangeStart.getTime(),drag.originalStart.getTime());
          const ve=Math.min(rangeEnd.getTime(),next.getTime());
          bar.style.width=`${Math.max(14,((ve-vs)/60000)*pxPerMinute)}px`;
          drag.previewStart=drag.originalStart;drag.previewEnd=next;
        });
        const finish=async(event)=>{
          if(!drag||event.pointerId!==drag.pointerId)return;
          const info=drag;drag=null;
          bar.removeClass("is-dragging","is-resizing","is-resize-left","is-resize-right");document.body.removeClass("lmd-db-is-timeline-dragging");bar.style.transform="";
          const resetVisibleStart=info.originalStart<rangeStart?rangeStart:info.originalStart,resetVisibleEnd=info.originalEnd>rangeEnd?rangeEnd:info.originalEnd;
          bar.style.left=`${((resetVisibleStart-rangeStart)/60000)*pxPerMinute}px`;bar.style.width=`${isInstant?18:Math.max(14,((resetVisibleEnd-resetVisibleStart)/60000)*pxPerMinute)}px`;clearNative();
          if(info.mode==="move"){const mins=info.deltaX/pxPerMinute;const next=snapDate(new Date(info.originalStart.getTime()+mins*60000));if(next.getTime()!==info.originalStart.getTime())await saveMoved(lane,file,next);return;}
          const nextStart=info.previewStart||info.originalStart,nextEnd=info.previewEnd||info.originalEnd;
          if(nextStart.getTime()!==info.originalStart.getTime()||nextEnd.getTime()!==info.originalEnd.getTime())await saveResized(lane,file,nextStart,nextEnd);
        };
        bar.addEventListener("pointerup",(e)=>void finish(e));bar.addEventListener("pointercancel",(e)=>void finish(e));
      }
    });
    canvas.style.height=`${44+lanes.length*64}px`; laneNames.style.paddingTop="44px";

    // 0.13.13 — persistent pins: scroll-safe coordinates, jump-to-time, icon-only display and drop guide.
    const savePins=async()=>{view.timelinePins=(view.timelinePins||[]).map((pin,index)=>({...pin,order:index}));await this.saveDefinition(databaseFile,definition);};
    const renamePin=(pin)=>new TimelinePinLibraryModal(this.app,[pin],async(items)=>{const updated=items[0];if(!updated)return;const target=(view.timelinePins||[]).find((item)=>item.id===pin.id);if(target){rememberTimelineViewport();target.name=updated.name||"";await savePins();await this.loadAndRender(databaseFile);}}).open();
    const jumpToPin=(pin)=>{const time=parseLocal(pin?.time);if(!time)return;const x=timeToX(time);scroll.scrollLeft=Math.max(0,x-scroll.clientWidth*0.5);};
    const renderPin=(pin)=>{
      const time=parseLocal(pin.time);if(!time)return;const x=timeToX(time);
      const el=canvas.createDiv({cls:"lmd-db-timeline-pin"});el.style.left=`${x}px`;el.dataset.pinId=pin.id;
      const head=el.createDiv({cls:"lmd-db-timeline-pin-head",attr:{title:`${pin.name||formatShort(time)} · ${formatShort(time)} · 點擊定位`}});setIcon(head,"pin");
      head.addEventListener("click",(event)=>{event.preventDefault();event.stopPropagation();jumpToPin(pin);});
      el.addEventListener("contextmenu",(event)=>{event.preventDefault();event.stopPropagation();const menu=new Menu();menu.addItem((item)=>item.setTitle("跳到此時間").setIcon("locate-fixed").onClick(()=>jumpToPin(pin)));menu.addItem((item)=>item.setTitle("重新命名").setIcon("pencil").onClick(()=>renamePin(pin)));menu.addItem((item)=>item.setTitle("刪除釘子").setIcon("trash-2").onClick(async()=>{rememberTimelineViewport();view.timelinePins=(view.timelinePins||[]).filter((item)=>item.id!==pin.id);await savePins();await this.loadAndRender(databaseFile);}));menu.showAtMouseEvent(event);});
    };
    for(const pin of [...(view.timelinePins||[])].sort((a,b)=>(a.order??0)-(b.order??0)))renderPin(pin);
    const pinDropGuide=canvas.createDiv({cls:"lmd-db-timeline-pin-drop-guide is-hidden"});
    // 0.13.16 — Pin/add/move coordinate fix (Ctrl UI zoom + Alt time zoom aware).
    // 0.13.15 — Pin drag rewrite. Do not use native HTML5 drag/drop here: its drag hotspot and
    // cross-container coordinates drift when the Timeline is horizontally scrolled. Pointer drag
    // keeps exactly one snapped time as the source of truth for both preview and final placement.
    let pinPointerDrag=null;
    const clearPinPointerDrag=()=>{
      pinDropGuide.addClass("is-hidden");
      pinSource.removeClass("is-pointer-dragging");
      document.body.removeClass("lmd-db-is-timeline-pin-dragging");
      pinPointerDrag=null;
    };
    const updatePinPointerDrag=(event)=>{
      if(!pinPointerDrag||event.pointerId!==pinPointerDrag.pointerId)return;
      const scrollRect=scroll.getBoundingClientRect();
      const inside=event.clientX>=scrollRect.left&&event.clientX<=scrollRect.right&&event.clientY>=scrollRect.top&&event.clientY<=scrollRect.bottom;
      if(!inside){pinPointerDrag.valid=false;pinDropGuide.addClass("is-hidden");return;}
      const rawX=timelineContentXFromClientX(event.clientX);
      const clampedX=Math.max(0,Math.min(contentWidth,rawX));
      const snapped=snapDate(xToTime(clampedX));
      const snappedX=Math.max(0,Math.min(contentWidth,timeToX(snapped)));
      pinPointerDrag.valid=true;
      pinPointerDrag.time=snapped;
      pinPointerDrag.x=snappedX;
      pinDropGuide.style.left=`${snappedX}px`;
      pinDropGuide.removeClass("is-hidden");
      event.preventDefault();
    };
    const finishPinPointerDrag=(event)=>{
      if(!pinPointerDrag||event.pointerId!==pinPointerDrag.pointerId)return;
      const state=pinPointerDrag;
      clearPinPointerDrag();
      document.removeEventListener("pointermove",updatePinPointerDrag,true);
      document.removeEventListener("pointerup",finishPinPointerDrag,true);
      document.removeEventListener("pointercancel",finishPinPointerDrag,true);
      if(!state.valid||!state.time)return;
      rememberTimelineViewport();
      // IMPORTANT: do not recompute from pointerup/clientX. The guide and persisted pin share state.time.
      const pin={id:`pin-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,time:localKey(state.time),name:"",order:(view.timelinePins||[]).length};
      view.timelinePins=[...(view.timelinePins||[]),pin];
      void savePins().then(()=>this.loadAndRender(databaseFile));
    };
    pinSource.addEventListener("pointerdown",(event)=>{
      if(!isLmdPrimaryPointer(event))return;
      event.preventDefault();event.stopPropagation();
      pinPointerDrag={pointerId:event.pointerId,valid:false,time:null,x:null};
      pinSource.addClass("is-pointer-dragging");
      document.body.addClass("lmd-db-is-timeline-pin-dragging");
      document.addEventListener("pointermove",updatePinPointerDrag,true);
      document.addEventListener("pointerup",finishPinPointerDrag,true);
      document.addEventListener("pointercancel",finishPinPointerDrag,true);
      updatePinPointerDrag(event);
    });

    // 0.13.4 — Playhead + chronological Log.
    // 0.13.5 — Inspector follows the playhead and renders active Markdown events.
    const inspectorBodyCache=new Map();
    let inspectorRenderToken=0;
    const readInspectorBody=async(file)=>{
      if(inspectorBodyCache.has(file.path))return inspectorBodyCache.get(file.path);
      let text="";
      try{text=await this.app.vault.cachedRead(file);}catch(_){}
      text=String(text||"").replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/,"").trim();
      inspectorBodyCache.set(file.path,text);
      return text;
    };
    const renderInspector=async(time)=>{
      const token=++inspectorRenderToken;
      inspectorList.empty();
      inspectorList.createDiv({cls:"lmd-db-timeline-inspector-time",text:formatShort(time)});
      const active=timelineEvents.filter((entry)=>entry.isInstant?entry.start.getTime()===time.getTime():(entry.start<=time&&entry.end>=time)).sort((a,b)=>a.start-b.start||a.end-b.end||a.file.basename.localeCompare(b.file.basename));
      if(!active.length){inspectorList.createDiv({cls:"lmd-db-timeline-inspector-empty",text:"這個時間點沒有正在進行的事件。"});return;}
      const bodies=await Promise.all(active.map((entry)=>readInspectorBody(entry.file)));
      if(token!==inspectorRenderToken)return;
      active.forEach((entry,index)=>{
        const card=inspectorList.createDiv({cls:`lmd-db-timeline-inspector-card${entry.lane.isShadow?" is-shadow":""}`});
        const titleRow=card.createDiv({cls:"lmd-db-timeline-inspector-title-row"});
        const titleButton=titleRow.createEl("button",{cls:"lmd-db-timeline-inspector-title",text:entry.file.basename,attr:{type:"button",title:"開啟 Markdown"}});
        titleButton.addEventListener("click",()=>void this.openDatabaseItem(entry.file,databaseFile));
        if(entry.lane.isShadow)titleRow.createSpan({cls:"lmd-db-timeline-inspector-shadow",text:"影子"});
        card.createDiv({cls:"lmd-db-timeline-inspector-range",text:entry.isInstant?`◆ ${formatShort(entry.start)} · 瞬間事件`:`${formatShort(entry.start)} → ${formatShort(entry.end)}`});
        card.createDiv({cls:"lmd-db-timeline-inspector-source",text:`來源：${entry.lane.label}`});
        const frontmatter=this.app.metadataCache.getFileCache(entry.file)?.frontmatter||{};
        const fields=Array.isArray(entry.lane.definition?.schema)?entry.lane.definition.schema:[];
        const propertyRows=[];
        for(const field of fields){
          if(!field?.id||field.id===entry.lane.dateField?.id)continue;
          const value=frontmatter[field.id]; const text=formatProperty(value).trim();
          if(!text)continue; propertyRows.push({field,text}); if(propertyRows.length>=6)break;
        }
        if(propertyRows.length){
          const props=card.createDiv({cls:"lmd-db-timeline-inspector-properties"});
          for(const row of propertyRows){const prop=props.createDiv({cls:"lmd-db-timeline-inspector-property"});prop.createSpan({cls:"lmd-db-timeline-inspector-property-name",text:row.field.name||row.field.id});prop.createSpan({cls:"lmd-db-timeline-inspector-property-value",text:row.text});}
        }
        const bodyText=bodies[index];
        if(bodyText){
          const preview=card.createDiv({cls:"lmd-db-timeline-inspector-preview markdown-rendered"});
          const excerpt=bodyText.length>1800?`${bodyText.slice(0,1800)}\n\n…`:bodyText;
          void MarkdownRenderer.render(this.app,excerpt,preview,entry.file.path,this).catch(()=>preview.setText(excerpt));
        }else card.createDiv({cls:"lmd-db-timeline-inspector-preview-empty",text:"沒有 Markdown 正文。"});
      });
    };
    const clampTime=(d)=>new Date(Math.max(rangeStart.getTime(),Math.min(rangeEnd.getTime(),d.getTime())));
    let playheadTime=parseLocal(view.timelinePlayhead);
    if(!playheadTime||playheadTime<rangeStart||playheadTime>rangeEnd) playheadTime=new Date(rangeStart);
    view.timelinePlayhead=localKey(playheadTime);
    const playhead=canvas.createDiv({cls:`lmd-db-timeline-playhead${interactionMode==="playback"?"":" is-hidden"}`});
    const playheadHandle=playhead.createDiv({cls:"lmd-db-timeline-playhead-handle",attr:{title:"拖曳時間指標","aria-label":"拖曳時間指標"}});
    const playheadLabel=playhead.createDiv({cls:"lmd-db-timeline-playhead-label"});
    const setPlayheadVisual=(time)=>{
      playheadTime=clampTime(time);
      const left=timeToX(playheadTime);
      playhead.style.left=`${left}px`;
      playheadLabel.setText(formatTimelineTick(playheadTime));
      for(const entry of timelineEvents) entry.bar.toggleClass("is-playhead-active",entry.isInstant?entry.start.getTime()===playheadTime.getTime():(entry.start<=playheadTime&&entry.end>=playheadTime));
      void renderInspector(playheadTime);
    };
    setPlayheadVisual(playheadTime);
    const persistPlayhead=async()=>{view.timelinePlayhead=localKey(playheadTime);await this.saveDefinition(databaseFile,definition);};
    const appendLog=(time,entry,kind)=>{
      const previous=timelineLogEntries.length?timelineLogEntries[timelineLogEntries.length-1]:null;
      const item={time:new Date(time),entry,kind};
      timelineLogEntries.push(item);
      while(timelineLogEntries.length>200)timelineLogEntries.shift();
      logList.querySelectorAll(".lmd-db-timeline-log-empty").forEach((el)=>el.remove());
      const row=logList.createDiv({cls:`lmd-db-timeline-log-entry${entry.lane.isShadow?" is-shadow":""}`});
      const showDate=(item.time.getHours()===0&&item.time.getMinutes()===0)||(previous&&!sameCalendarDay(previous.time,item.time));
      row.createDiv({cls:"lmd-db-timeline-log-time",text:showDate?formatShort(item.time):formatClock(item.time)});
      const symbol=kind==="instant"?"◆":kind==="start"?"▶":"■";
      row.createDiv({cls:"lmd-db-timeline-log-title",text:`${symbol} ${entry.file.basename}${kind==="end"?" 結束":""}`});
      row.createDiv({cls:"lmd-db-timeline-log-source",text:`${entry.lane.label}${entry.lane.isShadow?" · 影子":""}`});
      while(logList.children.length>200) logList.firstElementChild?.remove();
      requestAnimationFrame(()=>{logList.scrollTop=Math.max(0,logList.scrollHeight-logList.clientHeight);});
    };
    const logSymbol=(kind)=>kind==="instant"?"◆":kind==="start"?"▶":"■";
    const logLine=(item,index,items)=>{const previous=index>0?items[index-1]:null;const showDate=(item.time.getHours()===0&&item.time.getMinutes()===0)||(previous&&!sameCalendarDay(previous.time,item.time));const stamp=showDate?formatShort(item.time):formatClock(item.time);return `${stamp} ${logSymbol(item.kind)} ${item.entry.file.basename}${item.kind==="end"?" 結束":""} — ${item.entry.lane.label}${item.entry.lane.isShadow?" · 影子":""}`;};
    const safeFilePart=(value)=>String(value||"").replace(/[\/:*?"<>|]/g,"-").replace(/\s+/g," ").trim()||"Timeline";
    const localStamp=(d=new Date())=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    exportTimelineLog=async()=>{
      if(!timelineLogEntries.length){new Notice("目前沒有可匯出的 Timeline Log。");return;}
      try{
        const folder=normalizePath("Local Markdown Database Logs");
        if(!this.app.vault.getAbstractFileByPath(folder))await this.app.vault.createFolder(folder);
        const viewName=safeFilePart(view.name||"Timeline");
        const dbName=safeFilePart(databaseFile.basename||"Database");
        let path=normalizePath(`${folder}/${dbName} - ${viewName} - ${localStamp()}.md`);
        let index=2;
        while(this.app.vault.getAbstractFileByPath(path))path=normalizePath(`${folder}/${dbName} - ${viewName} - ${localStamp()} (${index++}).md`);
        const lines=[
          `# Timeline Log — ${databaseFile.basename} / ${view.name||"Timeline"}`,
          "",
          `- Database：[[${databaseFile.path}]]`,
          `- View：${view.name||"Timeline"}`,
          `- Timeline 範圍：${formatShort(rangeStart)} → ${formatShort(rangeEnd)}`,
          `- 匯出時間：${new Date().toLocaleString()}`,
          "",
          "## Log",
          "",
          ...timelineLogEntries.map((item,index,items)=>`- ${logLine(item,index,items)}`),
          ""
        ];
        const file=await this.app.vault.create(path,lines.join("\n"));
        new Notice(`已匯出 Timeline Log：${file.path}`);
      }catch(error){console.error("[Local Markdown Database] export timeline log failed",error);new Notice("匯出 Timeline Log 失敗，請查看開發者主控台。");}
    };
    printTimelineLog=()=>{
      const hits=[];
      for(const entry of timelineEvents){
        if(entry.isInstant){if(entry.start>=rangeStart&&entry.start<=rangeEnd)hits.push({time:entry.start,entry,kind:"instant"});continue;}
        if(entry.start>=rangeStart&&entry.start<=rangeEnd)hits.push({time:entry.start,entry,kind:"start"});
        if(entry.end>=rangeStart&&entry.end<=rangeEnd)hits.push({time:entry.end,entry,kind:"end"});
      }
      hits.sort((a,b)=>a.time-b.time||(a.kind==="start"?-1:a.kind==="instant"?0:1));
      timelineLogEntries.length=0;
      logList.empty();
      if(!hits.length){logList.createDiv({cls:"lmd-db-timeline-log-empty",text:"目前 Timeline 範圍內沒有可印出的事件。"});new Notice("目前 Timeline 範圍內沒有事件。");return;}
      for(const hit of hits)appendLog(hit.time,hit.entry,hit.kind);
      new Notice(`已將目前範圍的 ${hits.length} 筆時間事件印入 Log。`);
    };
    const emitCrossings=(from,to)=>{
      if(to<=from)return;
      const hits=[];
      for(const entry of timelineEvents){
        if(entry.isInstant){if(entry.start>from&&entry.start<=to)hits.push({time:entry.start,entry,kind:"instant"});continue;}
        if(entry.start>from&&entry.start<=to)hits.push({time:entry.start,entry,kind:"start"});
        if(entry.end>from&&entry.end<=to)hits.push({time:entry.end,entry,kind:"end"});
      }
      hits.sort((a,b)=>a.time-b.time||(a.kind==="start"?-1:a.kind==="instant"?0:1));
      for(const hit of hits)appendLog(hit.time,hit.entry,hit.kind);
    };
    let headDrag=null;
    const headFromClientX=(clientX)=>snapDate(clampTime(xToTime(timelineContentXFromClientX(clientX))));
    playheadHandle.addEventListener("pointerdown",(event)=>{if(!isLmdPrimaryPointer(event))return;event.preventDefault();event.stopPropagation();playheadHandle.setPointerCapture?.(event.pointerId);headDrag={id:event.pointerId};playhead.addClass("is-dragging");});
    playheadHandle.addEventListener("pointermove",(event)=>{if(!headDrag||headDrag.id!==event.pointerId)return;setPlayheadVisual(headFromClientX(event.clientX));});
    const endHeadDrag=(event)=>{if(!headDrag||headDrag.id!==event.pointerId)return;headDrag=null;playhead.removeClass("is-dragging");void persistPlayhead();};
    playheadHandle.addEventListener("pointerup",endHeadDrag);playheadHandle.addEventListener("pointercancel",endHeadDrag);
    ruler.addEventListener("pointerdown",(event)=>{if(interactionMode!=="playback"||!isLmdPrimaryPointer(event)||event.target===playheadHandle)return;event.preventDefault();setPlayheadVisual(headFromClientX(event.clientX));void persistPlayhead();});

    let isPlaying=false,lastFrame=0,stepAccumulator=0;
    const syncPlayButton=()=>{
      const iconEl=playButton.querySelector(".lmd-db-toolbar-icon"); if(iconEl){iconEl.empty();setIcon(iconEl,isPlaying?"pause":"play");}
      const labelEl=playButton.querySelector(".lmd-db-toolbar-label"); if(labelEl)labelEl.setText(isPlaying?"暫停":"播放");
      playButton.toggleClass("is-active",isPlaying);
    };
    const stopPlayback=async()=>{isPlaying=false;if(this.timelinePlaybackFrame){cancelAnimationFrame(this.timelinePlaybackFrame);this.timelinePlaybackFrame=null;}syncPlayButton();await persistPlayhead();};
    const syncInteractionMode=()=>{
      const isPlayback=interactionMode==="playback";
      shell.toggleClass("is-playback",isPlayback);shell.toggleClass("is-static",!isPlayback);
      sidePanel.toggleClass("is-hidden",!isPlayback);playhead.toggleClass("is-hidden",!isPlayback);
      resetButton.toggleClass("is-hidden",!isPlayback);locatePlayheadButton.toggleClass("is-hidden",!isPlayback);playButton.toggleClass("is-hidden",!isPlayback);
      const iconEl=modeButton.querySelector(".lmd-db-toolbar-icon");if(iconEl){iconEl.empty();setIcon(iconEl,isPlayback?"clapperboard":"image");}
      const labelEl=modeButton.querySelector(".lmd-db-toolbar-label");if(labelEl)labelEl.setText(isPlayback?"播放模式":"靜態");
    };
    toggleTimelineInteractionMode=async()=>{
      if(isPlaying)await stopPlayback();
      interactionMode=interactionMode==="playback"?"static":"playback";
      view.timelineInteractionMode=interactionMode;syncInteractionMode();await this.saveDefinition(databaseFile,definition);
    };
    syncInteractionMode();
    const frame=(ts)=>{
      if(!isPlaying)return;
      if(!lastFrame)lastFrame=ts;
      stepAccumulator+=ts-lastFrame;lastFrame=ts;
      const stepDelay=350;
      while(stepAccumulator>=stepDelay&&isPlaying){
        stepAccumulator-=stepDelay;
        const previous=new Date(playheadTime);
        const next=clampTime(new Date(playheadTime.getTime()+snapMs));
        emitCrossings(previous,next);
        setPlayheadVisual(next);
        if(next>=playbackEndAuto){setPlayheadVisual(new Date(playbackEndAuto));void stopPlayback();break;}
      }
      if(isPlaying)this.timelinePlaybackFrame=requestAnimationFrame(frame);
    };
    jumpToTimelinePlayhead=()=>{
      if(interactionMode!=="playback")return;
      const x=timeToX(playheadTime);
      scroll.scrollLeft=Math.max(0,Math.min(scroll.scrollWidth-scroll.clientWidth,x-scroll.clientWidth*0.5));
    };
    resetTimelinePlayhead=()=>{
      if(interactionMode!=="playback")return;
      if(isPlaying){isPlaying=false;if(this.timelinePlaybackFrame){cancelAnimationFrame(this.timelinePlaybackFrame);this.timelinePlaybackFrame=null;}syncPlayButton();}
      setPlayheadVisual(new Date(playbackStartAuto||rangeStart));
      scroll.scrollLeft=Math.max(0,((playbackStartAuto||rangeStart)-rangeStart)/60000*pxPerMinute-scroll.clientWidth*.15);
      void persistPlayhead();
    };
    toggleTimelinePlayback=()=>{
      if(interactionMode!=="playback")return;
      if(isPlaying){void stopPlayback();return;}
      if(playheadTime>=playbackEndAuto)setPlayheadVisual(new Date(playbackStartAuto||rangeStart));
      isPlaying=true;lastFrame=0;stepAccumulator=0;syncPlayButton();this.timelinePlaybackFrame=requestAnimationFrame(frame);
    };
    syncPlayButton();

    const updateX=this.installViewportHorizontalScrollbar(scroll,()=>contentWidth);requestAnimationFrame(()=>{updateX();if(this.timelineRestoreTime){const focus=this.timelineRestoreTime;this.timelineRestoreTime=null;const x=timeToX(focus);scroll.scrollLeft=Math.max(0,Math.min(scroll.scrollWidth-scroll.clientWidth,x));}});

    // 0.13.8 — Events without an end are true point events (◆), not fake durations.
    // 0.13.6 — Alt + wheel changes only Timeline time density. Ctrl + wheel remains UI zoom; snap stays independent.
    let timelineZoomSaveTimer=0;
    const saveTimelineZoomLater=()=>{
      if(timelineZoomSaveTimer)window.clearTimeout(timelineZoomSaveTimer);
      timelineZoomSaveTimer=window.setTimeout(()=>{timelineZoomSaveTimer=0;void this.saveDefinition(databaseFile,definition);},260);
    };
    const applyTimelineScale=(nextPx,anchorClientX=null)=>{
      const previousPx=pxPerMinute;
      nextPx=Math.max(0.25,Math.min(16,Math.round(nextPx*100)/100));
      if(nextPx===previousPx)return;
      const rect=scroll.getBoundingClientRect();
      const anchorViewportX=anchorClientX==null
        ?Math.max(0,scroll.clientWidth/2)
        :Math.max(0,Math.min(scroll.clientWidth,viewportPxToTimelinePx(anchorClientX-rect.left)));
      const anchorContentX=scroll.scrollLeft+anchorViewportX;
      const anchorMinutes=anchorContentX/previousPx;
      pxPerMinute=nextPx;
      view.timelinePxPerMinute=pxPerMinute;
      contentWidth=Math.max(640,Math.ceil(durationMinutes*pxPerMinute));
      canvas.style.width=`${contentWidth}px`;
      renderRulerTicks();
      for(const entry of timelineEvents){
        const visibleStart=entry.isInstant?entry.start:(entry.start<rangeStart?rangeStart:entry.start),visibleEnd=entry.isInstant?entry.start:(entry.end>rangeEnd?rangeEnd:entry.end);
        entry.bar.style.transform="";
        entry.bar.style.left=`${((visibleStart-rangeStart)/60000)*pxPerMinute}px`;
        entry.bar.style.width=`${entry.isInstant?18:Math.max(14,((visibleEnd-visibleStart)/60000)*pxPerMinute)}px`;
      }
      playhead.style.left=`${timeToX(playheadTime)}px`;
      for(const pinEl of canvas.querySelectorAll(".lmd-db-timeline-pin")){const pin=(view.timelinePins||[]).find((item)=>item.id===pinEl.dataset.pinId);const time=parseLocal(pin?.time);if(time)pinEl.style.left=`${timeToX(time)}px`;}
      scroll.scrollLeft=Math.max(0,anchorMinutes*pxPerMinute-anchorViewportX);
      updateX();
      saveTimelineZoomLater();
    };
    scroll.addEventListener("wheel",(event)=>{
      if(!event.altKey||event.ctrlKey||event.metaKey)return;
      event.preventDefault();event.stopPropagation();
      const factor=event.deltaY<0?1.15:1/1.15;
      applyTimelineScale(pxPerMinute*factor,event.clientX);
    },{passive:false,signal:this.renderAbortController?.signal});
    scroll.addEventListener("wheel",(event)=>{
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;
      if(!delta)return;
      event.preventDefault();event.stopPropagation();
      scroll.scrollLeft+=delta;
    },{passive:false,signal:this.renderAbortController?.signal});
    this.renderAbortController?.signal?.addEventListener("abort",()=>{if(timelineZoomSaveTimer)window.clearTimeout(timelineZoomSaveTimer);},{once:true});

    this.contentEl.createDiv({cls:"lmd-db-footer",text:`Timeline Rebuild · ${lanes.length} 條來源軸 · 自動範圍 · 磁吸 ${snap} 分鐘 · Alt+滾輪縮放時間 · ${formatShort(rangeStart)} → ${formatShort(rangeEnd)}`});
  }

  async renderBoardView(databaseFile, definition, activeViewEntry, view, source, rawFiles, schema, columns, files) {
    const fieldById = new Map(schema.map((field) => [field.id, field]));
    let groupField = fieldById.get(view.boardGroupBy);
    if (!groupField) {
      groupField = schema[0];
      view.boardGroupBy = groupField?.id || "";
      await this.saveDefinition(databaseFile, definition);
    }

    const clearNativeSelection = () => {
      try { window.getSelection()?.removeAllRanges(); } catch (_) {}
    };
    const clearBoardDragVisuals = () => {
      document.body.removeClass("lmd-db-is-board-dragging", "lmd-db-is-row-marqueeing", "lmd-db-is-cell-selecting");
      for (const el of this.contentEl.querySelectorAll(".lmd-db-board .is-drop-target, .lmd-db-board .is-column-drop-before, .lmd-db-board .is-column-drop-after, .lmd-db-board .is-card-drop-before, .lmd-db-board .is-card-drop-after, .lmd-db-board .is-card-drop-end")) {
        el.removeClass("is-drop-target", "is-column-drop-before", "is-column-drop-after", "is-card-drop-before", "is-card-drop-after", "is-card-drop-end");
      }
      for (const indicator of this.contentEl.querySelectorAll(".lmd-db-board-drop-indicator")) indicator.style.display = "none";
      for (const marquee of document.querySelectorAll(".lmd-db-row-marquee")) marquee.remove();
      clearNativeSelection();
      requestAnimationFrame(clearNativeSelection);
    };

    const toolbar = this.contentEl.createDiv({ cls: "lmd-db-toolbar lmd-db-board-toolbar" });
    const decorate = (button, icon, label, badge = "") => {
      button.addClass("lmd-db-toolbar-button"); button.empty();
      const iconEl = button.createSpan({ cls: "lmd-db-toolbar-icon" }); setIcon(iconEl, icon);
      button.createSpan({ cls: "lmd-db-toolbar-label", text: label });
      if (badge) button.createSpan({ cls: "lmd-db-toolbar-badge", text: badge });
      return button;
    };
    const addRow = toolbar.createEl("button", { cls: "mod-cta" }); decorate(addRow, "plus", "新增資料列");
    addRow.addEventListener("click", () => void this.createRow(source));
    const groupButton = toolbar.createEl("button"); decorate(groupButton, "columns-3", `分組：${groupField?.name || "未設定"}`);
    groupButton.addEventListener("click", () => {
      new BoardGroupFieldModal(this.app, schema, view.boardGroupBy, async (fieldId) => {
        view.boardGroupBy = fieldId; view.boardGroupOrder = [];
        await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile);
      }).open();
    });
    const groupVisibilityButton = toolbar.createEl("button"); decorate(groupVisibilityButton, "eye", "分組顯示");
    groupVisibilityButton.addEventListener("click", () => {
      const hidden = Array.isArray(view.boardHiddenGroups) ? view.boardHiddenGroups : [];
      const values = [];
      const valueSet = new Set();
      for (const file of rawFiles) {
        for (const value of this.getBoardGroupValues(file, groupField)) if (value && !valueSet.has(value)) { valueSet.add(value); values.push(value); }
      }
      for (const value of view.boardGroupOrder || []) if (value && !valueSet.has(value)) { valueSet.add(value); values.push(value); }
      const ungroupedKey = "__lmd_ungrouped__";
      const allGroups = [ungroupedKey, ...values];
      new BoardGroupVisibilityModal(this.app, allGroups, hidden, (g) => g === ungroupedKey ? "未分類" : this.getBoardGroupLabel(g, groupField), async (nextHidden) => {
        view.boardHiddenGroups = nextHidden;
        await this.saveDefinition(databaseFile, definition);
        await this.loadAndRender(databaseFile);
      }).open();
    });
    const cardFieldsButton = toolbar.createEl("button"); decorate(cardFieldsButton, "layout-list", "卡片內容");
    cardFieldsButton.addEventListener("click", () => {
      new BoardCardFieldsModal(this.app, schema, view.boardCardFields, async (fieldIds) => {
        view.boardCardFields = fieldIds;
        await this.saveDefinition(databaseFile, definition);
        await this.loadAndRender(databaseFile);
      }).open();
    });
    const sortButton = toolbar.createEl("button"); decorate(sortButton, "arrow-up-down", "排序", view.sort.length ? String(view.sort.length) : "");
    sortButton.addEventListener("click", () => new AddSortModal(this.app, allColumns, async (rule) => { view.sort.push(rule); await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile); }).open());
    const filterButton = toolbar.createEl("button"); decorate(filterButton, "list-filter", "篩選", view.filters.length ? String(view.filters.length) : "");
    filterButton.addEventListener("click", () => new AddFilterModal(this.app, columns, async (rule) => { view.filters.push(rule); await this.saveCurrentViewState(databaseFile, definition); await this.loadAndRender(databaseFile); }, this.buildFilterSuggestions(columns, rawFiles)).open());
    if (view.sort.length || view.filters.length) {
      const clear = toolbar.createEl("button"); decorate(clear, "rotate-ccw", "清除");
      clear.addEventListener("click", async () => { view.sort = []; view.filters = []; await this.saveCurrentViewState(databaseFile, definition); await this.loadAndRender(databaseFile); });
    }

    // Board uses the same visible rule chips as Table so active Sort / Filter rules
    // are inspectable and removable one-by-one instead of only showing a badge count.
    const ruleBar = this.contentEl.createDiv({ cls: "lmd-db-rule-bar lmd-db-board-rule-bar" });
    for (let i = 0; i < view.sort.length; i++) {
      const r = view.sort[i], c = columns.find((x) => x.id === r.field);
      const chip = ruleBar.createEl("button", { cls: "lmd-db-rule-chip", text: `排序：${c?.name || r.field} ${r.direction === "desc" ? "↓" : "↑"} ×` });
      chip.addEventListener("click", async () => { view.sort.splice(i, 1); await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile); });
    }
    for (let i = 0; i < view.filters.length; i++) {
      const r = view.filters[i], c = columns.find((x) => x.id === r.field);
      const val = (r.operator === "empty" || r.operator === "not-empty") ? "" : ` ${r.value}`;
      const chip = ruleBar.createEl("button", { cls: "lmd-db-rule-chip", text: `篩選：${c?.name || r.field} ${this.filterOperatorLabel(r.operator)}${val} ×` });
      chip.addEventListener("click", async () => { view.filters.splice(i, 1); await this.saveCurrentViewState(databaseFile, definition); await this.loadAndRender(databaseFile); });
    }
    if (!view.sort.length && !view.filters.length) ruleBar.style.display = "none";

    if (!groupField) {
      this.contentEl.createDiv({ cls: "lmd-db-empty-state", text: "Board 需要至少一個 property 欄位作為分組依據。" });
      return;
    }

    const UNGROUPED = "__lmd_ungrouped__";
    const discovered = [];
    const seen = new Set();
    for (const file of files) {
      const values = this.getBoardGroupValues(file, groupField);
      for (const value of values) if (!seen.has(value)) { seen.add(value); discovered.push(value); }
    }
    const stored = (view.boardGroupOrder || []).filter((value) => value && (seen.has(value) || !value.startsWith("__lmd_")));
    const allGroups = [UNGROUPED, ...stored, ...discovered.filter((value) => !stored.includes(value))];
    view.boardGroupOrder = allGroups.filter((value) => value !== UNGROUPED);
    const hiddenGroups = new Set(Array.isArray(view.boardHiddenGroups) ? view.boardHiddenGroups : []);
    const groups = allGroups.filter((group) => !hiddenGroups.has(group));

    const board = this.contentEl.createDiv({ cls: "lmd-db-board" });
    const updateBoardXScroll = this.installViewportHorizontalScrollbar(board, () => board.scrollWidth);
    this.installCtrlWheelZoom(board, databaseFile, definition, view, () => {
      requestAnimationFrame(() => { updateBoardXScroll(); requestAnimationFrame(updateBoardXScroll); });
    });
    const cardsByGroup = new Map(allGroups.map((group) => [group, []]));
    for (const file of files) {
      const values = this.getBoardGroupValues(file, groupField);
      if (!values.length) cardsByGroup.get(UNGROUPED).push({ file, sourceGroup: UNGROUPED });
      else {
        for (const value of values) {
          if (!cardsByGroup.has(value)) { cardsByGroup.set(value, []); groups.push(value); }
          cardsByGroup.get(value).push({ file, sourceGroup: value });
        }
      }
    }

    const reorderManualPath = (dragPath, targetPath, after) => {
      if (!dragPath || !targetPath || dragPath === targetPath) return;
      const dragId = this.getItemIdByPath(dragPath);
      const targetId = this.getItemIdByPath(targetPath);
      if (!dragId || !targetId || dragId === targetId) return;
      const base = Array.isArray(view.manualOrder) ? view.manualOrder.slice() : rawFiles.map((f) => this.getStableItemId(f)).filter(Boolean);
      // Ensure all current source rows are represented before reordering.
      for (const file of rawFiles) { const id = this.getStableItemId(file); if (id && !base.includes(id)) base.push(id); }
      const without = base.filter((id) => id !== dragId);
      let index = without.indexOf(targetId);
      if (index < 0) index = without.length;
      if (after) index += 1;
      without.splice(Math.max(0, Math.min(index, without.length)), 0, dragId);
      view.manualOrder = without;
    };

    const reorderBoardGroups = async (sourceGroup, targetGroup, after) => {
      if (!sourceGroup || !targetGroup || sourceGroup === targetGroup || sourceGroup === UNGROUPED) return;
      const order = groups.filter((g) => g !== UNGROUPED && g !== sourceGroup);
      let index = order.indexOf(targetGroup);
      if (index < 0) index = order.length;
      if (after) index += 1;
      order.splice(Math.max(0, Math.min(index, order.length)), 0, sourceGroup);
      view.boardGroupOrder = order;
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };

    const handleCardDrop = async (event, group, targetPath = "", after = false) => {
      const path = event.dataTransfer.getData("text/lmd-board-card");
      if (!path) return;
      event.preventDefault(); event.stopPropagation();
      const sourceGroup = event.dataTransfer.getData("text/lmd-board-source") || UNGROUPED;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      clearBoardDragVisuals();
      let changed = true;
      if (sourceGroup !== group) changed = await this.moveBoardCard(file, groupField, sourceGroup, group);
      if (targetPath && targetPath !== path && !view.sort.length) reorderManualPath(path, targetPath, after);
      if (!changed) return;
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };

    const renameBoardGroup = async (oldGroup, newName) => {
      const clean = String(newName || "").trim();
      if (!clean || clean === oldGroup || oldGroup === UNGROUPED) return;
      if (groupField.type === "relation") {
        new Notice("Relation 分組名稱來自被關聯的筆記，請改名該筆記本身。");
        return;
      }
      for (const file of rawFiles) {
        const current = this.getBoardGroupValues(file, groupField);
        if (!current.includes(oldGroup)) continue;
        if (groupField.type === "multi-select") {
          const next = Array.from(new Set(current.map((value) => value === oldGroup ? clean : value)));
          await this.writeProperty(file, groupField, next);
        } else {
          await this.writeProperty(file, groupField, clean);
        }
      }
      view.boardGroupOrder = (view.boardGroupOrder || []).map((value) => value === oldGroup ? clean : value);
      view.boardHiddenGroups = (view.boardHiddenGroups || []).map((value) => value === oldGroup ? clean : value);
      if ((groupField.type === "multi-select" || groupField.type === "single-select") && groupField.optionColors && Object.prototype.hasOwnProperty.call(groupField.optionColors, oldGroup)) {
        if (!Object.prototype.hasOwnProperty.call(groupField.optionColors, clean)) groupField.optionColors[clean] = groupField.optionColors[oldGroup];
        delete groupField.optionColors[oldGroup];
      }
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };

    const removeEmptyBoardGroup = async (group) => {
      if (group === UNGROUPED) return;
      const count = cardsByGroup.get(group)?.length || 0;
      if (count > 0) { new Notice("這個分組還有卡片，不能只刪除分組。可以先移動卡片或隱藏分組。"); return; }
      view.boardGroupOrder = (view.boardGroupOrder || []).filter((value) => value !== group);
      view.boardHiddenGroups = (view.boardHiddenGroups || []).filter((value) => value !== group);
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };

    const renderColumn = (group) => {
      const column = board.createDiv({ cls: "lmd-db-board-column", attr: { draggable: group === UNGROUPED ? "false" : "true" } });
      column.dataset.group = group;
      const head = column.createDiv({ cls: "lmd-db-board-column-head" });
      const groupTitle = head.createSpan({ cls: "lmd-db-board-column-title", text: this.getBoardGroupLabel(group, groupField) });
      if (group !== UNGROUPED && (groupField?.type === "multi-select" || groupField?.type === "single-select")) groupTitle.addClass(...this.chipClassFor(groupField, group).split(" "));
      head.createSpan({ cls: "lmd-db-board-count", text: String(cardsByGroup.get(group)?.length || 0) });

      head.addEventListener("contextmenu", (event) => {
        event.preventDefault(); event.stopPropagation();
        const menu = new Menu();
        if (group !== UNGROUPED && groupField.type !== "relation") {
          menu.addItem((item) => item.setTitle("重新命名分組").setIcon("pencil").onClick(() => {
            new ViewNameModal(this.app, "重新命名 Board 分組", this.getBoardGroupLabel(group, groupField), async (name) => {
              await renameBoardGroup(group, name);
            }).open();
          }));
        }
        menu.addItem((item) => item.setTitle("隱藏此分組").setIcon("eye-off").onClick(async () => {
          const hidden = new Set(Array.isArray(view.boardHiddenGroups) ? view.boardHiddenGroups : []);
          hidden.add(group);
          view.boardHiddenGroups = Array.from(hidden);
          await this.saveDefinition(databaseFile, definition);
          await this.loadAndRender(databaseFile);
        }));
        if (group !== UNGROUPED && (cardsByGroup.get(group)?.length || 0) === 0) {
          menu.addSeparator();
          menu.addItem((item) => item.setTitle("刪除空分組").setIcon("trash-2").onClick(async () => {
            await removeEmptyBoardGroup(group);
          }));
        }
        menu.showAtMouseEvent(event);
      });

      if (group !== UNGROUPED) {
        column.addEventListener("dragstart", (event) => {
          // Card drags bubble through the column; only start a column drag when the header itself initiated it.
          if (event.target.closest?.(".lmd-db-board-card")) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/lmd-board-column", group);
          column.addClass("is-column-dragging");
          document.body.addClass("lmd-db-is-board-dragging"); clearNativeSelection();
        });
        column.addEventListener("dragend", () => { column.removeClass("is-column-dragging"); clearBoardDragVisuals(); });
        column.addEventListener("dragover", (event) => {
          if (!event.dataTransfer.types.includes("text/lmd-board-column")) return;
          event.preventDefault();
          const rect = column.getBoundingClientRect();
          const after = event.clientX >= rect.left + rect.width / 2;
          column.toggleClass("is-column-drop-before", !after);
          column.toggleClass("is-column-drop-after", after);
        });
        column.addEventListener("dragleave", (event) => {
          if (event.relatedTarget && column.contains(event.relatedTarget)) return;
          column.removeClass("is-column-drop-before", "is-column-drop-after");
        });
        column.addEventListener("drop", async (event) => {
          if (!event.dataTransfer.types.includes("text/lmd-board-column")) return;
          event.preventDefault(); event.stopPropagation();
          const sourceGroup = event.dataTransfer.getData("text/lmd-board-column");
          const rect = column.getBoundingClientRect();
          const after = event.clientX >= rect.left + rect.width / 2;
          clearBoardDragVisuals();
          await reorderBoardGroups(sourceGroup, group, after);
        });
      }

      const body = column.createDiv({ cls: "lmd-db-board-column-body" });
      const dropIndicator = body.createDiv({ cls: "lmd-db-board-drop-indicator" });
      const getCardDropTarget = (event) => {
        const dragPath = event.dataTransfer.getData("text/lmd-board-card");
        const cards = Array.from(body.querySelectorAll(".lmd-db-board-card"))
          .filter((el) => el.dataset.path !== dragPath && !el.classList.contains("is-dragging"));
        if (!cards.length) return { targetPath: "", after: false, top: 8 };
        const y = event.clientY;
        for (const cardEl of cards) {
          const rect = cardEl.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          if (y < mid) return { targetPath: cardEl.dataset.path || "", after: false, top: cardEl.offsetTop - 4 };
        }
        const last = cards[cards.length - 1];
        return { targetPath: last.dataset.path || "", after: true, top: last.offsetTop + last.offsetHeight + 4 };
      };
      const showCardDropIndicator = (event) => {
        const target = getCardDropTarget(event);
        dropIndicator.style.display = "block";
        dropIndicator.style.top = `${Math.max(4, target.top)}px`;
        body.dataset.dropTargetPath = target.targetPath || "";
        body.dataset.dropAfter = target.after ? "1" : "0";
      };
      const hideCardDropIndicator = () => {
        dropIndicator.style.display = "none";
        delete body.dataset.dropTargetPath;
        delete body.dataset.dropAfter;
      };
      body.addEventListener("dragover", (event) => {
        if (!event.dataTransfer.types.includes("text/lmd-board-card")) return;
        event.preventDefault();
        showCardDropIndicator(event);
      });
      body.addEventListener("dragleave", (event) => {
        if (event.relatedTarget && body.contains(event.relatedTarget)) return;
        hideCardDropIndicator();
      });
      body.addEventListener("drop", async (event) => {
        if (!event.dataTransfer.types.includes("text/lmd-board-card")) return;
        event.preventDefault();
        const target = getCardDropTarget(event);
        hideCardDropIndicator();
        await handleCardDrop(event, group, target.targetPath, target.after);
      });

      for (const entry of cardsByGroup.get(group) || []) {
        const card = body.createDiv({ cls: "lmd-db-board-card", attr: { draggable: "true" } });
        card.dataset.path = entry.file.path;
        const cardHead = card.createDiv({ cls: "lmd-db-board-card-head" });
        cardHead.createDiv({ cls: "lmd-db-board-card-title", text: entry.file.basename });
        const editButton = cardHead.createEl("button", { cls: "lmd-db-board-card-edit-button", attr: { type: "button", "aria-label": "編輯卡片", title: "編輯卡片" } });
        setIcon(editButton, "pencil");
        editButton.draggable = false;
        const cache = this.app.metadataCache.getFileCache(entry.file);
        const frontmatter = (cache && cache.frontmatter) || {};
        editButton.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
        editButton.addEventListener("click", (event) => {
          event.preventDefault(); event.stopPropagation();
          const multiFields = schema.filter((field) => field.type === "multi-select");
          const valuesByField = {};
          const suggestionsByField = {};
          for (const field of multiFields) {
            const raw = frontmatter[field.id];
            valuesByField[field.id] = Array.isArray(raw) ? raw.map(String) : (raw ? [String(raw)] : []);
            suggestionsByField[field.id] = this.collectMultiSelectSuggestions(field);
          }
          new BoardCardEditModal(this.app, entry.file, multiFields, entry.file.basename, valuesByField, suggestionsByField, async (result) => {
            let currentFile = entry.file;
            const requested = sanitizeFileName(result.title);
            if (requested && requested !== currentFile.basename) {
              await this.renameRow(currentFile, requested);
              const refreshed = this.app.vault.getAbstractFileByPath(normalizePath(currentFile.parent?.path ? `${currentFile.parent.path}/${requested}.md` : `${requested}.md`));
              if (refreshed instanceof TFile) currentFile = refreshed;
            }
            let schemaChanged = false;
            for (const field of multiFields) {
              const nextColors = result.colorsByField?.[field.id] || field.optionColors || {};
              if (JSON.stringify(nextColors) !== JSON.stringify(field.optionColors || {})) {
                field.optionColors = nextColors;
                schemaChanged = true;
              }
              await this.writeProperty(currentFile, field, result.valuesByField?.[field.id] || []);
            }
            if (schemaChanged) await this.saveDefinition(databaseFile, definition);
            await this.loadAndRender(databaseFile);
          }).open();
        });
        const previewFields = (view.boardCardFields || []).map((id) => fieldById.get(id)).filter(Boolean);
        for (const field of previewFields) {
          const value = frontmatter[field.id];
          if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
          const line = card.createDiv({ cls: `lmd-db-board-card-property is-${field.type}` });
          line.createSpan({ cls: "lmd-db-board-card-property-name", text: `${field.name || field.id}:` });
          const valueHost = line.createDiv({ cls: "lmd-db-board-card-property-value" });
          if (field.type === "multi-select") {
            valueHost.addClass("lmd-db-multiselect-chips");
            const values = Array.isArray(value) ? value.map(String) : [String(value)];
            for (const item of values) valueHost.createSpan({ cls: this.chipClassFor(field, item), text: item });
          } else if (field.type === "relation") {
            valueHost.addClass("lmd-db-relation-chips");
            const values = Array.isArray(value) ? value : [value];
            for (const raw of values) {
              const target = stripWikiLink(raw);
              const resolved = this.resolveRelationFile(target, entry.file.path);
              const label = resolved?.basename || pathBasenameNoExt(target);
              const chip = valueHost.createEl("button", { cls: "lmd-db-relation-chip", text: label, attr: { type: "button" } });
              chip.title = resolved?.path || target;
              chip.draggable = false;
              chip.addEventListener("pointerdown", (event) => event.stopPropagation());
              chip.addEventListener("click", (event) => {
                event.preventDefault(); event.stopPropagation();
                const link = resolved ? stripMdExtension(resolved.path) : target;
                void this.app.workspace.openLinkText(link, entry.file.path, false);
              });
            }
          } else if (field.type === "text") {
            valueHost.addClass("lmd-db-board-markdown");
            void MarkdownRenderer.render(this.app, prepareMarkdownForCell(formatProperty(value)), valueHost, entry.file.path, this)
              .catch(() => valueHost.setText(formatProperty(value)));
          } else {
            valueHost.setText(formatProperty(value));
          }
        }
        card.addEventListener("dblclick", () => void this.openDatabaseItem(entry.file, databaseFile));
        card.addEventListener("dragstart", (event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/lmd-board-card", entry.file.path);
          event.dataTransfer.setData("text/lmd-board-source", entry.sourceGroup);
          card.addClass("is-dragging");
          document.body.addClass("lmd-db-is-board-dragging");
          clearNativeSelection();
        });
        card.addEventListener("dragend", () => { card.removeClass("is-dragging"); clearBoardDragVisuals(); });
      }

      const addCard = body.createEl("button", { cls: "lmd-db-board-add-card", text: "+ 新增資料列" });
      addCard.addEventListener("click", () => {
        if (group === UNGROUPED) {
          void this.createRow(source);
          return;
        }
        const initialValue = (groupField.type === "multi-select" || groupField.type === "relation") ? [group] : group;
        void this.createRowForView(source, view, schema, groupField, initialValue);
      });
    };
    for (const group of groups) renderColumn(group);

    const addGroup = board.createEl("button", { cls: "lmd-db-board-add-group", text: "+ 新增分組" });
    addGroup.addEventListener("click", () => {
      new ViewNameModal(this.app, "新增 Board 分組", "新分組", async (name) => {
        if (!view.boardGroupOrder.includes(name)) view.boardGroupOrder.push(name);
        await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile);
      }).open();
    });
    this.contentEl.createDiv({ cls: "lmd-db-footer", text: `${files.length} / ${rawFiles.length} 筆資料 · Board 依「${groupField.name || groupField.id}」分組` });
  }

  createCellEditor(td, file, field, currentValue) {
    // A table cell owns exactly one editor. Keeping this invariant prevents the
    // occasional post-schema-change "two inputs inside one cell" regression.
    td.empty();
    if (field.type === "relation") { this.createRelationCell(td, file, field, currentValue); return; }
    if (field.type === "single-select") { this.createSingleSelectCell(td, file, field, currentValue); return; }
    if (field.type === "multi-select") { this.createMultiSelectCell(td, file, field, currentValue); return; }
    if (field.type === "text") { this.createTextCell(td, file, field, currentValue); return; }
    if (field.type === "checkbox") {
      td.addClass("lmd-db-checkbox-cell");
      const hierarchical = field.hierarchicalProgress === true;
      const scope = field.hierarchyProgressScope === "direct" ? "direct" : "descendants";
      const itemId = hierarchical ? this.getStableItemId(file) : "";
      const cachedStats = hierarchical ? this._hierarchicalProgressCache?.get(field.id) : null;
      const stats = hierarchical ? (cachedStats || this.getHierarchyProgressStats(this.collectDatabaseSourceFiles(this.definition), field, scope)) : new Map();
      const stat = itemId ? stats.get(itemId) : null;
      let checked = currentValue === true || String(currentValue).toLocaleLowerCase() === "true";
      let indeterminate = !!(hierarchical && stat && stat.done > 0 && stat.done < stat.total);
      if (hierarchical && stat) checked = stat.done === stat.total && stat.total > 0;
      const host = td.createDiv({ cls: hierarchical ? "lmd-db-hierarchical-checkbox-cell" : "lmd-db-checkbox-cell-inner" });
      const checkbox = host.createEl("button", { cls: "lmd-db-checkbox-button", attr: { type: "button", role: "checkbox", "aria-label": field.name || field.id, "aria-checked": indeterminate ? "mixed" : (checked ? "true" : "false") } });
      const paintCheckbox = () => {
        checkbox.empty();
        checkbox.toggleClass("is-checked", checked && !indeterminate);
        checkbox.toggleClass("is-indeterminate", indeterminate);
        checkbox.setAttribute("aria-checked", indeterminate ? "mixed" : (checked ? "true" : "false"));
        if (indeterminate) setIcon(checkbox, "minus"); else if (checked) setIcon(checkbox, "check");
      };
      paintCheckbox();
      if (hierarchical && stat) {
        const progress = host.createDiv({ cls: "lmd-db-hierarchy-progress", attr: { title: `${stat.done} / ${stat.total} 完成`, "aria-label": `子項目進度 ${stat.done} / ${stat.total}，${stat.percent}%` } });
        progress.createSpan({ cls: "lmd-db-hierarchy-progress-text", text: `${stat.done}/${stat.total} · ${stat.percent}%` });
        const track = progress.createSpan({ cls: "lmd-db-hierarchy-progress-track" });
        const fill = track.createSpan({ cls: "lmd-db-hierarchy-progress-fill" });
        fill.style.width = `${stat.percent}%`;
      }
      checkbox.addEventListener("pointerdown", (event) => event.stopPropagation());
      checkbox.addEventListener("click", async (event) => {
        event.preventDefault(); event.stopPropagation();
        if (hierarchical) {
          const next = !(checked && !indeterminate);
          const ok = await this.writeHierarchicalCheckbox(file, field, next);
          if (ok) await this.loadAndRender(this.databaseFile);
          return;
        }
        const previous = checked; checked = !checked; paintCheckbox();
        const ok = await this.writeProperty(file, field, checked);
        if (!ok) { checked = previous; paintCheckbox(); }
        else await this.refreshTableIfFilterAffected(file, field);
      });
      return;
    }
    td.toggleClass("is-wrap", this.currentViewWrap === true);
    td.toggleClass("is-truncate", this.currentViewWrap !== true);
    if (field.type === "date") { this.createDateCell(td, file, field, currentValue); return; }
    const input = td.createEl("input", { cls: "lmd-db-cell-input" });
    input.dataset.fieldType = field.type;
    if (field.type === "number") {
      // Native desktop IMEs can consume numeric keys before a normal editable
      // input receives usable characters. Keep the visible editor readonly so
      // the IME never owns its composition target, then apply physical numeric
      // keys ourselves. writeProperty() still validates/stores a real Number.
      input.type = "text";
      input.inputMode = "decimal";
      input.readOnly = true;
      input.setAttribute("lang", "en");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("autocorrect", "off");
      input.setAttribute("spellcheck", "false");
      input.addClass("lmd-db-number-input");

      const selection = () => {
        const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
        const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : start;
        return [start, end];
      };
      const isValidDraft = (value) => value === "" || value === "-" || value === "." || value === "-." || /^-?\d*(?:\.\d*)?$/.test(value);
      const replaceRange = (text, start, end) => {
        const candidate = input.value.slice(0, start) + text + input.value.slice(end);
        if (!isValidDraft(candidate)) return false;
        input.value = candidate;
        const caret = start + text.length;
        try { input.setSelectionRange(caret, caret); } catch (_) {}
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      const deleteRange = (backward) => {
        let [start, end] = selection();
        if (start === end) {
          if (backward && start > 0) start -= 1;
          else if (!backward && end < input.value.length) end += 1;
          else return;
        }
        replaceRange("", start, end);
      };
      const numericKeyCapture = (event) => {
        if (document.activeElement !== input) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key?.toLowerCase() === "a") {
          event.preventDefault(); event.stopPropagation();
          try { input.setSelectionRange(0, input.value.length); } catch (_) {}
          return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        let text = "";
        if (/^Digit[0-9]$/.test(event.code)) text = event.code.slice(-1);
        else if (/^Numpad[0-9]$/.test(event.code)) text = event.code.slice(-1);
        else if (event.code === "Period" || event.code === "NumpadDecimal") text = ".";
        else if (event.code === "Minus" || event.code === "NumpadSubtract") text = "-";
        if (text) {
          event.preventDefault(); event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
          const [start, end] = selection();
          if (text === "-" && start !== 0) return;
          replaceRange(text, start, end);
          return;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault(); event.stopPropagation();
          deleteRange(event.key === "Backspace");
          return;
        }
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const [start, end] = selection();
          let next = end;
          if (event.key === "ArrowLeft") next = Math.max(0, start - (start === end ? 1 : 0));
          if (event.key === "ArrowRight") next = Math.min(input.value.length, end + (start === end ? 1 : 0));
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = input.value.length;
          try { input.setSelectionRange(next, next); } catch (_) {}
        }
      };
      input.addEventListener("keydown", numericKeyCapture, true);
      input.addEventListener("paste", (event) => {
        const text = String(event.clipboardData?.getData("text/plain") || "").trim();
        if (!text) return;
        event.preventDefault(); event.stopPropagation();
        const [start, end] = selection();
        replaceRange(text, start, end);
      });
      input.addEventListener("dblclick", () => { try { input.setSelectionRange(0, input.value.length); } catch (_) {} });
    } else input.type = "text";
    input.value = formatProperty(currentValue);
    input.placeholder = "";
    let initial = input.value;
    let isComposing = false;
    const commit = async () => {
      if (isComposing) return;
      if (input.value === initial) return;
      const ok = await this.writeProperty(file, field, input.value);
      if (ok) { initial = input.value; await this.refreshTableIfFilterAffected(file, field); } else input.value = initial;
    };
    input.addEventListener("focus", () => this.beginEditorSession());
    input.addEventListener("compositionstart", () => { isComposing = true; this.beginCompositionSession(); });
    input.addEventListener("compositionend", () => { isComposing = false; this.endCompositionSession(); });
    input.addEventListener("change", () => void commit());
    input.addEventListener("blur", () => { void commit(); this.endEditorSession(); });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") { input.value = initial; input.blur(); }
    });
  }


  createDateCell(td, file, field, currentValue) {
    td.addClass("lmd-db-date-cell");
    let raw = formatProperty(currentValue).trim();
    const button = td.createEl("button", { cls:"lmd-db-date-cell-button", attr:{type:"button"} });
    const refreshButton = () => { button.setText(dateRangeDisplay(raw)); button.toggleClass("is-empty", !raw); };
    refreshButton();
    button.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      document.querySelectorAll(".lmd-db-date-popover").forEach((el)=>el.remove());
      const state = parseDateRangeValue(raw);
      const today = new Date();
      if (!state.startDate) state.startDate = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
      state.hasTime = !!state.hasTime;
      state.hasEnd = !!state.hasEnd;
      let activeSide = "start";
      let calendarCursor = (() => { const [y,m] = state.startDate.split("-").map(Number); return new Date(y, (m||1)-1, 1); })();
      const anchorPoint = { x:event.clientX, y:event.clientY };

      const pop = document.body.createDiv({ cls:"lmd-db-date-popover" });
      pop.addEventListener("click", (e)=>e.stopPropagation());
      pop.createDiv({ cls:"lmd-db-date-popover-title", text:field.name || field.id });

      const startSection = pop.createDiv({cls:"lmd-db-date-section is-active"});
      startSection.createDiv({cls:"lmd-db-date-section-label", text:"開始"});
      const startDateRow = startSection.createDiv({cls:"lmd-db-date-value-row"});
      const startDateText = startDateRow.createEl("input", {cls:"lmd-db-date-text", attr:{type:"text", inputmode:"numeric", placeholder:"YYYY-MM-DD"}});
      startDateText.value = state.startDate;
      const startTime = startDateRow.createEl("input", {cls:"lmd-db-date-time", attr:{type:"time"}});
      startTime.value = state.startTime || "09:00";
      startTime.toggleClass("is-hidden", !state.hasTime);

      // End belongs directly under Start. The toggle only decides whether this block exists.
      const endSection = pop.createDiv({cls:"lmd-db-date-section lmd-db-date-end-section"});
      endSection.createDiv({cls:"lmd-db-date-section-label", text:"結束"});
      const endDateRow = endSection.createDiv({cls:"lmd-db-date-value-row"});
      const endDateText = endDateRow.createEl("input", {cls:"lmd-db-date-text", attr:{type:"text", inputmode:"numeric", placeholder:"YYYY-MM-DD"}});
      endDateText.value = state.endDate || state.startDate;
      const endTime = endDateRow.createEl("input", {cls:"lmd-db-date-time", attr:{type:"time"}});
      endTime.value = state.endTime || state.startTime || "10:00";

      const calendar = pop.createDiv({cls:"lmd-db-date-calendar"});
      const calHeader = calendar.createDiv({cls:"lmd-db-date-calendar-header"});
      const prev = calHeader.createEl("button", {text:"‹", attr:{type:"button", "aria-label":"上個月"}});
      const monthLabel = calHeader.createDiv({cls:"lmd-db-date-calendar-month"});
      const next = calHeader.createEl("button", {text:"›", attr:{type:"button", "aria-label":"下個月"}});
      const week = calendar.createDiv({cls:"lmd-db-date-calendar-week"});
      ["一","二","三","四","五","六","日"].forEach((d)=>week.createSpan({text:d}));
      const days = calendar.createDiv({cls:"lmd-db-date-calendar-days"});

      const options = pop.createDiv({cls:"lmd-db-date-options"});
      const timeToggleRow = options.createEl("label", {cls:"lmd-db-date-toggle-row"});
      const timeCheck = timeToggleRow.createEl("input"); timeCheck.type="checkbox"; timeCheck.checked=state.hasTime;
      timeToggleRow.createSpan({text:"包含時間"});
      const endToggleRow = options.createEl("label", {cls:"lmd-db-date-toggle-row"});
      const endCheck = endToggleRow.createEl("input"); endCheck.type="checkbox"; endCheck.checked=state.hasEnd;
      endToggleRow.createSpan({text:"結束日期"});

      const actions=pop.createDiv({cls:"lmd-db-date-popover-actions"});
      const clear=actions.createEl("button",{text:"清除",attr:{type:"button"}});
      const todayBtn=actions.createEl("button",{text:"今天",attr:{type:"button"}});
      const done=actions.createEl("button",{text:"完成",cls:"mod-cta",attr:{type:"button"}});

      const parseTypedDate = (text) => {
        const t=String(text||"").trim().replace(/[/.]/g,"-");
        const m=t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if(!m)return "";
        const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
        const dt=new Date(y,mo-1,d);
        if(dt.getFullYear()!==y||dt.getMonth()!==mo-1||dt.getDate()!==d)return "";
        return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      };
      const save = async () => {
        if(!state.hasTime){ state.startTime=""; state.endTime=""; }
        if(!state.hasEnd){ state.endDate=""; state.endTime=""; }
        const next=state.startDate?formatDateRangeValue(state):"";
        const ok=await this.writeProperty(file,field,next);
        if(ok){raw=next;refreshButton();}
      };
      const currentZoom = () => {
        const host = td.closest(".lmd-db-table, .lmd-db-board, .lmd-db-calendar, .lmd-db-calendar-year, .lmd-db-calendar-week, .lmd-db-calendar-day-view");
        const rawZoom = host ? (host.style.zoom || getComputedStyle(host).zoom || "1") : "1";
        const z = Number(rawZoom);
        return Number.isFinite(z) ? Math.max(0.5, Math.min(1.6, z)) : 1;
      };
      const place = () => {
        if(!pop.isConnected)return;
        pop.style.zoom=String(currentZoom());
        // Measure after zoom so the visible size is what is kept inside the Obsidian window.
        const pr=pop.getBoundingClientRect();
        const gap=8;
        let left=anchorPoint.x;
        if(left+pr.width>window.innerWidth-gap) left=Math.max(gap,window.innerWidth-pr.width-gap);
        if(left<gap) left=gap;
        const roomBelow=window.innerHeight-anchorPoint.y-gap;
        const roomAbove=anchorPoint.y-gap;
        let top;
        if(roomBelow>=pr.height || roomBelow>=roomAbove) top=Math.min(window.innerHeight-pr.height-gap,anchorPoint.y+gap);
        else top=Math.max(gap,anchorPoint.y-pr.height-gap);
        pop.style.left=`${Math.round(left)}px`; pop.style.top=`${Math.round(top)}px`;
      };
      const setActiveSide = (side) => {
        activeSide = side === "end" && state.hasEnd ? "end" : "start";
        startSection.toggleClass("is-active",activeSide==="start");
        endSection.toggleClass("is-active",activeSide==="end");
        const date = activeSide==="end" ? (state.endDate || state.startDate) : state.startDate;
        if(date){ const [y,m]=date.split("-").map(Number); calendarCursor=new Date(y,(m||1)-1,1); }
        renderCalendar();
      };
      const syncVisibility = () => {
        startTime.toggleClass("is-hidden", !state.hasTime);
        endSection.toggleClass("is-hidden", !state.hasEnd);
        endTime.toggleClass("is-hidden", !(state.hasEnd && state.hasTime));
        if(state.hasEnd) endDateText.value = state.endDate || state.startDate;
        if(!state.hasEnd && activeSide==="end") activeSide="start";
        startSection.toggleClass("is-active",activeSide==="start");
        endSection.toggleClass("is-active",activeSide==="end");
        requestAnimationFrame(place);
      };
      const renderCalendar = () => {
        monthLabel.setText(`${calendarCursor.getFullYear()}年 ${calendarCursor.getMonth()+1}月`);
        days.empty();
        const first=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth(),1);
        const offset=(first.getDay()+6)%7;
        const gridStart=new Date(first); gridStart.setDate(first.getDate()-offset);
        const selectedDate=activeSide==="end" && state.hasEnd ? (state.endDate || state.startDate) : state.startDate;
        for(let i=0;i<42;i++){
          const d=new Date(gridStart); d.setDate(gridStart.getDate()+i);
          const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
          const b=days.createEl("button",{text:String(d.getDate()),cls:"lmd-db-date-calendar-day",attr:{type:"button"}});
          if(d.getMonth()!==calendarCursor.getMonth())b.addClass("is-outside");
          if(key===selectedDate)b.addClass("is-selected");
          if(key===`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`)b.addClass("is-today");
          b.addEventListener("click",async()=>{
            if(activeSide==="end" && state.hasEnd){ state.endDate=key; endDateText.value=key; }
            else { state.startDate=key; startDateText.value=key; }
            calendarCursor=new Date(d.getFullYear(),d.getMonth(),1); renderCalendar(); await save();
          });
        }
      };
      prev.addEventListener("click",()=>{calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()-1,1);renderCalendar();});
      next.addEventListener("click",()=>{calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth()+1,1);renderCalendar();});
      [startSection,startDateText,startTime].forEach((el)=>el.addEventListener("pointerdown",()=>setActiveSide("start")));
      [endSection,endDateText,endTime].forEach((el)=>el.addEventListener("pointerdown",()=>{if(state.hasEnd)setActiveSide("end");}));
      startDateText.addEventListener("change",async()=>{const key=parseTypedDate(startDateText.value);if(!key){startDateText.value=state.startDate;return;}state.startDate=key;const [y,m]=key.split("-").map(Number);calendarCursor=new Date(y,m-1,1);renderCalendar();await save();});
      startTime.addEventListener("change",async()=>{state.startTime=startTime.value||"09:00";await save();});
      timeCheck.addEventListener("change",async()=>{state.hasTime=timeCheck.checked;if(state.hasTime){state.startTime=startTime.value||"09:00";if(state.hasEnd)state.endTime=endTime.value||state.startTime;}syncVisibility();await save();});
      endCheck.addEventListener("change",async()=>{state.hasEnd=endCheck.checked;if(state.hasEnd){state.endDate=state.endDate||state.startDate;if(state.hasTime)state.endTime=endTime.value||state.startTime||"10:00";}else activeSide="start";syncVisibility();renderCalendar();await save();});
      endDateText.addEventListener("change",async()=>{const key=parseTypedDate(endDateText.value);if(!key){endDateText.value=state.endDate||state.startDate;return;}state.endDate=key;const [y,m]=key.split("-").map(Number);calendarCursor=new Date(y,m-1,1);renderCalendar();await save();});
      endTime.addEventListener("change",async()=>{state.endTime=endTime.value||state.startTime||"10:00";await save();});
      clear.addEventListener("click",async()=>{state.startDate="";state.startTime="";state.endDate="";state.endTime="";state.hasEnd=false;state.hasTime=false;await save();pop.remove();});
      todayBtn.addEventListener("click",async()=>{const key=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;if(activeSide==="end"&&state.hasEnd){state.endDate=key;endDateText.value=key;}else{state.startDate=key;startDateText.value=key;}calendarCursor=new Date(today.getFullYear(),today.getMonth(),1);renderCalendar();await save();});
      done.addEventListener("click",()=>pop.remove());
      renderCalendar();syncVisibility();requestAnimationFrame(place);
      const zoomWatch=(e)=>{if(e.ctrlKey||e.metaKey)setTimeout(()=>{if(pop.isConnected)place();},0);};
      document.addEventListener("wheel",zoomWatch,true);
      const outside=(e)=>{if(pop.isConnected&&!pop.contains(e.target)&&e.target!==button){pop.remove();document.removeEventListener("pointerdown",outside,true);document.removeEventListener("wheel",zoomWatch,true);}};
      setTimeout(()=>document.addEventListener("pointerdown",outside,true),0);
    });
  }


  getCommonAggregateSchema(entries) {
    if (!entries.length) return [];
    const schemaSets = entries.map((entry) => {
      const schema = this.getEffectiveSchema(entry.definition, entry.files);
      return new Map(schema.map((field) => [field.id, field]));
    });
    const first = schemaSets[0];
    const common = [];
    for (const [id, field] of first.entries()) {
      let ok = true;
      for (let i = 1; i < schemaSets.length; i++) {
        const other = schemaSets[i].get(id);
        if (!other || other.type !== field.type) { ok = false; break; }
      }
      if (ok) common.push(JSON.parse(JSON.stringify(field)));
    }
    return common;
  }

  async resolveAggregateSource(databaseFile, definition) {
    const entries = [];
    const missing = [];
    const nested = [];
    for (const rawPath of definition.source?.paths || []) {
      const path = normalizePath(rawPath || "");
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension !== DATABASE_EXTENSION) { missing.push(path); continue; }
      const childDefinition = await this.plugin.readDatabaseDefinition(file);
      if (!childDefinition) { missing.push(path); continue; }
      if (childDefinition.source?.type !== "folder") { nested.push(path); continue; }
      const sourcePath = normalizePath(childDefinition.source.path || "");
      let folder = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : this.app.vault.getRoot();
      if (!(folder instanceof TFolder) && sourcePath) folder = await this.plugin.recoverMovedSource(file, childDefinition, sourcePath);
      if (!(folder instanceof TFolder)) { missing.push(path); continue; }
      const files = this.collectMarkdownFiles(folder);
      entries.push({ databaseFile: file, definition: childDefinition, folder, files, label: childDefinition.name || file.basename });
    }
    const seen = new Set();
    const rawFiles = [];
    for (const entry of entries) for (const file of entry.files) if (!seen.has(file.path)) { seen.add(file.path); rawFiles.push(file); }
    const schema = this.getCommonAggregateSchema(entries);
    const source = {
      __lmdAggregate: true,
      targets: entries.map((entry) => ({ folder: entry.folder, databaseFile: entry.databaseFile, label: entry.label })),
      entries,
    };
    return { source, rawFiles, schema, entries, missing, nested };
  }

  inferManagedSource(databaseFile, definition) {
    if (definition?.source?.managed === true) return true;
    if (definition?.source?.managed === false) return false;
    const sourcePath = normalizePath(definition?.source?.path || "");
    if (!sourcePath) return false;
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFolder)) return false;
    const dbParent = databaseFile.parent?.path || "";
    const sourceParent = source.parent?.path || "";
    const oldName = String(definition?.name || databaseFile.basename || "");
    return dbParent === sourceParent && (source.name === oldName || source.name === databaseFile.basename);
  }

  async renameDatabase(databaseFile, definition, requestedName) {
    const cleanName = sanitizeFileName(requestedName);
    if (!cleanName) return false;
    const oldDbPath = databaseFile.path;
    const oldName = definition.name || databaseFile.basename;
    const parentPath = databaseFile.parent?.path || "";
    const newDbPath = normalizePath(parentPath ? `${parentPath}/${cleanName}.database` : `${cleanName}.database`);
    const isFolderSource = definition.source?.type === "folder";
    const managed = isFolderSource ? this.inferManagedSource(databaseFile, definition) : false;
    let source = isFolderSource ? this.app.vault.getAbstractFileByPath(normalizePath(definition.source.path || "")) : null;
    let newSourcePath = isFolderSource ? definition.source.path : null;

    if (newDbPath !== oldDbPath) {
      const existing = this.app.vault.getAbstractFileByPath(newDbPath);
      if (existing && existing !== databaseFile) { new Notice("Database 改名失敗：同名檔案已存在。"); return false; }
    }

    try {
      if (managed && source instanceof TFolder) {
        const sourceParent = source.parent?.path || "";
        const wantedFolderPath = normalizePath(sourceParent ? `${sourceParent}/${cleanName}` : cleanName);
        if (wantedFolderPath !== source.path) {
          const existingFolder = this.app.vault.getAbstractFileByPath(wantedFolderPath);
          if (existingFolder && existingFolder !== source) {
            new Notice("Database 改名失敗：同名資料資料夾已存在。");
            return false;
          }
          await this.app.vault.rename(source, wantedFolderPath);
          newSourcePath = wantedFolderPath;
        }
      }
      definition.name = cleanName;
      if (isFolderSource) {
        definition.source.managed = managed;
        definition.source.path = newSourcePath;
      }
      await this.saveDefinition(databaseFile, definition);
      if (newDbPath !== oldDbPath) await this.app.fileManager.renameFile(databaseFile, newDbPath);
      new Notice(managed ? `Database 已改名為 ${cleanName}，資料資料夾已同步。` : `Database 已改名為 ${cleanName}。`);
      return true;
    } catch (error) {
      console.error("Local Markdown Database: database rename failed", error);
      new Notice("Database 改名失敗。請查看開發者主控台。");
      definition.name = oldName;
      return false;
    }
  }

  async renderDatabase(databaseFile, definition) {
    const header = this.contentEl.createDiv({ cls: `lmd-db-header${this.isEmbedded ? " lmd-db-embedded-hidden" : ""}` });
    const titleRow = header.createDiv({ cls: "lmd-db-title-row" });
    const titleInput = titleRow.createEl("input", { cls: "lmd-db-title-input", attr: { type: "text", "aria-label": "Database 名稱" } });
    titleInput.value = definition.name || databaseFile.basename;
    let titleInitial = titleInput.value;
    let titleCommitRunning = false;
    const commitDatabaseTitle = async () => {
      if (titleCommitRunning) return;
      const wanted = titleInput.value.trim();
      if (!wanted || wanted === titleInitial) { titleInput.value = titleInitial; return; }
      titleCommitRunning = true;
      try {
        const ok = await this.renameDatabase(databaseFile, definition, wanted);
        if (ok) { titleInitial = wanted; titleInput.value = wanted; await this.loadAndRender(databaseFile); return; }
        titleInput.value = titleInitial;
      } finally { titleCommitRunning = false; }
    };
    titleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); titleInput.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); titleInput.value = titleInitial; titleInput.blur(); }
    });
    titleInput.addEventListener("blur", () => void commitDatabaseTitle());

    const headerActions = titleRow.createDiv({ cls: "lmd-db-header-actions" });
    let source;
    let rawFiles;
    let schema;
    if (definition.source?.type === "database-set") {
      const sourceButton = headerActions.createEl("button", { text: "管理來源" });
      sourceButton.addEventListener("click", () => {
        new AggregateSourceModal(this.app, databaseFile.path, definition.source.paths || [], async (paths) => {
          definition.source.paths = Array.from(new Set(paths.map((path) => normalizePath(path)).filter(Boolean)));
          await this.saveDefinition(databaseFile, definition);
          await this.loadAndRender(databaseFile);
        }).open();
      });
      const aggregate = await this.resolveAggregateSource(databaseFile, definition);
      source = aggregate.source;
      rawFiles = aggregate.rawFiles;
      schema = aggregate.schema;
      const subtitle = header.createDiv({ cls: "lmd-db-subtitle" });
      subtitle.setText(`聚合資料來源：${aggregate.entries.length} 個 Database · ${rawFiles.length} 筆 Markdown`);
      if (aggregate.missing.length) subtitle.createSpan({ text: ` · ${aggregate.missing.length} 個來源失效`, cls: "lmd-db-aggregate-warning" });
      if (aggregate.nested.length) subtitle.createSpan({ text: ` · ${aggregate.nested.length} 個聚合來源已略過`, cls: "lmd-db-aggregate-warning" });
      if (!aggregate.entries.length) {
        this.contentEl.createDiv({ cls: "lmd-db-empty-state", text: "目前沒有可讀取的原始 Database。點「管理來源」加入資料來源。" });
      }
    } else {
      const sourceButton = headerActions.createEl("button", { text: "變更資料夾" });
      sourceButton.addEventListener("click", () => {
        new FolderPickerModal(this.app, definition.source.path, async (path) => {
          await this.updateSource(databaseFile, definition, path);
        }).open();
      });
      header.createDiv({ cls: "lmd-db-subtitle", text: `資料來源：${definition.source.path || "/（Vault 根目錄）"}` });
      const sourcePath = normalizePath(definition.source.path || "");
      source = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : this.app.vault.getRoot();
      if (!(source instanceof TFolder) && sourcePath) {
        const recovered = await this.plugin.recoverMovedSource(databaseFile, definition, sourcePath);
        if (recovered) source = recovered;
      }
      if (!(source instanceof TFolder)) {
        this.renderError("找不到資料來源資料夾。", definition.source.path || "/");
        return;
      }
      if (definition.source?.managed === true) await this.plugin.ensureManagedSourceMarker(databaseFile, definition, source);
      rawFiles = this.collectMarkdownFiles(source);
      schema = this.getEffectiveSchema(definition, rawFiles);
    }
    await this.normalizeRelationAliases(rawFiles, schema);
    await this.ensureSelectOptionRegistries(databaseFile, definition, rawFiles, schema);
    const canvasMetaChanged = await this.ensureStableItemIds(rawFiles);
    const view = this.ensureViewState(definition, schema);
    let manualOrderMigrated = canvasMetaChanged === true;
    for (const state of this.getAllViewStates(definition)) {
      if (!Array.isArray(state.manualOrder)) state.manualOrder = [];
      const next = this.migrateManualOrderToStableIds(state.manualOrder, rawFiles);
      if (JSON.stringify(next) !== JSON.stringify(state.manualOrder)) {
        state.manualOrder = next;
        manualOrderMigrated = true;
      }
    }
    let manualFiles = this.orderFiles(rawFiles, view.manualOrder);
    const persistedManualOrder = manualFiles.map((file) => this.getStableItemId(file)).filter(Boolean);
    if (JSON.stringify(persistedManualOrder) !== JSON.stringify(view.manualOrder)) {
      view.manualOrder = persistedManualOrder;
      manualOrderMigrated = true;
    }
    if (manualOrderMigrated) await this.saveDefinition(databaseFile, definition);

    // Version Lineage default projection: history is not a second set of ordinary rows.
    // Keep every source file in storage/manual-order metadata, but normal Database and Embed
    // views show only unversioned items plus the family member explicitly marked current.
    rawFiles = rawFiles.filter((file) => this.isDefaultVisibleVersionItem(file));
    manualFiles = manualFiles.filter((file) => this.isDefaultVisibleVersionItem(file));

    const activeViewEntry = definition.views.find((entry) => entry.id === definition.activeViewId) || definition.views[0];
    const viewBar = this.contentEl.createDiv({ cls: this.isEmbedded ? "lmd-db-view-bar lmd-db-embed-view-bar" : "lmd-db-view-bar" });
    const viewTabs = viewBar.createDiv({ cls: this.isEmbedded ? "lmd-db-view-tabs lmd-db-embed-view-tabs" : "lmd-db-view-tabs" });

    const saveStructureAndRender = async () => {
      await this.saveViewStructure(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };
    const switchView = async (entry) => {
      if (!entry || entry.id === definition.activeViewId) return;
      if (this.isEmbedded === true) {
        await this.saveDefinition(databaseFile, definition);
        definition.activeViewId = entry.id;
        await this.applyEmbeddedViewState(definition, entry.id);
        if (entry.type === "calendar" && /^\d{4}-\d{2}-\d{2}$/.test(entry.state?.calendarFocusDate || "")) {
          entry.state.calendarAnchor = entry.state.calendarFocusDate;
          entry.state.calendarMonth = entry.state.calendarFocusDate.slice(0, 7);
        }
        if (this.embedInstancePrefix && this.plugin?.saveEmbeddedActiveView) await this.plugin.saveEmbeddedActiveView(this.embedInstancePrefix, entry.id);
        await this.loadAndRender(databaseFile);
        return;
      }
      definition.activeViewId = entry.id;
      if (entry.type === "calendar" && /^\d{4}-\d{2}-\d{2}$/.test(entry.state?.calendarFocusDate || "")) {
        entry.state.calendarAnchor = entry.state.calendarFocusDate;
        entry.state.calendarMonth = entry.state.calendarFocusDate.slice(0, 7);
      }
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };

    const openViewContextMenu = (entry, event) => {
      event.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("重新命名 View").setIcon("pencil").onClick(() => {
        const oldName = entry.name;
        new ViewNameModal(this.app, "重新命名 View", entry.name, async (name) => {
          entry.name = name;
          await this.saveViewStructure(databaseFile, definition);
          if (this.isEmbedded !== true) {
            await this.plugin?.rewriteEmbeddedViewReferences?.(databaseFile, definition.id || "", entry.id, oldName, name);
          }
          await this.loadAndRender(databaseFile);
        }).open();
      }));
      if (entry.type === "board") {
        menu.addItem((item) => item.setTitle("設定 Board 分組").setIcon("columns-3").onClick(() => {
          new BoardGroupFieldModal(this.app, schema, entry.state?.boardGroupBy || "", async (fieldId) => {
            entry.state.boardGroupBy = fieldId; entry.state.boardGroupOrder = [];
            await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile);
          }).open();
        }));
      }
      if (entry.type === "calendar" || entry.type === "timeline") {
        menu.addItem((item) => item.setTitle(`設定 ${entry.type === "timeline" ? "Timeline" : "Calendar"} 日期欄位`).setIcon("calendar-days").onClick(() => {
          const dateFields = schema.filter((field) => field.type === "date");
          if (!dateFields.length) { new Notice("目前沒有 date property。"); return; }
          const picker = new Menu();
          for (const field of dateFields) picker.addItem((sub) => sub.setTitle(field.name || field.id).setChecked((entry.type === "timeline" ? entry.state?.timelineDateField : entry.state?.calendarDateField) === field.id).onClick(async () => {
            if (entry.type === "timeline") entry.state.timelineDateField = field.id; else entry.state.calendarDateField = field.id;
            await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile);
          }));
          const rect = this.containerEl.getBoundingClientRect();
          picker.showAtPosition({ x: rect.left + 200, y: rect.top + 120 });
        }));
      }
      menu.addItem((item) => item.setTitle("複製 View").setIcon("copy").onClick(async () => {
        const clonedState = JSON.parse(JSON.stringify(entry.state || {}));
        const id = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        definition.views.push({ id, name: `${entry.name} 複本`, type: ["board", "calendar", "timeline"].includes(entry.type) ? entry.type : "table", state: clonedState });
        definition.activeViewId = id;
        await this.saveViewStructure(databaseFile, definition);
        if (this.isEmbedded && this.embedInstancePrefix && this.plugin?.saveEmbeddedActiveView) await this.plugin.saveEmbeddedActiveView(this.embedInstancePrefix, id);
        await this.loadAndRender(databaseFile);
      }));
      if (definition.views.length > 1) {
        menu.addItem((item) => item.setTitle("刪除 View").setIcon("trash-2").onClick(async () => {
          definition.views = definition.views.filter((candidate) => candidate.id !== entry.id);
          if (definition.activeViewId === entry.id) definition.activeViewId = definition.views[0].id;
          await this.saveViewStructure(databaseFile, definition);
          if (this.isEmbedded && this.embedInstancePrefix && this.plugin?.saveEmbeddedActiveView) await this.plugin.saveEmbeddedActiveView(this.embedInstancePrefix, definition.activeViewId);
          await this.loadAndRender(databaseFile);
        }));
      }
      menu.showAtMouseEvent(event);
    };

    const createViewTab = (entry) => {
      const tab = viewTabs.createEl("button", { cls: "lmd-db-view-tab", text: entry.name });
      tab.draggable = true;
      tab.dataset.viewId = entry.id;
      if (entry.id === definition.activeViewId) tab.addClass("is-active");
      tab.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/lmd-view-tab", entry.id); tab.addClass("is-dragging");
      });
      tab.addEventListener("dragend", () => { tab.removeClass("is-dragging"); for (const el of viewTabs.querySelectorAll(".is-view-drop-before,.is-view-drop-after")) el.removeClass("is-view-drop-before","is-view-drop-after"); });
      tab.addEventListener("dragover", (event) => {
        if (!event.dataTransfer.types.includes("text/lmd-view-tab")) return; event.preventDefault();
        const rect = tab.getBoundingClientRect(); const after = event.clientX >= rect.left + rect.width / 2;
        tab.toggleClass("is-view-drop-before", !after); tab.toggleClass("is-view-drop-after", after);
      });
      tab.addEventListener("dragleave", () => tab.removeClass("is-view-drop-before", "is-view-drop-after"));
      tab.addEventListener("drop", async (event) => {
        if (!event.dataTransfer.types.includes("text/lmd-view-tab")) return; event.preventDefault(); event.stopPropagation();
        tab.removeClass("is-view-drop-before", "is-view-drop-after");
        const sourceId = event.dataTransfer.getData("text/lmd-view-tab"); if (!sourceId || sourceId === entry.id) return;
        const sourceIndex = definition.views.findIndex((v) => v.id === sourceId); const targetIndex0 = definition.views.findIndex((v) => v.id === entry.id);
        if (sourceIndex < 0 || targetIndex0 < 0) return;
        const rect = tab.getBoundingClientRect(); const after = event.clientX >= rect.left + rect.width / 2;
        const [moved] = definition.views.splice(sourceIndex, 1);
        let targetIndex = definition.views.findIndex((v) => v.id === entry.id); if (after) targetIndex += 1;
        definition.views.splice(Math.max(0, targetIndex), 0, moved);
        await saveStructureAndRender();
      });
      tab.addEventListener("click", () => void switchView(entry));
      tab.addEventListener("contextmenu", (event) => openViewContextMenu(entry, event));
      return tab;
    };

    let inlineViews = definition.views;
    let overflowViews = [];
    if (this.isEmbedded === true) {
      const width = Math.max(360, Number(this.contentEl.clientWidth) || 720);
      const inlineLimit = Math.max(2, Math.min(6, Math.floor((width - 150) / 112)));
      inlineViews = definition.views.slice(0, inlineLimit);
      if (!inlineViews.some((entry) => entry.id === definition.activeViewId) && definition.views.length > inlineLimit) {
        inlineViews = inlineViews.slice(0, Math.max(1, inlineLimit - 1)).concat(activeViewEntry);
      }
      const inlineIds = new Set(inlineViews.map((entry) => entry.id));
      overflowViews = definition.views.filter((entry) => !inlineIds.has(entry.id));
    }
    for (const entry of inlineViews) createViewTab(entry);

    if (overflowViews.length) {
      const moreButton = viewBar.createEl("button", { cls: "lmd-db-view-more", text: "…", attr: { type: "button", title: "更多 View" } });
      moreButton.addEventListener("click", (event) => {
        const menu = new Menu();
        for (const entry of overflowViews) menu.addItem((item) => item.setTitle(entry.name).setChecked(entry.id === definition.activeViewId).onClick(() => void switchView(entry)));
        menu.showAtMouseEvent(event);
      });
    }

    const addViewButton = viewBar.createEl("button", { cls: "lmd-db-add-view", attr: { title: "新增 View", "aria-label": "新增 View" } });
    setIcon(addViewButton, "plus");
    addViewButton.addEventListener("click", () => {
      new CreateViewModal(this.app, schema, async ({ name, type, groupBy, dateField }) => {
        const baseView = definition.views.find((entry) => entry.id === definition.activeViewId)?.state || view;
        const state = JSON.parse(JSON.stringify(baseView));
        state.sort = [];
        state.filters = [];
        state.freezeColumns = 0;
        state.frozenColumnIds = [];
        if (type === "board") {
          state.boardGroupBy = groupBy || schema[0]?.id || "";
          state.boardGroupOrder = [];
          state.boardHiddenGroups = [];
          state.boardCardFields = schema.filter((field) => field.id !== state.boardGroupBy).slice(0, 3).map((field) => field.id);
        } else if (type === "calendar") {
          state.calendarDateField = dateField || schema.find((field) => field.type === "date")?.id || "";
          state.calendarCardFields = schema.filter((field) => field.id !== state.calendarDateField).slice(0, 3).map((field) => field.id);
          const now = new Date();
          state.calendarMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        } else if (type === "timeline") {
          state.timelineDateField = dateField || schema.find((field) => field.type === "date")?.id || "";
          const now = new Date();
          state.timelineStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        }
        const id = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        definition.views.push({ id, name, type, state });
        definition.activeViewId = id;
        await this.saveViewStructure(databaseFile, definition);
        if (this.isEmbedded && this.embedInstancePrefix && this.plugin?.saveEmbeddedActiveView) await this.plugin.saveEmbeddedActiveView(this.embedInstancePrefix, id);
        await this.loadAndRender(databaseFile);
      }).open();
    });

    const miniTools = this.isEmbedded === true ? viewBar.createDiv({ cls: "lmd-db-view-mini-tools lmd-db-embed-mini-tools" }) : this.contentEl.createDiv({ cls: "lmd-db-view-mini-tools" });
    const toolbarToggle = miniTools.createEl("button", { cls: "lmd-db-mini-icon-button", attr: { type: "button", title: view.toolbarCollapsed ? "顯示 View 工具" : "隱藏 View 工具", "aria-label": view.toolbarCollapsed ? "顯示 View 工具" : "隱藏 View 工具" } });
    setIcon(toolbarToggle, view.toolbarCollapsed ? "eye" : "eye-off");
    toolbarToggle.addEventListener("click", async () => {
      view.toolbarCollapsed = !view.toolbarCollapsed;
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    });
    if (this.isEmbedded === true) {
      const backButton = miniTools.createEl("button", { cls: "lmd-db-mini-icon-button", attr: { type: "button", title: "開啟來源 Database", "aria-label": "開啟來源 Database" } });
      setIcon(backButton, "database");
      backButton.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(databaseFile));
      this.installEmbeddedHorizontalWheelRouting(this.contentEl);
    }
    this.contentEl.toggleClass("lmd-db-toolbar-collapsed", view.toolbarCollapsed === true);

    const fieldById = new Map(schema.map((field) => [field.id, field]));
    const allColumns = view.columnOrder.map((id) => id === "file.name"
      ? { id: "file.name", name: view.titleColumnName || "名稱", type: "title" }
      : fieldById.get(id)).filter(Boolean);
    const hiddenColumnIds = new Set(Array.isArray(view.hiddenColumns) ? view.hiddenColumns : []);
    const columns = allColumns.filter((column) => column.id === "file.name" || !hiddenColumnIds.has(column.id));
    let files = this.applySortAndFilters(manualFiles, allColumns, view);
    const hasSort = !!(view.sort && view.sort.length);
    const hasFilter = !!(view.filters && view.filters.length);
    const groupField = view.tableGroupBy ? schema.find((field) => field.id === view.tableGroupBy) : null;
    const hasGrouping = !!groupField;
    const hasParentHierarchy = !hasGrouping && rawFiles.some((candidate) => !!this.getParentItemId(candidate));
    const checkboxFields = schema.filter((field) => field?.type === "checkbox");
    this._hierarchicalProgressCache = new Map();
    if (!hasGrouping) {
      for (const field of checkboxFields) {
        if (field.hierarchicalProgress !== true) continue;
        const scope = field.hierarchyProgressScope === "direct" ? "direct" : "descendants";
        this._hierarchicalProgressCache.set(field.id, this.getHierarchyProgressStats(rawFiles, field, scope));
      }
    }
    const hasSortOrFilter = hasSort || hasFilter;
    let parentDepthByPath = new Map();
    let parentHasChildrenIds = new Set();
    if (!hasGrouping) {
      const hierarchy = this.buildParentHierarchy(files, view);
      files = hierarchy.files;
      parentDepthByPath = hierarchy.depthByPath;
      parentHasChildrenIds = hierarchy.hasChildren;
    }
    this.currentViewWrap = view.wrap === true;

    if (activeViewEntry.type === "board") {
      await this.renderBoardView(databaseFile, definition, activeViewEntry, view, source, rawFiles, schema, columns, files);
      return;
    }
    if (activeViewEntry.type === "calendar") {
      await this.renderCalendarView(databaseFile, definition, activeViewEntry, view, source, rawFiles, schema, columns, files);
      return;
    }
    if (activeViewEntry.type === "timeline") {
      await this.renderTimelineView(databaseFile, definition, activeViewEntry, view, source, rawFiles, schema, columns, files);
      return;
    }

    const toolbar = this.contentEl.createDiv({ cls: "lmd-db-toolbar" });
    const decorateToolbarButton = (button, icon, label, badge = "") => {
      button.addClass("lmd-db-toolbar-button");
      button.empty();
      const iconEl = button.createSpan({ cls: "lmd-db-toolbar-icon" });
      setIcon(iconEl, icon);
      button.createSpan({ cls: "lmd-db-toolbar-label", text: label });
      if (badge) button.createSpan({ cls: "lmd-db-toolbar-badge", text: badge });
      return button;
    };
    const addRowButton = toolbar.createEl("button", { cls: "mod-cta" });
    decorateToolbarButton(addRowButton, "plus", "新增資料列");
    addRowButton.addEventListener("click", () => void this.createRowForView(source, view, schema));
    const addFieldButton = toolbar.createEl("button");
    decorateToolbarButton(addFieldButton, "columns-3", "新增欄位");
    addFieldButton.addEventListener("click", () => {
      if (definition.source?.type === "database-set") {
        new Notice("聚合 Database 0.12.0 暫不直接建立欄位；下一步會加入 Property Mapping。");
        return;
      }
      new AddFieldModal(this.app, schema.map((field) => field.id), databaseFile.path, async (field) => {
        await this.addField(databaseFile, definition, rawFiles, field);
      }).open();
    });

    const wrapButton = toolbar.createEl("button");
    decorateToolbarButton(wrapButton, "wrap-text", "自動換行", view.wrap ? "開" : "關");
    wrapButton.addEventListener("click", async () => {
      view.wrap = !view.wrap;
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    });

    const sortButton = toolbar.createEl("button");
    decorateToolbarButton(sortButton, "arrow-up-down", "排序", view.sort.length ? String(view.sort.length) : "");
    sortButton.addEventListener("click", () => new AddSortModal(this.app, columns, async (rule) => { view.sort.push(rule); await this.saveDefinition(databaseFile, definition); await this.loadAndRender(databaseFile); }).open());
    const filterButton = toolbar.createEl("button");
    decorateToolbarButton(filterButton, "list-filter", "篩選", view.filters.length ? String(view.filters.length) : "");
    filterButton.addEventListener("click", () => new AddFilterModal(this.app, columns, async (rule) => { view.filters.push(rule); await this.saveCurrentViewState(databaseFile, definition); await this.loadAndRender(databaseFile); }, this.buildFilterSuggestions(columns, rawFiles)).open());
    const groupButton = toolbar.createEl("button");
    decorateToolbarButton(groupButton, "layers-3", "分組", groupField ? (groupField.name || groupField.id) : "");
    groupButton.addEventListener("click", () => new TableGroupFieldModal(this.app, schema, view.tableGroupBy || "", async (fieldId) => {
      view.tableGroupBy = fieldId;
      view.tableCollapsedGroups = [];
      view.tableGroupOrder = [];
      view.tableHiddenGroups = [];
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    }).open());
    if (groupField) {
      const groupVisibilityButton = toolbar.createEl("button");
      decorateToolbarButton(groupVisibilityButton, "eye", "分組顯示");
      groupVisibilityButton.addEventListener("click", () => {
        const groupKeys = [];
        const seenGroupKeys = new Set();
        for (const file of files) {
          const key = this.getTableGroupKey(file, groupField);
          if (!seenGroupKeys.has(key)) { seenGroupKeys.add(key); groupKeys.push(key); }
        }
        for (const key of view.tableGroupOrder || []) if (!seenGroupKeys.has(key)) { seenGroupKeys.add(key); groupKeys.push(key); }
        const hidden = new Set(view.tableHiddenGroups || []);
        new BoardGroupVisibilityModal(this.app, groupKeys, hidden, (key) => this.getTableGroupLabel(key, groupField), async (nextHidden) => {
          view.tableHiddenGroups = Array.from(nextHidden);
          await this.saveDefinition(databaseFile, definition);
          await this.loadAndRender(databaseFile);
        }).open();
      });
    }
    const paletteButton = toolbar.createEl("button", { cls: "lmd-db-palette-button", attr: { "aria-label": "設定顏色", title: "設定顏色" } });
    setIcon(paletteButton, "palette");
    if (hasSortOrFilter) {
      const clearQuery = toolbar.createEl("button", { attr: { title: "清除排序 / 篩選", "aria-label": "清除排序 / 篩選" } });
      decorateToolbarButton(clearQuery, "rotate-ccw", "清除");
      clearQuery.addEventListener("click", async () => { view.sort=[]; view.filters=[]; await this.saveCurrentViewState(databaseFile, definition); await this.loadAndRender(databaseFile); });
    }

    const ruleBar = this.contentEl.createDiv({ cls: "lmd-db-rule-bar" });
    for (let i=0;i<view.sort.length;i++) { const r=view.sort[i], c=columns.find(x=>x.id===r.field); const chip=ruleBar.createEl("button", { cls:"lmd-db-rule-chip", text:`排序：${c?.name||r.field} ${r.direction==="desc"?"↓":"↑"} ×` }); chip.addEventListener("click", async()=>{ view.sort.splice(i,1); await this.saveDefinition(databaseFile,definition); await this.loadAndRender(databaseFile); }); }
    for (let i=0;i<view.filters.length;i++) { const r=view.filters[i], c=columns.find(x=>x.id===r.field); const val=(["empty","not-empty","checked","unchecked"].includes(r.operator))?"":` ${r.value}`; const chip=ruleBar.createEl("button", { cls:"lmd-db-rule-chip", text:`篩選：${c?.name||r.field} ${this.filterOperatorLabel(r.operator)}${val} ×` }); chip.addEventListener("click", async()=>{ view.filters.splice(i,1); await this.saveCurrentViewState(databaseFile,definition); await this.loadAndRender(databaseFile); }); }
    if (groupField) { const chip=ruleBar.createEl("button", { cls:"lmd-db-rule-chip", text:`分組：${groupField.name || groupField.id} ×` }); chip.addEventListener("click", async()=>{ view.tableGroupBy=""; view.tableCollapsedGroups=[]; view.tableGroupOrder=[]; view.tableHiddenGroups=[]; await this.saveDefinition(databaseFile,definition); await this.loadAndRender(databaseFile); }); }
    if (!view.sort.length && !view.filters.length && !groupField) ruleBar.style.display="none";

    const selectionInfo = toolbar.createDiv({ cls: "lmd-db-selection-info" });
    const selectedPaths = new Set();
    let selectedColumnId = null;
    let selectedHeaderRow = false;
    const updateSelectionInfo = () => {
      if (selectedPaths.size) selectionInfo.setText(`已選取 ${selectedPaths.size} 筆資料列`);
      else if (selectedHeaderRow) selectionInfo.setText("已選取標題列");
      else if (selectedColumnId) selectionInfo.setText(`已選取欄位：${columns.find((c) => c.id === selectedColumnId)?.name || selectedColumnId}`);
      else selectionInfo.setText("");
      selectionInfo.toggleClass("is-visible", !!selectionInfo.getText().trim());
    };

    const tableWrap = this.contentEl.createDiv({ cls: "lmd-db-table-wrap has-sticky-x-scroll" });
    const table = tableWrap.createEl("table", { cls: "lmd-db-table" });
    this.installMobileContextMenuFallback(tableWrap);
    // 0.16.2 — hierarchy drag has one explicit root target. It is an overlay, so it
    // never adds permanent whitespace to the table. Dropping here is the only drag
    // gesture that removes a parent; row-center drops create a new parent relation.
    const hierarchyRootDrop = tableWrap.createDiv({ cls: "lmd-db-hierarchy-root-drop", text: "移到根層" });
    hierarchyRootDrop.setAttribute("aria-hidden", "true");
    this.installHorizontalWheelPriority(tableWrap);
    const zoomScale = Math.max(0.5, Math.min(1.6, Number(view.zoom) || 1));
    table.toggleClass("is-grouped-table", hasGrouping);

    // One viewport-fixed horizontal scrollbar for the active Table. It is anchored
    // to the Obsidian pane, not the bottom of the table content.
    const updateStickyXScroll = this.installViewportHorizontalScrollbar(tableWrap, () => table.scrollWidth);
    this.installCtrlWheelZoom(table, databaseFile, definition, view, () => {
      requestAnimationFrame(() => { updateStickyXScroll(); requestAnimationFrame(updateStickyXScroll); });
    });

    // Grouped-row insertion uses one independent fixed overlay line. Do not paint
    // drop state on <tr>/<td>: table borders, cell selection and themed focus
    // styles can turn that state into a full rectangular block.
    for (const stale of document.querySelectorAll(".lmd-db-table-row-insert-line")) stale.remove();
    let rowInsertIndicator = null;
    const hideRowInsertIndicator = () => {
      if (rowInsertIndicator) rowInsertIndicator.remove();
      rowInsertIndicator = null;
    };
    const showRowInsertIndicator = (row, after) => {
      if (!(row instanceof HTMLElement) || !row.matches("tr.lmd-db-row")) { hideRowInsertIndicator(); return; }
      const rowRect = row.getBoundingClientRect();
      // r2 hard boundary: the insert guide may only be drawn on a real data row.
      // Add-row / add-group / spacer controls are deliberately excluded from the
      // insertion surface so a stale body-level guide can never visually cut
      // through those controls.
      const dataRows = Array.from(tbody.querySelectorAll("tr.lmd-db-row"));
      if (!dataRows.length) { hideRowInsertIndicator(); return; }
      const firstRect = dataRows[0].getBoundingClientRect();
      const lastRect = dataRows[dataRows.length - 1].getBoundingClientRect();
      const requestedTop = after ? rowRect.bottom - 4 : rowRect.top + 1;
      const boundedTop = Math.max(firstRect.top + 1, Math.min(lastRect.bottom - 4, requestedTop));
      if (!rowInsertIndicator) rowInsertIndicator = document.body.createDiv({ cls: "lmd-db-table-row-insert-line" });
      rowInsertIndicator.style.left = `${Math.round(rowRect.left)}px`;
      rowInsertIndicator.style.width = `${Math.round(rowRect.width)}px`;
      rowInsertIndicator.style.top = `${Math.round(boundedTop)}px`;
    };
    const freezeMask = tableWrap.createDiv({ cls: "lmd-db-freeze-mask" });
    freezeMask.setAttribute("aria-hidden", "true");

    // Use a colgroup + explicit table width so the browser cannot redistribute
    // leftover width into a neighbouring column while resizing.
    const HANDLE_WIDTH = 42;
    const colgroup = table.createEl("colgroup");
    const handleCol = colgroup.createEl("col");
    handleCol.style.width = `${HANDLE_WIDTH}px`;
    const columnCols = new Map();
    for (const column of columns) {
      const col = colgroup.createEl("col");
      const width = view.columnWidths[column.id] || (column.id === "file.name" ? 220 : column.type === "checkbox" ? (column.hierarchicalProgress === true ? 148 : 56) : column.type === "date" ? 128 : 160);
      col.style.width = `${width}px`;
      columnCols.set(column.id, col);
    }
    let splitFreezeState = null;
    const widthForColumn = (column) => (Number(view.columnWidths[column.id]) || (column.id === "file.name" ? 220 : column.type === "checkbox" ? (column.hierarchicalProgress === true ? 148 : 56) : column.type === "date" ? 128 : 160));
    const syncTableWidth = () => {
      if (splitFreezeState) {
        const frozenIds = new Set(view.frozenColumnIds || []);
        const frozenWidth = HANDLE_WIDTH + columns.filter((column) => frozenIds.has(column.id)).reduce((sum, column) => sum + widthForColumn(column), 0);
        const scrollWidth = columns.filter((column) => !frozenIds.has(column.id)).reduce((sum, column) => sum + widthForColumn(column), 0);
        splitFreezeState.frozenPane.style.width = `${frozenWidth}px`;
        splitFreezeState.frozenPane.style.minWidth = `${frozenWidth}px`;
        splitFreezeState.frozenTable.style.width = `${frozenWidth}px`;
        splitFreezeState.frozenTable.style.minWidth = `${frozenWidth}px`;
        splitFreezeState.frozenTable.style.maxWidth = `${frozenWidth}px`;
        table.style.width = `${Math.max(1, scrollWidth)}px`;
        table.style.minWidth = `${Math.max(1, scrollWidth)}px`;
        table.style.maxWidth = `${Math.max(1, scrollWidth)}px`;
        return;
      }
      const total = HANDLE_WIDTH + columns.reduce((sum, column) => sum + widthForColumn(column), 0);
      table.style.width = `${total}px`;
      table.style.minWidth = `${total}px`;
      table.style.maxWidth = `${total}px`;
    };
    syncTableWidth();

    // Freeze is identity-based. The IDs are normalized into a stable left-side
    // zone before rendering, so dragging a scrolling column cannot silently change
    // which column is frozen.
    const freezeEnabledForRender = this.plugin?.settings?.experimentalFreeze === true;
    const persistedFrozenIds = Array.isArray(view.frozenColumnIds) ? view.frozenColumnIds : [];
    const frozenIdSet = new Set(freezeEnabledForRender ? persistedFrozenIds : []);
    const renderFrozenColumnIds = columns.filter((column) => frozenIdSet.has(column.id)).map((column) => column.id);
    const renderFreezeColumns = renderFrozenColumnIds.length;
    if (freezeEnabledForRender) {
      view.frozenColumnIds = renderFrozenColumnIds.slice();
      view.freezeColumns = renderFreezeColumns;
    }
    const frozenGroups = Array.from({ length: renderFreezeColumns }, () => []);
    const applyFrozenPosition = (el, columnIndex, isHeader = false) => {
      if (columnIndex < 0 || columnIndex >= renderFreezeColumns) return;
      el.addClass("lmd-db-frozen-cell");
      el.dataset.freezeIndex = String(columnIndex);
      if (isHeader) el.addClass("is-frozen-header");
      frozenGroups[columnIndex]?.push(el);
    };

    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    const headerSelectHead = headerRow.createEl("th", { cls: "lmd-db-row-handle-head lmd-db-header-row-selector" });
    if (renderFreezeColumns > 0) {
      headerSelectHead.addClass("lmd-db-frozen-handle");
      headerSelectHead.style.left = "0px";
    }
    const syncFrozenLayout = () => {
      if (renderFreezeColumns <= 0) {
        freezeMask.style.display = "none";
        return;
      }
      const handleWidth = headerSelectHead?.getBoundingClientRect().width || HANDLE_WIDTH;
      let runningLeft = handleWidth;
      for (let i = 0; i < renderFreezeColumns; i++) {
        const headerCell = headerRow.children[i + 1];
        const measuredWidth = headerCell?.getBoundingClientRect().width || Number(view.columnWidths[columns[i].id]) || (columns[i].id === "file.name" ? 220 : 160);
        for (const el of frozenGroups[i] || []) {
          el.style.left = `${runningLeft}px`;
          el.classList.toggle("is-freeze-edge", i === renderFreezeColumns - 1);
        }
        runningLeft += measuredWidth;
      }
      const tableRect = table.getBoundingClientRect();
      freezeMask.style.display = "block";
      freezeMask.style.width = `${runningLeft}px`;
      freezeMask.style.height = `${table.offsetHeight}px`;
      freezeMask.style.top = `${table.offsetTop}px`;
      freezeMask.style.transform = `translateX(${tableWrap.scrollLeft}px)`;
    };

    const syncFreezeClipping = () => {
      const candidates = table.querySelectorAll("th:not(.lmd-db-frozen-cell):not(.lmd-db-frozen-handle), td:not(.lmd-db-frozen-cell):not(.lmd-db-frozen-handle)");
      if (renderFreezeColumns <= 0) {
        for (const el of candidates) el.style.clipPath = "";
        return;
      }
      const frozenEdge = headerRow.querySelector("th.lmd-db-frozen-cell.is-freeze-edge");
      if (!frozenEdge) return;
      const boundary = frozenEdge.getBoundingClientRect().right;
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(rect.width, boundary - rect.left));
        if (overlap <= 0.25) el.style.clipPath = "";
        else if (overlap >= rect.width - 0.25) el.style.clipPath = "inset(0 100% 0 0)";
        else el.style.clipPath = `inset(0 0 0 ${Math.ceil(overlap)}px)`;
      }
    };

    const syncFreezeVisuals = () => {
      syncFrozenLayout();
      syncFreezeClipping();
    };

    const headerSelectButton = headerSelectHead.createEl("button", { cls: "lmd-db-header-row-select-button", attr: { "aria-label": "選取整個標題列", title: "選取整個標題列" } });
    setIcon(headerSelectButton, "minus");
    const headerRowColor = normalizeOptionColor(view.headerRowColor);
    if (headerRowColor !== "default") headerSelectHead.addClass(`lmd-db-header-effective-bg-${headerRowColor}`);

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex];
      const th = headerRow.createEl("th", { cls: "lmd-db-column-head" });
      th.dataset.columnId = column.id;
      applyFrozenPosition(th, columnIndex, true);
      const headerCellColor = normalizeOptionColor(view.headerColors[column.id]);
      const effectiveHeaderColor = headerCellColor !== "default" ? headerCellColor : headerRowColor;
      if (effectiveHeaderColor !== "default") th.addClass(`lmd-db-header-effective-bg-${effectiveHeaderColor}`);
      th.draggable = false;
      const titleWrap = th.createDiv({ cls: "lmd-db-column-title-wrap", attr: { draggable: "false" } });
      const typeIcon = titleWrap.createSpan({ cls: "lmd-db-column-type-icon", attr: { "aria-hidden": "true" } });
      const iconName = column.id === "file.name" ? "file-text" : column.type === "number" ? "hash" : column.type === "date" ? "calendar-days" : column.type === "checkbox" ? "square-check" : column.type === "single-select" ? "circle-dot" : column.type === "multi-select" ? "tags" : column.type === "relation" ? "link-2" : "type";
      setIcon(typeIcon, iconName);
      titleWrap.createDiv({ cls: "lmd-db-column-title", text: column.name || column.id });
      if (column.type === "relation") {
        if (isFlexibleRelation(column)) {
          const badge = titleWrap.createSpan({ cls: "lmd-db-relation-bind", text: "∞", attr: { "aria-label": "跨資料庫 Relation" } });
          badge.title = "跨資料庫 Relation：每個格子可連到不同 Database";
        } else {
          const bind = titleWrap.createEl("button", {
            text: column.relationTarget ? "↔" : "＋",
            cls: "lmd-db-relation-bind",
            attr: { "aria-label": column.relationTarget ? "更換 Relation 資料庫" : "綁定 Relation 資料庫" },
          });
          bind.title = column.relationTarget ? `已綁定：${column.relationTarget}（點擊更換）` : "尚未綁定資料庫，點擊選擇";
          bind.draggable = false;
          bind.addEventListener("pointerdown", (event) => { event.stopPropagation(); });
          bind.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            new RelationTargetModal(this.app, databaseFile.path, column.relationTarget || "", async (targetPath) => {
              const schemaField = definition.schema.find((field) => field.id === column.id);
              if (!schemaField) return;
              const keepBidirectional = schemaField.bidirectional === true;
              if (keepBidirectional) await this.removeBidirectionalLinks(schemaField);
              schemaField.relationMode = "fixed";
              schemaField.relationTarget = targetPath;
              delete schemaField.reverseFieldId;
              if (keepBidirectional) {
                await this.ensureReverseRelationField(schemaField);
                await this.rebuildBidirectionalRelation(schemaField);
              }
              await this.saveDefinition(databaseFile, definition);
              await this.loadAndRender(databaseFile);
              new Notice(`Relation 已綁定：${targetPath}`);
            }).open();
          });
        }
      }
      const resizeRight = th.createDiv({ cls: "lmd-db-column-resize is-right", attr: { "aria-label": "調整此欄寬度" } });

      // 0.7.1 — pointer-driven column reorder. Do not use native HTML5 drag
      // on/inside sticky table headers: Chromium can disturb sticky stacking/clipping
      // even when a custom drag image is supplied. We keep the table completely
      // static and move only a fixed preview layer while deciding the drop position.
      titleWrap.addEventListener("pointerdown", (event) => {
        if (!isLmdPrimaryPointer(event)) return;
        if (event.target.closest("button, .lmd-db-column-resize")) return;

        const startX = event.clientX;
        const startY = event.clientY;
        let dragging = false;
        let preview = null;
        let targetColumnId = column.id;
        let insertAfter = false;
        const sourceIsFrozen = renderFrozenColumnIds.includes(column.id);
        let dropIndicator = null;
        const ensureDropIndicator = () => {
          if (dropIndicator) return dropIndicator;
          dropIndicator = document.createElement("div");
          dropIndicator.className = "lmd-db-column-drop-indicator";
          tableWrap.appendChild(dropIndicator);
          return dropIndicator;
        };
        const hideDropIndicator = () => {
          if (dropIndicator) dropIndicator.remove();
          dropIndicator = null;
        };

        const createPreview = () => {
          if (preview) return;
          const rect = th.getBoundingClientRect();
          preview = document.createElement("div");
          preview.className = "lmd-db-column-drag-preview lmd-db-pointer-drag-preview";
          const iconClone = typeIcon.cloneNode(true);
          const textClone = document.createElement("span");
          textClone.className = "lmd-db-column-drag-preview-title";
          textClone.textContent = column.name || column.id;
          preview.appendChild(iconClone);
          preview.appendChild(textClone);
          preview.style.position = "fixed";
          preview.style.width = `${Math.max(80, rect.width)}px`;
          preview.style.height = `${Math.max(32, rect.height)}px`;
          preview.style.pointerEvents = "none";
          preview.style.zIndex = "100000";
          document.body.appendChild(preview);
        };

        const movePreview = (x, y) => {
          if (!preview) return;
          preview.style.left = `${Math.round(x + 12)}px`;
          preview.style.top = `${Math.round(y + 12)}px`;
        };

        const pickTarget = (x) => {
          const heads = Array.from(tableWrap.querySelectorAll("th.lmd-db-column-head"));
          let best = null;
          let bestDistance = Infinity;
          for (const head of heads) {
            if (head === th) continue;
            const headId = head.dataset.columnId || "";
            const headIsFrozen = renderFrozenColumnIds.includes(headId);
            if (headIsFrozen !== sourceIsFrozen) continue;
            const rect = head.getBoundingClientRect();
            // Only consider the actually visible horizontal slice. Frozen columns
            // can overlap scrolling columns; distance-to-center avoids elementFromPoint
            // selecting the wrong stacking layer.
            const center = rect.left + rect.width / 2;
            const distance = Math.abs(x - center);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = { head, rect };
            }
          }
          if (!best) return;
          targetColumnId = best.head.dataset.columnId || column.id;
          insertAfter = x >= best.rect.left + best.rect.width / 2;
          const indicator = ensureDropIndicator();
          const wrapRect = tableWrap.getBoundingClientRect();
          const boundaryX = insertAfter ? best.rect.right : best.rect.left;
          // The indicator is an absolutely-positioned child of the horizontally
          // scrollable tableWrap, therefore its left coordinate must be expressed
          // in scroll-content space. getBoundingClientRect() is viewport space;
          // omitting scrollLeft makes the guide drift by exactly the amount the
          // real-world table has been scrolled. This was mostly invisible in small
          // test databases that never needed horizontal scrolling.
          const contentBoundaryX = boundaryX - wrapRect.left + tableWrap.scrollLeft;
          indicator.style.left = `${Math.round(contentBoundaryX)}px`;
          indicator.style.top = `${Math.round(headerRow.getBoundingClientRect().top - wrapRect.top + tableWrap.scrollTop)}px`;
          indicator.style.height = `${Math.round(table.getBoundingClientRect().height)}px`;
          indicator.style.display = "block";
        };

        const onMove = (moveEvent) => {
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          if (!dragging && Math.hypot(dx, dy) < 6) return;
          if (!dragging) {
            dragging = true;
            createPreview();
            document.body.addClass("lmd-db-is-column-pointer-dragging");
          }
          moveEvent.preventDefault();
          movePreview(moveEvent.clientX, moveEvent.clientY);
          pickTarget(moveEvent.clientX);
        };

        const onUp = async (upEvent) => {
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onCancel, true);
          document.body.removeClass("lmd-db-is-column-pointer-dragging");
          if (preview) preview.remove();
          hideDropIndicator();
          if (!dragging || !targetColumnId || targetColumnId === column.id) return;

          upEvent.preventDefault();
          const order = view.columnOrder.filter((id) => id !== column.id);
          let targetIndex = order.indexOf(targetColumnId);
          if (targetIndex < 0) return;
          if (insertAfter) targetIndex += 1;
          order.splice(Math.max(0, Math.min(order.length, targetIndex)), 0, column.id);
          const freezeSetAfterDrop = new Set(view.frozenColumnIds);
          view.columnOrder = [
            ...order.filter((id) => freezeSetAfterDrop.has(id)),
            ...order.filter((id) => !freezeSetAfterDrop.has(id)),
          ];
          view.freezeColumns = view.frozenColumnIds.length;
          await this.saveDefinition(databaseFile, definition);
          await this.loadAndRender(databaseFile);
        };

        const onCancel = () => {
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onCancel, true);
          document.body.removeClass("lmd-db-is-column-pointer-dragging");
          if (preview) preview.remove();
          hideDropIndicator();
        };

        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onCancel, true);
      });

      const beginResize = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const minWidth = column.id === "file.name" ? 64 : column.type === "checkbox" ? 34 : 48;
        const startWidth = Number(view.columnWidths[column.id]) || (column.id === "file.name" ? 220 : column.type === "checkbox" ? (column.hierarchicalProgress === true ? 148 : 56) : column.type === "date" ? 128 : 160);
        const currentCol = columnCols.get(column.id);

        document.body.addClass("lmd-db-is-resizing");
        const onMove = (moveEvent) => {
          const delta = (moveEvent.clientX - startX) / Math.max(0.5, Math.min(1.6, Number(view.zoom) || 1));
          const width = Math.max(minWidth, Math.min(900, Math.round(startWidth + delta)));
          view.columnWidths[column.id] = width;
          if (currentCol) currentCol.style.width = `${width}px`;
          syncTableWidth();
          if (view.freezeColumns > 0) syncTableWidth();
        };
        const onUp = async () => {
          document.body.removeClass("lmd-db-is-resizing");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          await this.saveDefinition(databaseFile, definition);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp, { once: true });
      };
      resizeRight.addEventListener("pointerdown", beginResize);
      let columnWasDragged = false;
      titleWrap.addEventListener("dragstart", () => { columnWasDragged = true; });
      titleWrap.addEventListener("dragend", () => { window.setTimeout(() => { columnWasDragged = false; }, 0); });
      th.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (columnWasDragged || target.closest(".lmd-db-column-resize, .lmd-db-relation-bind")) return;
        event.preventDefault();
        event.stopPropagation();
        clearCellSelection();
        selectedHeaderRow = false;
        headerRow.removeClass("is-header-row-selected");
        selectedPaths.clear();
        for (const row of tableWrap.querySelectorAll("tr.is-selected")) row.removeClass("is-selected");
        selectedColumnId = selectedColumnId === column.id ? null : column.id;
        paintColumnSelection(selectedColumnId);
        updateSelectionInfo();
      });
    }
    const tbody = table.createEl("tbody");

    // Notion-style drag selection across cells. A simple click still focuses
    // the underlying editor; moving while held switches into rectangular selection.
    let cellSelection = null;
    let fillHandle = null;
    let fillPreviewCells = [];
    const clearFillPreview = () => {
      for (const cell of fillPreviewCells) cell.removeClass("is-fill-preview");
      fillPreviewCells = [];
    };
    const removeFillHandle = () => {
      clearFillPreview();
      if (fillHandle) fillHandle.remove();
      fillHandle = null;
    };
    let suppressNextCellClick = false;
    tableWrap.tabIndex = -1;

    const applyViewColor = async ({ scope, columnId, color, rows = null, selection = null }) => {
      const normalized = normalizeOptionColor(color);
      if (scope === "rows") {
        for (const file of (rows || [])) {
          if (normalized === "default") delete view.rowColors[file.path];
          else view.rowColors[file.path] = normalized;
        }
      } else if (scope === "column") {
        if (normalized === "default") delete view.columnColors[columnId];
        else view.columnColors[columnId] = normalized;
        for (const rowPath of Object.keys(view.cellColors || {})) {
          if (view.cellColors[rowPath] && Object.prototype.hasOwnProperty.call(view.cellColors[rowPath], columnId)) {
            delete view.cellColors[rowPath][columnId];
            if (!Object.keys(view.cellColors[rowPath]).length) delete view.cellColors[rowPath];
          }
        }
      } else if (scope === "header-row") {
        view.headerRowColor = normalized;
      } else if (scope === "header-cell") {
        if (normalized === "default") delete view.headerColors[columnId];
        else view.headerColors[columnId] = normalized;
      } else if (scope === "cells" && selection) {
        for (let r = selection.minR; r <= selection.maxR; r++) {
          const file = files[r];
          if (!file) continue;
          if (!view.cellColors[file.path] || typeof view.cellColors[file.path] !== "object") view.cellColors[file.path] = {};
          for (let c = selection.minC; c <= selection.maxC; c++) {
            const column = columns[c];
            if (!column) continue;
            if (normalized === "default") delete view.cellColors[file.path][column.id];
            else view.cellColors[file.path][column.id] = normalized;
          }
          if (!Object.keys(view.cellColors[file.path]).length) delete view.cellColors[file.path];
        }
      }
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };

    const openForcedColorPicker = (scope, opts = {}) => {
      const rows = opts.rows || [];
      const selection = opts.selection || null;
      const columnId = opts.columnId || selectedColumnId || columns[0]?.id || "file.name";
      new DatabaseColorModal(this.app, { scope }, async ({ color }) => {
        await applyViewColor({ scope, columnId, color, rows, selection });
      }).open();
    };

    const getActiveColorTarget = () => {
      if (cellSelection) return { scope: "cells", selection: cellSelection };
      const rows = files.filter((item) => selectedPaths.has(item.path));
      if (rows.length) return { scope: "rows", rows };
      if (selectedHeaderRow) return { scope: "header-row" };
      if (selectedColumnId) return { scope: "column", columnId: selectedColumnId };
      return null;
    };

    paletteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = getActiveColorTarget();
      if (!target) {
        new Notice("請先選取資料列、儲存格或欄位。");
        return;
      }
      openForcedColorPicker(target.scope, target);
    });

    const clearCellSelection = () => {
      for (const cell of tableWrap.querySelectorAll(".lmd-db-data-cell.is-cell-selected")) cell.removeClass("is-cell-selected");
      for (const body of tableWrap.querySelectorAll("tbody")) body.removeClass("has-cell-selection");
      cellSelection = null;
      removeFillHandle();
    };
    const clearColumnSelection = () => {
      selectedColumnId = null;
      for (const el of tableWrap.querySelectorAll(".is-column-selected")) el.removeClass("is-column-selected");
    };
    const paintColumnSelection = (columnId) => {
      for (const el of tableWrap.querySelectorAll(".is-column-selected")) el.removeClass("is-column-selected");
      if (!columnId) return;
      const index = columns.findIndex((column) => column.id === columnId);
      const head = tableWrap.querySelector(`.lmd-db-column-head[data-column-id="${CSS.escape(columnId)}"]`);
      if (head) head.addClass("is-column-selected");
      for (const cell of tableWrap.querySelectorAll(`.lmd-db-data-cell[data-column-index="${index}"]`)) cell.addClass("is-column-selected");
    };
    const clearAllSelection = () => {
      clearCellSelection();
      clearColumnSelection();
      selectedHeaderRow = false;
      headerRow.removeClass("is-header-row-selected");
      selectedPaths.clear();
      for (const row of tableWrap.querySelectorAll("tr.is-selected")) row.removeClass("is-selected");
      updateSelectionInfo();
    };
    headerSelectButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearCellSelection();
      clearColumnSelection();
      selectedPaths.clear();
      for (const row of tableWrap.querySelectorAll("tr.is-selected")) row.removeClass("is-selected");
      selectedHeaderRow = !selectedHeaderRow;
      headerRow.toggleClass("is-header-row-selected", selectedHeaderRow);
      updateSelectionInfo();
    });
    const deleteSelectedRows = async () => {
      const paths = files.map((file) => file.path).filter((path) => selectedPaths.has(path));
      if (!paths.length) return;
      const ok = window.confirm(`確定要刪除選取的 ${paths.length} 筆資料嗎？\n檔案會依 Obsidian 設定移到垃圾桶。`);
      if (!ok) return;
      try {
        const deletedIds = new Set(paths.map((path) => this.getItemIdByPath(path)).filter(Boolean));
        for (const path of paths) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) await this.app.fileManager.trashFile(file);
        }
        view.manualOrder = view.manualOrder.filter((id) => !deletedIds.has(id));
        for (const path of selectedPaths) {
          delete view.rowColors[path];
          delete view.cellColors[path];
        }
        await this.saveDefinition(databaseFile, definition);
        new Notice(`已刪除 ${paths.length} 筆資料`);
        await this.loadAndRender(databaseFile);
      } catch (error) {
        console.error("Local Markdown Database: bulk delete failed", error);
        new Notice("批次刪除失敗。請查看開發者主控台。");
      }
    };
    tableWrap.addEventListener("contextmenu", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const header = target.closest("th.lmd-db-column-head");
      const row = target.closest("tr.lmd-db-row");
      const cell = target.closest("td.lmd-db-data-cell");
      const handleCell = target.closest("td.lmd-db-row-handle-cell");
      if (!header && !row) return;
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();

      if (header) {
        const columnId = header.dataset.columnId;
        const column = columns.find((c) => c.id === columnId);
        // Right-click color follows the current header selection semantics:
        // whole header row when it is selected; otherwise only this header cell.
        menu.addItem((item) => item.setTitle("顏色…").setIcon("palette").onClick(() => {
          if (selectedHeaderRow) openForcedColorPicker("header-row");
          else if (selectedColumnId === columnId) openForcedColorPicker("column", { columnId });
          else openForcedColorPicker("header-cell", { columnId });
        }));
        if (columnId !== "file.name") {
          menu.addItem((item) => item.setTitle(`隱藏欄位「${column?.name || columnId}」`).setIcon("eye-off").onClick(async () => {
            view.hiddenColumns = Array.from(new Set([...(view.hiddenColumns || []), columnId]));
            await this.saveDefinition(databaseFile, definition);
            await this.loadAndRender(databaseFile);
          }));
        }
        for (const hiddenId of view.hiddenColumns || []) {
          const hiddenColumn = allColumns.find((c) => c.id === hiddenId);
          if (!hiddenColumn) continue;
          menu.addItem((item) => item.setTitle(`顯示欄位「${hiddenColumn.name || hiddenId}」`).setIcon("eye").onClick(async () => {
            view.hiddenColumns = (view.hiddenColumns || []).filter((id) => id !== hiddenId);
            await this.saveDefinition(databaseFile, definition);
            await this.loadAndRender(databaseFile);
          }));
        }
        const freezeIndex = columns.findIndex((c) => c.id === columnId);
        if (this.plugin?.settings?.experimentalFreeze === true && freezeIndex >= 0) {
          const isFrozen = view.frozenColumnIds.includes(columnId);
          if (isFrozen) {
            menu.addItem((item) => item.setTitle(`取消凍結「${column?.name || columnId}」`).setIcon("snowflake").onClick(async () => {
              view.frozenColumnIds = view.frozenColumnIds.filter((id) => id !== columnId);
              const frozenSet = new Set(view.frozenColumnIds);
              view.columnOrder = [
                ...view.columnOrder.filter((id) => frozenSet.has(id)),
                ...view.columnOrder.filter((id) => !frozenSet.has(id)),
              ];
              view.freezeColumns = view.frozenColumnIds.length;
              await this.saveDefinition(databaseFile, definition);
              await this.loadAndRender(databaseFile);
            }));
          } else {
            menu.addItem((item) => item.setTitle(`凍結到「${column?.name || columnId}」`).setIcon("snowflake").onClick(async () => {
              view.frozenColumnIds = columns.slice(0, freezeIndex + 1).map((c) => c.id);
              view.freezeColumns = view.frozenColumnIds.length;
              await this.saveDefinition(databaseFile, definition);
              await this.loadAndRender(databaseFile);
            }));
          }
          if (view.frozenColumnIds.length > 0) {
            menu.addItem((item) => item.setTitle("取消全部凍結").setIcon("x").onClick(async () => {
              view.frozenColumnIds = [];
              view.freezeColumns = 0;
              await this.saveDefinition(databaseFile, definition);
              await this.loadAndRender(databaseFile);
            }));
          }
        }
        menu.addSeparator();
        if (definition.source?.type === "database-set" && columnId !== "file.name") {
          menu.addItem((item) => item.setTitle("共同欄位由原始 Database 管理").setIcon("database").setDisabled(true));
          this.showExclusiveTableContextMenu(menu, event);
          return;
        }
        menu.addItem((item) => item.setTitle("重新命名欄位…").setIcon("pencil").onClick(() => {
          const currentName = column?.name || columnId;
          new RenameFieldModal(this.app, currentName, async (wanted) => {
            if (columnId === "file.name") view.titleColumnName = wanted;
            else {
              const field = definition.schema.find((f) => f.id === columnId);
              if (field) field.name = wanted;
            }
            await this.saveDefinition(databaseFile, definition);
            await this.loadAndRender(databaseFile);
          }).open();
        }));
        if (columnId !== "file.name" && column?.type === "checkbox") {
          const field = definition.schema.find((f) => f.id === columnId);
          if (field) {
            menu.addItem((item) => item.setTitle("階層進度").setIcon("list-checks").setChecked(field.hierarchicalProgress === true).onClick(async () => {
              field.hierarchicalProgress = field.hierarchicalProgress !== true;
              if (!field.hierarchyProgressScope) field.hierarchyProgressScope = "descendants";
              if (field.hierarchicalProgress === true && (!Number(view.columnWidths?.[field.id]) || Number(view.columnWidths[field.id]) < 118)) view.columnWidths[field.id] = 148;
              await this.persistCheckboxHierarchyFieldDefinition(field);
              await this.loadAndRender(databaseFile);
            }));
            if (field.hierarchicalProgress === true) {
              menu.addItem((item) => item.setTitle("進度範圍：全部後代").setIcon("list-tree").setChecked(field.hierarchyProgressScope !== "direct").onClick(async () => { field.hierarchyProgressScope = "descendants"; await this.persistCheckboxHierarchyFieldDefinition(field); await this.loadAndRender(databaseFile); }));
              menu.addItem((item) => item.setTitle("進度範圍：直接子項").setIcon("git-branch").setChecked(field.hierarchyProgressScope === "direct").onClick(async () => { field.hierarchyProgressScope = "direct"; await this.persistCheckboxHierarchyFieldDefinition(field); await this.loadAndRender(databaseFile); }));
            }
          }
        }
        if (columnId !== "file.name" && column?.type === "date") {
          menu.addItem((item) => item.setTitle("日期 / 時間 / 結束日期改為每格設定").setIcon("calendar-clock").setDisabled(true));
        }
        if (columnId !== "file.name" && column?.type === "relation") {
          menu.addItem((item) => item.setTitle("Relation 設定…").setIcon("git-compare-arrows").onClick(() => {
            const field = definition.schema.find((f) => f.id === columnId);
            if (!field) return;
            const wasBidirectional = field.bidirectional === true;
            new RelationSettingsModal(this.app, field, async (result) => {
              if (wasBidirectional && (!result.bidirectional || result.relationMode === "flexible")) await this.removeBidirectionalLinks(field);
              field.relationMode = result.relationMode === "flexible" ? "flexible" : "fixed";
              field.bidirectional = field.relationMode === "fixed" && result.bidirectional === true;
              field.reverseFieldName = result.reverseFieldName || field.reverseFieldName || definition.name || databaseFile.basename;
              if (field.relationMode === "flexible") {
                delete field.reverseFieldId;
              } else if (field.bidirectional) {
                await this.ensureReverseRelationField(field);
                await this.rebuildBidirectionalRelation(field);
              }
              await this.saveDefinition(databaseFile, definition);
              await this.loadAndRender(databaseFile);
              new Notice(field.relationMode === "flexible" ? "已切換為跨資料庫 Relation" : (field.bidirectional ? "固定 Relation · 雙向已啟用" : "固定 Relation 已套用"));
            }).open();
          }));
        }
        if (columnId !== "file.name" && (column?.type === "single-select" || column?.type === "multi-select")) {
          menu.addItem((item) => item.setTitle("選項設定…").setIcon("list-ordered").onClick(() => {
            const field = definition.schema.find((f) => f.id === columnId); if (!field) return;
            const observed = this.collectMultiSelectSuggestions(field); field.options = Array.from(new Set([...(Array.isArray(field.options)?field.options:[]), ...observed]));
            new SelectOptionsManagerModal(this.app, field, async (result) => { await this.applySelectOptionsChange(field, rawFiles, result); }).open();
          }));
        }
        if (columnId !== "file.name") {
          menu.addItem((item) => item.setTitle("變更欄位類型…").setIcon("replace").onClick(() => {
            const current = column?.type || "text";
            new ChangeFieldTypeModal(this.app, current, async (next) => {
              const field = definition.schema.find((f) => f.id === columnId);
              if (!field) return;
              field.type = next;
              if (next === "single-select" || next === "multi-select") { if (!Array.isArray(field.options)) field.options = []; if (!field.optionColors || typeof field.optionColors !== "object") field.optionColors = {}; }
              else { delete field.options; delete field.optionColors; }
              if (next !== "checkbox") { delete field.hierarchicalProgress; delete field.hierarchyProgressScope; }
              if (next !== "relation") { delete field.relationTarget; delete field.relationMode; delete field.bidirectional; delete field.reverseFieldId; }
              else if (!field.relationMode) field.relationMode = "fixed";
              await this.saveDefinition(databaseFile, definition);
              await this.loadAndRender(databaseFile);
            }).open();
          }));
          menu.addSeparator();
          menu.addItem((item) => item.setTitle(`刪除欄位「${column?.name || columnId}」`).setIcon("trash-2").onClick(async () => {
            const ok = window.confirm(`確定要刪除欄位「${column?.name || columnId}」嗎？\n這會同時移除來源 Markdown 裡的 ${columnId} property。`);
            if (!ok) return;
            const field = definition.schema.find((f) => f.id === columnId);
            if (field?.type === "relation" && field.bidirectional === true) {
              try { await this.removeBidirectionalLinks(field); } catch (error) { console.error("Local Markdown Database: reverse relation cleanup failed", error); }
            }
            for (const note of rawFiles) {
              try {
                await this.app.fileManager.processFrontMatter(note, (frontmatter) => { delete frontmatter[columnId]; });
              } catch (error) { console.error("Local Markdown Database: delete property failed", note.path, error); }
            }
            definition.schema = definition.schema.filter((f) => f.id !== columnId);
            for (const state of this.getAllViewStates(definition)) {
              state.columnOrder = (state.columnOrder || []).filter((id) => id !== columnId);
              state.hiddenColumns = (state.hiddenColumns || []).filter((id) => id !== columnId);
              if (state.columnWidths) delete state.columnWidths[columnId];
              if (state.columnColors) delete state.columnColors[columnId];
              if (state.headerColors) delete state.headerColors[columnId];
              if (state.frozenColumnIds) state.frozenColumnIds = state.frozenColumnIds.filter((id) => id !== columnId);
              state.freezeColumns = (state.frozenColumnIds || []).length;
              state.sort = (state.sort || []).filter((rule) => rule.field !== columnId);
              state.filters = (state.filters || []).filter((rule) => rule.field !== columnId);
              if (state.boardGroupBy === columnId) state.boardGroupBy = "";
              state.boardCardFields = (state.boardCardFields || []).filter((id) => id !== columnId);
              state.calendarCardFields = (state.calendarCardFields || []).filter((id) => id !== columnId);
              if (state.tableGroupBy === columnId) state.tableGroupBy = "";
              if (state.cellColors) {
                for (const rowPath of Object.keys(state.cellColors)) {
                  delete state.cellColors[rowPath]?.[columnId];
                  if (state.cellColors[rowPath] && Object.keys(state.cellColors[rowPath]).length === 0) delete state.cellColors[rowPath];
                }
              }
            }
            await this.saveDefinition(databaseFile, definition);
            await this.loadAndRender(databaseFile);
            new Notice(`已刪除欄位：${column?.name || columnId}`);
          }));
        }
        this.showExclusiveTableContextMenu(menu, event);
        return;
      }

      const path = row?.dataset.path;
      const file = files.find((item) => item.path === path);
      if (!file) return;
      const rowIndex = Number(cell?.dataset.rowIndex);
      const columnIndex = Number(cell?.dataset.columnIndex);
      const isCellInsideSelection = !!cellSelection && Number.isFinite(rowIndex) && Number.isFinite(columnIndex) && rowIndex >= cellSelection.minR && rowIndex <= cellSelection.maxR && columnIndex >= cellSelection.minC && columnIndex <= cellSelection.maxC;
      const clickedColumn = Number.isFinite(columnIndex) ? columns[columnIndex] : null;
      if (clickedColumn?.type === "checkbox") {
        const field = definition.schema.find((f) => f.id === clickedColumn.id);
        if (field) {
          menu.addItem((item) => item.setTitle(field.hierarchicalProgress === true ? "關閉階層進度" : "開啟階層進度").setIcon("list-checks").onClick(async () => {
            field.hierarchicalProgress = field.hierarchicalProgress !== true;
            if (!field.hierarchyProgressScope) field.hierarchyProgressScope = "descendants";
            if (field.hierarchicalProgress === true && (!Number(view.columnWidths?.[field.id]) || Number(view.columnWidths[field.id]) < 118)) view.columnWidths[field.id] = 148;
            await this.persistCheckboxHierarchyFieldDefinition(field);
            await this.loadAndRender(databaseFile);
          }));
          menu.addSeparator();
        }
      }

      // Row actions live in the single delegated table context-menu listener.
      // Do not attach a second contextmenu listener to the name cell: nested
      // listeners were the cause of multiple stacked Obsidian menus.
      // 0.17.0 — linear version lineage. Version metadata is system metadata,
      // never a user schema column. The first "next version" action lazily creates
      // a family id so ordinary notes remain untouched until versioning is used.
      menu.addItem((item) => item.setTitle("建立下一版本").setIcon("git-commit-horizontal").onClick(() => void this.createNextVersion(file)));
      menu.addItem((item) => item.setTitle("版本歷程…").setIcon("history").onClick(() => new VersionLineageModal(this.app, this, file).open()));
      const versionMeta = this.getVersionMeta(file);
      if (versionMeta.familyId && versionMeta.status !== "current") menu.addItem((item) => item.setTitle("設為目前版本").setIcon("badge-check").onClick(() => void this.setCurrentVersion(file)));
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("附屬…").setIcon("paperclip").onClick(() => {
        new ContextAttachmentsModal(this.app, this.plugin, file, databaseFile, async () => {
          await this.refreshInlineAttachmentRowsForFile(file);
        }).open();
      }));
      menu.addItem((item) => item.setTitle("展開附屬到 Canvas").setIcon("layout-dashboard").onClick(() => void this.plugin.expandContextAttachmentsToCanvas(file)));
      menu.addItem((item) => item.setTitle("收起 Canvas 附屬").setIcon("panel-right-close").onClick(() => void this.plugin.collapseContextAttachmentsInCanvas(file)));
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("新增子項目").setIcon("git-branch-plus").onClick(() => void this.createChildRow(file, source, view, schema)));
      menu.addItem((item) => item.setTitle("變更父項目…").setIcon("network").onClick(() => {
        new ParentItemPickerModal(this.app, rawFiles, file, (candidate) => this.getStableItemId(candidate), (candidate) => this.getParentItemId(candidate), async (parentFile) => {
          if (await this.setParentItem(file, parentFile)) await this.loadAndRender(databaseFile);
        }).open();
      }));
      if (this.getParentItemId(file)) menu.addItem((item) => item.setTitle("移到根層").setIcon("corner-up-left").onClick(async () => { if (await this.setParentItem(file, null)) await this.loadAndRender(databaseFile); }));
      menu.addSeparator();

      if (isCellInsideSelection) {
        menu.addItem((item) => item.setTitle("顏色…").setIcon("palette").onClick(() => openForcedColorPicker("cells", { selection: cellSelection })));
      } else if ((selectedPaths.has(file.path) && selectedPaths.size) || handleCell) {
        const rows = selectedPaths.has(file.path) && selectedPaths.size ? files.filter((item) => selectedPaths.has(item.path)) : [file];
        menu.addItem((item) => item.setTitle("顏色…").setIcon("palette").onClick(() => openForcedColorPicker("rows", { rows })));
      } else if (cell && Number.isFinite(rowIndex) && Number.isFinite(columnIndex)) {
        const selection = { minR: rowIndex, maxR: rowIndex, minC: columnIndex, maxC: columnIndex };
        menu.addItem((item) => item.setTitle("顏色…").setIcon("palette").onClick(() => openForcedColorPicker("cells", { selection })));
      }

      menu.addSeparator();
      if (selectedPaths.has(file.path) && selectedPaths.size > 1) {
        menu.addItem((item) => item.setTitle(`刪除選取資料列（${selectedPaths.size}）`).setIcon("trash-2").onClick(() => void deleteSelectedRows()));
      } else {
        menu.addItem((item) => item.setTitle(`刪除「${file.basename}」`).setIcon("trash-2").onClick(() => {
          const ok = window.confirm(`確定要刪除「${file.basename}」嗎？\n檔案會依 Obsidian 設定移到垃圾桶。`);
          if (ok) void this.deleteRow(file);
        }));
      }
      this.showExclusiveTableContextMenu(menu, event);
    });
    const paintCellSelection = (startCell, endCell) => {
      const r1 = Number(startCell.dataset.rowIndex);
      const c1 = Number(startCell.dataset.columnIndex);
      const r2 = Number(endCell.dataset.rowIndex);
      const c2 = Number(endCell.dataset.columnIndex);
      const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
      const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
      clearCellSelection();
      clearColumnSelection();
      selectedPaths.clear();
      for (const row of tableWrap.querySelectorAll("tr.is-selected")) row.removeClass("is-selected");
      for (const cell of tableWrap.querySelectorAll(".lmd-db-data-cell")) {
        const r = Number(cell.dataset.rowIndex);
        const c = Number(cell.dataset.columnIndex);
        if (r >= minR && r <= maxR && c >= minC && c <= maxC) cell.addClass("is-cell-selected");
      }
      cellSelection = { startCell, endCell, minR, maxR, minC, maxC };
      for (const body of tableWrap.querySelectorAll("tbody")) body.addClass("has-cell-selection");
      selectionInfo.setText(`已選取 ${(maxR - minR + 1) * (maxC - minC + 1)} 格`);
      renderFillHandle();
    };

    const getSelectedMatrix = () => {
      if (!cellSelection) return [];
      const rows = [];
      for (let r = cellSelection.minR; r <= cellSelection.maxR; r++) {
        const row = [];
        for (let c = cellSelection.minC; c <= cellSelection.maxC; c++) {
          const cell = tbody.querySelector(`.lmd-db-data-cell[data-row-index="${r}"][data-column-index="${c}"]`);
          const input = cell && cell.querySelector("input");
          row.push(input ? input.value : "");
        }
        rows.push(row);
      }
      return rows;
    };

    const getRawCellValue = (rowIndex, columnIndex) => {
      const targetFile = displayedFiles[rowIndex];
      const column = columns[columnIndex];
      if (!targetFile || !column) return "";
      if (column.id === "file.name") return targetFile.basename;
      const raw = this.getColumnValue(targetFile, column);
      if (Array.isArray(raw)) return raw.slice();
      if (raw && typeof raw === "object") return JSON.parse(JSON.stringify(raw));
      return raw ?? "";
    };
    const renderFillHandle = () => {
      removeFillHandle();
      if (!cellSelection) return;
      const anchorCell = tbody.querySelector(`.lmd-db-data-cell[data-row-index="${cellSelection.maxR}"][data-column-index="${cellSelection.maxC}"]`);
      if (!(anchorCell instanceof HTMLElement)) return;
      fillHandle = anchorCell.createDiv({ cls: "lmd-db-fill-handle", attr: { title: "向上或向下拖曳以填充" } });
      fillHandle.addEventListener("pointerdown", (event) => {
        if (!isLmdPrimaryPointer(event) || !cellSelection) return;
        event.preventDefault();
        event.stopPropagation();
        const sourceSelection = { ...cellSelection };
        const sourceRows = sourceSelection.maxR - sourceSelection.minR + 1;
        const sourceCols = sourceSelection.maxC - sourceSelection.minC + 1;
        const matrix = [];
        for (let r = 0; r < sourceRows; r++) {
          const row = [];
          for (let c = 0; c < sourceCols; c++) row.push(getRawCellValue(sourceSelection.minR + r, sourceSelection.minC + c));
          matrix.push(row);
        }
        let fillDirection = null;
        let targetMinR = sourceSelection.minR;
        let targetMaxR = sourceSelection.maxR;
        document.body.addClass("lmd-db-is-fill-dragging");
        const updatePreview = (clientX, clientY) => {
          clearFillPreview();
          const hit = document.elementFromPoint(clientX, clientY);
          const cell = hit?.closest?.(".lmd-db-data-cell[data-row-index]");
          if (!cell) return;
          const rowIndex = Number(cell.dataset.rowIndex);
          if (!Number.isFinite(rowIndex)) return;

          if (rowIndex < sourceSelection.minR) {
            fillDirection = "up";
            targetMinR = Math.max(0, rowIndex);
            targetMaxR = sourceSelection.maxR;
            for (let r = targetMinR; r < sourceSelection.minR; r++) {
              for (let c = sourceSelection.minC; c <= sourceSelection.maxC; c++) {
                const preview = tbody.querySelector(`.lmd-db-data-cell[data-row-index="${r}"][data-column-index="${c}"]`);
                if (preview) { preview.addClass("is-fill-preview"); fillPreviewCells.push(preview); }
              }
            }
            return;
          }

          if (rowIndex > sourceSelection.maxR) {
            fillDirection = "down";
            targetMinR = sourceSelection.minR;
            targetMaxR = Math.min(displayedFiles.length - 1, rowIndex);
            for (let r = sourceSelection.maxR + 1; r <= targetMaxR; r++) {
              for (let c = sourceSelection.minC; c <= sourceSelection.maxC; c++) {
                const preview = tbody.querySelector(`.lmd-db-data-cell[data-row-index="${r}"][data-column-index="${c}"]`);
                if (preview) { preview.addClass("is-fill-preview"); fillPreviewCells.push(preview); }
              }
            }
            return;
          }

          fillDirection = null;
          targetMinR = sourceSelection.minR;
          targetMaxR = sourceSelection.maxR;
        };
        const onMove = (moveEvent) => { moveEvent.preventDefault(); updatePreview(moveEvent.clientX, moveEvent.clientY); };
        const onUp = async () => {
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", onUp, true);
          document.body.removeClass("lmd-db-is-fill-dragging");
          clearFillPreview();
          if (!fillDirection) return;

          const cloneFillValue = (raw) => Array.isArray(raw) ? raw.slice() : (raw && typeof raw === "object" ? JSON.parse(JSON.stringify(raw)) : raw);
          const positiveMod = (value, mod) => ((value % mod) + mod) % mod;

          if (fillDirection === "up") {
            for (let r = targetMinR; r < sourceSelection.minR; r++) {
              // Anchor the repeated pattern to the source block, so dragging upward
              // continues the same sequence backwards instead of reversing it.
              const patternRow = positiveMod(r - sourceSelection.minR, sourceRows);
              for (let c = sourceSelection.minC; c <= sourceSelection.maxC; c++) {
                if (columns[c]?.id === "file.name") continue;
                const patternCol = (c - sourceSelection.minC) % sourceCols;
                await applyCellValue(r, c, cloneFillValue(matrix[patternRow][patternCol]));
              }
            }
          } else {
            for (let r = sourceSelection.maxR + 1; r <= targetMaxR; r++) {
              const patternRow = (r - sourceSelection.minR) % sourceRows;
              for (let c = sourceSelection.minC; c <= sourceSelection.maxC; c++) {
                if (columns[c]?.id === "file.name") continue;
                const patternCol = (c - sourceSelection.minC) % sourceCols;
                await applyCellValue(r, c, cloneFillValue(matrix[patternRow][patternCol]));
              }
            }
          }
          await this.loadAndRender(databaseFile);
        };
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
      });
    };

    const copyCellSelection = async () => {
      const matrix = getSelectedMatrix();
      if (!matrix.length) return false;
      const text = matrix.map((row) => row.join("\t")).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        new Notice(`已複製 ${matrix.length} × ${matrix[0].length} 格`);
        return true;
      } catch (error) {
        console.error("Local Markdown Database: copy failed", error);
        new Notice("複製失敗。請查看開發者主控台。");
        return false;
      }
    };

    const applyCellValue = async (rowIndex, columnIndex, rawValue) => {
      const file = displayedFiles[rowIndex];
      const column = columns[columnIndex];
      if (!file || !column) return;
      if (column.id === "file.name") {
        const name = String(rawValue || "").trim();
        if (name) await this.renameRow(file, name);
        return;
      }
      await this.writeProperty(file, column, rawValue);
    };

    const pasteIntoSelection = async (text) => {
      if (!cellSelection) return false;
      const matrix = String(text || "").replace(/\r/g, "").split("\n").map((line) => line.split("\t"));
      while (matrix.length && matrix[matrix.length - 1].length === 1 && matrix[matrix.length - 1][0] === "") matrix.pop();
      if (!matrix.length) return false;
      const targetRows = cellSelection.maxR - cellSelection.minR + 1;
      const targetCols = cellSelection.maxC - cellSelection.minC + 1;
      const repeatSingle = matrix.length === 1 && matrix[0].length === 1 && (targetRows > 1 || targetCols > 1);
      for (let r = 0; r < (repeatSingle ? targetRows : matrix.length); r++) {
        const sourceRow = repeatSingle ? matrix[0] : matrix[r];
        if (!sourceRow) continue;
        for (let c = 0; c < (repeatSingle ? targetCols : sourceRow.length); c++) {
          const value = repeatSingle ? matrix[0][0] : sourceRow[c];
          const rowIndex = cellSelection.minR + r;
          const columnIndex = cellSelection.minC + c;
          if (rowIndex >= displayedFiles.length || columnIndex >= columns.length) continue;
          await applyCellValue(rowIndex, columnIndex, value);
        }
      }
      await this.loadAndRender(databaseFile);
      return true;
    };

    const clearSelectedCells = async () => {
      if (!cellSelection) return false;
      for (let r = cellSelection.minR; r <= cellSelection.maxR; r++) {
        for (let c = cellSelection.minC; c <= cellSelection.maxC; c++) {
          const column = columns[c];
          if (!column || column.id === "file.name") continue;
          const targetFile = displayedFiles[r];
          if (targetFile) await this.writeProperty(targetFile, column, "");
        }
      }
      await this.loadAndRender(databaseFile);
      return true;
    };

    const hasNativeTextSelection = () => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        try { return (active.selectionStart ?? 0) !== (active.selectionEnd ?? 0); } catch (_) { return false; }
      }
      const selection = window.getSelection?.();
      return !!selection && !selection.isCollapsed && String(selection).length > 0;
    };
    const eventComesFromEditor = (event) => event.target instanceof HTMLElement && !!event.target.closest("input, textarea, select");

    if (tableWrap) {
      tableWrap.addEventListener("keydown", (event) => {
        if (eventComesFromEditor(event)) return;
        if (cellSelection) {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
            event.preventDefault();
            void copyCellSelection();
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
            event.preventDefault();
            void navigator.clipboard.readText().then((text) => pasteIntoSelection(text));
          } else if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            void clearSelectedCells();
          } else if (event.key === "Escape") {
            event.preventDefault();
            clearAllSelection();
          }
          return;
        }
        const active = document.activeElement;
        const isEditing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
        if (!isEditing && selectedPaths.size && (event.key === "Delete" || event.key === "Backspace")) {
          event.preventDefault();
          void deleteSelectedRows();
        } else if (!isEditing && event.key === "Escape") {
          event.preventDefault();
          clearAllSelection();
        }
      });
      tableWrap.addEventListener("copy", (event) => {
        if (eventComesFromEditor(event) || hasNativeTextSelection()) return;
        if (!cellSelection || !event.clipboardData) return;
        const matrix = getSelectedMatrix();
        if (!matrix.length) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", matrix.map((row) => row.join("\t")).join("\n"));
      });
      tableWrap.addEventListener("paste", (event) => {
        if (eventComesFromEditor(event)) return;
        if (!cellSelection || !event.clipboardData) return;
        event.preventDefault();
        void pasteIntoSelection(event.clipboardData.getData("text/plain"));
      });
    }

    // Row marquee selection starts only from genuine blank space in the Database view.
    // Cell-drag selection and row-marquee selection deliberately remain separate modes.
    this.containerEl.addEventListener("pointerdown", (event) => {
      if (!isLmdPrimaryPointer(event)) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(".lmd-db-table, .lmd-db-board, .lmd-db-calendar, .lmd-db-calendar-undated, button, input, select, textarea, .lmd-db-toolbar, .lmd-db-header")) return;

      clearAllSelection();
      const startX = event.clientX;
      const startY = event.clientY;
      let marquee = null;
      let dragging = false;

      const paintRowsInRect = (x1, y1, x2, y2) => {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);
        selectedPaths.clear();
        for (const row of tbody.querySelectorAll("tr.lmd-db-row")) {
          const rect = row.getBoundingClientRect();
          const intersects = rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
          row.toggleClass("is-selected", intersects);
          if (intersects && row.dataset.path) selectedPaths.add(row.dataset.path);
        }
        for (const row of tableWrap.querySelectorAll("tr.lmd-db-row")) row.toggleClass("is-selected", selectedPaths.has(row.dataset.path || ""));
        updateSelectionInfo();
      };

      const onMove = (moveEvent) => {
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (!dragging && distance < 5) return;
        if (!dragging) {
          dragging = true;
          document.body.addClass("lmd-db-is-row-marqueeing");
          marquee = document.body.createDiv({ cls: "lmd-db-row-marquee" });
          if (tableWrap) tableWrap.focus({ preventScroll: true });
        }
        moveEvent.preventDefault();
        const left = Math.min(startX, moveEvent.clientX);
        const top = Math.min(startY, moveEvent.clientY);
        const width = Math.abs(moveEvent.clientX - startX);
        const height = Math.abs(moveEvent.clientY - startY);
        marquee.style.left = `${left}px`;
        marquee.style.top = `${top}px`;
        marquee.style.width = `${width}px`;
        marquee.style.height = `${height}px`;
        paintRowsInRect(startX, startY, moveEvent.clientX, moveEvent.clientY);
      };

      const onUp = () => {
        document.body.removeClass("lmd-db-is-row-marqueeing");
        if (marquee) marquee.remove();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp, { once: true });
    });

    tableWrap.addEventListener("click", (event) => {
      if (!suppressNextCellClick) return;
      suppressNextCellClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });

    tableWrap.addEventListener("pointerdown", (event) => {
      if (!isLmdPrimaryPointer(event)) return;
      if (event.target.closest("button")) return;
      // Editors own pointer gestures. This keeps click-to-edit while preserving
      // native mouse text selection instead of forcing the caret to the end.
      if (event.target.closest("input, textarea")) {
        clearCellSelection();
        updateSelectionInfo();
        return;
      }
      const startCell = event.target.closest(".lmd-db-data-cell");
      if (!startCell) return;

      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      cellSelection = { startCell, endCell: startCell, minR: Number(startCell.dataset.rowIndex), maxR: Number(startCell.dataset.rowIndex), minC: Number(startCell.dataset.columnIndex), maxC: Number(startCell.dataset.columnIndex) };
      event.preventDefault();

      const onMove = (moveEvent) => {
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (!dragging && distance < 5) return;
        if (!dragging) {
          dragging = true;
          document.body.addClass("lmd-db-is-cell-selecting");
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          const nativeSelection = window.getSelection?.();
          if (nativeSelection) nativeSelection.removeAllRanges();
          if (tableWrap) tableWrap.focus({ preventScroll: true });
        }
        moveEvent.preventDefault();
        const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const endCell = under && under.closest ? under.closest(".lmd-db-data-cell") : null;
        if (endCell && tableWrap.contains(endCell)) paintCellSelection(startCell, endCell);
      };

      const onUp = (upEvent) => {
        document.body.removeClass("lmd-db-is-cell-selecting");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (dragging) {
          upEvent.preventDefault();
          suppressNextCellClick = true;
          const nativeSelection = window.getSelection?.();
          if (nativeSelection) nativeSelection.removeAllRanges();
          if (tableWrap) tableWrap.focus({ preventScroll: true });
        } else {
          clearCellSelection();
          updateSelectionInfo();
          const editor = startCell.querySelector("input:not(.lmd-db-markdown-editor):not(.lmd-db-multiselect-mirror)");
          if (editor) editor.focus({ preventScroll: true });
        }
      };

      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp, { once: true });
    }, { capture: true });

    const tableDisplayItems = [];
    // Selection coordinates must follow the actual rendered order. In grouped
    // views the underlying `files` order can differ from the visible group order;
    // using files.indexOf(file) makes a rectangle selected in group A light up
    // unrelated rows in group B.
    const displayedFiles = [];
    // 0.16.2 — drag semantics are deliberately explicit:
    //   top/bottom row edge = reorder among existing siblings only
    //   row center          = make the dragged item(s) children of that row
    //   floating root target = detach and move to the root level
    // This keeps the 0.16.0-hotfix.1 guarantee that a child can never accidentally
    // escape its family just because it was dropped near another level.
    let activeHierarchyRowDrag = null;
    const getHierarchyParentId = (candidate) => this.getParentItemId(candidate) || "";
    const clearHierarchyDropVisuals = () => {
      hierarchyRootDrop.removeClass("is-visible", "is-drop-target");
      hierarchyRootDrop.setAttribute("aria-hidden", "true");
      for (const row of tbody.querySelectorAll("tr.lmd-db-row.is-drop-parent-target")) row.removeClass("is-drop-parent-target");
    };
    const hierarchyRowZone = (row, clientY) => {
      const rect = row.getBoundingClientRect();
      const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
      if (ratio < 0.25) return "before";
      if (ratio > 0.75) return "after";
      return "parent";
    };
    const getDraggedHierarchyFiles = (dragPaths) => rawFiles.filter((candidate) => dragPaths.includes(candidate.path));
    const canReparentHierarchyFiles = (draggedFiles, targetFile) => {
      if (!(targetFile instanceof TFile) || !draggedFiles.length) return false;
      const targetId = this.getStableItemId(targetFile);
      const dragIds = new Set(draggedFiles.map((candidate) => this.getStableItemId(candidate)).filter(Boolean));
      if (!targetId || dragIds.has(targetId)) return false;
      const parentById = new Map(rawFiles.map((candidate) => [this.getStableItemId(candidate), getHierarchyParentId(candidate)]));
      let cursor = targetId;
      const seen = new Set();
      while (cursor && !seen.has(cursor)) {
        if (dragIds.has(cursor)) return false;
        seen.add(cursor);
        cursor = parentById.get(cursor) || "";
      }
      return true;
    };
    const moveHierarchyBlockNear = (draggedFiles, targetFile, mode) => {
      const base = Array.isArray(view.manualOrder) ? view.manualOrder.slice() : [];
      for (const candidate of rawFiles) { const id = this.getStableItemId(candidate); if (id && !base.includes(id)) base.push(id); }
      const dragIds = draggedFiles.map((candidate) => this.getStableItemId(candidate)).filter(Boolean);
      const dragSet = new Set(dragIds);
      const orderedDragIds = base.filter((id) => dragSet.has(id));
      const remaining = base.filter((id) => !dragSet.has(id));
      const targetId = targetFile ? this.getStableItemId(targetFile) : "";
      let index = targetId ? remaining.indexOf(targetId) : remaining.length;
      if (index < 0) index = remaining.length;
      if (mode === "after") index += 1;
      if (mode === "child" && targetId) {
        const childIds = rawFiles.filter((candidate) => getHierarchyParentId(candidate) === targetId).map((candidate) => this.getStableItemId(candidate)).filter((id) => id && !dragSet.has(id));
        const childPositions = childIds.map((id) => remaining.indexOf(id)).filter((i) => i >= 0);
        index = childPositions.length ? Math.max(...childPositions) + 1 : Math.min(remaining.length, index + 1);
      }
      remaining.splice(Math.max(0, Math.min(remaining.length, index)), 0, ...orderedDragIds);
      view.manualOrder = remaining;
    };
    const reparentHierarchyFiles = async (dragPaths, targetFile) => {
      const draggedFiles = getDraggedHierarchyFiles(dragPaths);
      if (!canReparentHierarchyFiles(draggedFiles, targetFile)) { new Notice("不能把項目放到自己或自己的子孫底下。"); return true; }
      for (const candidate of draggedFiles) {
        const ok = await this.setParentItem(candidate, targetFile);
        if (!ok) return true;
      }
      moveHierarchyBlockNear(draggedFiles, targetFile, "child");
      const targetId = this.getStableItemId(targetFile);
      view.tableCollapsedParents = (view.tableCollapsedParents || []).filter((id) => id !== targetId);
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
      return true;
    };
    const moveHierarchyFilesToRoot = async (dragPaths) => {
      const draggedFiles = getDraggedHierarchyFiles(dragPaths);
      if (!draggedFiles.length) return false;
      for (const candidate of draggedFiles) await this.setParentItem(candidate, null);
      moveHierarchyBlockNear(draggedFiles, null, "after");
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
      return true;
    };
    const reorderHierarchySiblings = async (dragPaths, targetFile, after) => {
      const pathSet = new Set(dragPaths);
      const draggedFiles = rawFiles.filter((candidate) => pathSet.has(candidate.path));
      if (!draggedFiles.length) return false;
      const parentIds = new Set(draggedFiles.map((candidate) => getHierarchyParentId(candidate)));
      if (parentIds.size !== 1) { new Notice("父子模式下只能一起拖曳同一層級的項目。"); return true; }
      const parentId = draggedFiles.length ? getHierarchyParentId(draggedFiles[0]) : "";
      if (getHierarchyParentId(targetFile) !== parentId) {
        new Notice("父子模式下不能把項目拖出目前層級；要更換父項目請使用右鍵「變更父項目…」。");
        return true;
      }
      const idToFile = new Map(rawFiles.map((candidate) => [this.getStableItemId(candidate), candidate]));
      const baseOrder = Array.isArray(view.manualOrder) ? view.manualOrder.slice() : [];
      for (const candidate of rawFiles) { const id = this.getStableItemId(candidate); if (id && !baseOrder.includes(id)) baseOrder.push(id); }
      const visibleSiblingIds = files.filter((candidate) => getHierarchyParentId(candidate) === parentId).map((candidate) => this.getStableItemId(candidate)).filter(Boolean);
      const dragIds = visibleSiblingIds.filter((id) => {
        const candidate = idToFile.get(id); return candidate && pathSet.has(candidate.path);
      });
      if (!dragIds.length) return true;
      const dragSet = new Set(dragIds);
      const reorderedVisible = visibleSiblingIds.filter((id) => !dragSet.has(id));
      const targetId = this.getStableItemId(targetFile);
      let targetIndex = reorderedVisible.indexOf(targetId);
      if (targetIndex < 0) targetIndex = reorderedVisible.length;
      if (after) targetIndex += 1;
      reorderedVisible.splice(Math.max(0, Math.min(reorderedVisible.length, targetIndex)), 0, ...dragIds);
      // Replace only visible sibling slots in the full manual order. Hidden siblings
      // and collapsed descendants keep their exact positions and can never jump out.
      const visibleSet = new Set(visibleSiblingIds);
      let cursor = 0;
      view.manualOrder = baseOrder.map((id) => visibleSet.has(id) ? reorderedVisible[cursor++] : id);
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
      return true;
    };
    hierarchyRootDrop.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types?.includes("text/lmd-row") || hasGrouping || hasSort || !activeHierarchyRowDrag) return;
      event.preventDefault(); event.stopPropagation();
      hierarchyRootDrop.addClass("is-drop-target");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    hierarchyRootDrop.addEventListener("dragleave", () => hierarchyRootDrop.removeClass("is-drop-target"));
    hierarchyRootDrop.addEventListener("drop", async (event) => {
      if (hasGrouping || hasSort) return;
      const sourcePath = event.dataTransfer?.getData("text/lmd-row") || "";
      let dragPaths = [];
      try { dragPaths = JSON.parse(event.dataTransfer?.getData("text/lmd-row-group") || "[]"); } catch (_) {}
      if (!Array.isArray(dragPaths) || !dragPaths.length) dragPaths = sourcePath ? [sourcePath] : [];
      if (!dragPaths.length) return;
      event.preventDefault(); event.stopPropagation();
      clearHierarchyDropVisuals();
      await moveHierarchyFilesToRoot(dragPaths);
    });

    // 0.14.5 — for a plain/manual table reorder we can keep the existing DOM alive
    // and only move <tr> nodes. This preserves editors, selection, scroll position
    // and avoids clearing/rebuilding the whole View just because manualOrder changed.
    const applyPlainRowOrderWithoutRender = (orderedIds) => {
      if (groupField || !Array.isArray(orderedIds)) return false;
      const idToFile = new Map(files.map((candidate) => [this.getStableItemId(candidate), candidate]));
      const orderedFiles = orderedIds.map((id) => idToFile.get(id)).filter(Boolean);
      if (orderedFiles.length !== files.length) return false;
      const pathToRow = new Map(Array.from(tbody.querySelectorAll("tr.lmd-db-row")).map((row) => [row.dataset.path || "", row]));
      if (pathToRow.size !== orderedFiles.length) return false;
      const bottomAdd = tbody.querySelector("tr.lmd-db-table-bottom-add-row");
      for (const candidate of orderedFiles) {
        const row = pathToRow.get(candidate.path);
        if (row) tbody.insertBefore(row, bottomAdd || null);
      }
      files.splice(0, files.length, ...orderedFiles);
      displayedFiles.splice(0, displayedFiles.length, ...orderedFiles);
      orderedFiles.forEach((candidate, rowIndex) => {
        const row = pathToRow.get(candidate.path);
        if (!row) return;
        for (const cell of row.querySelectorAll(".lmd-db-data-cell")) cell.dataset.rowIndex = String(rowIndex);
      });
      clearCellSelection();
      updateSelectionInfo();
      requestAnimationFrame(() => { try { syncFreezeVisuals(); } catch (_) {} });
      return true;
    };
    let renderRowOrdinal = 0;
    if (groupField) {
      const grouped = new Map();
      for (const file of files) {
        const key = this.getTableGroupKey(file, groupField);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(file);
      }
      const discoveredKeys = Array.from(grouped.keys()).sort((a, b) => {
        if (a === "__lmd_ungrouped__") return 1;
        if (b === "__lmd_ungrouped__") return -1;
        return this.getTableGroupLabel(a, groupField).localeCompare(this.getTableGroupLabel(b, groupField), undefined, { numeric: true, sensitivity: "base" });
      });
      const storedOrder = Array.from(new Set((view.tableGroupOrder || []).filter((key) => typeof key === "string" && key.length > 0)));
      const keys = [...storedOrder, ...discoveredKeys.filter((key) => !storedOrder.includes(key))];
      for (const key of keys) if (!grouped.has(key)) grouped.set(key, []);
      view.tableGroupOrder = keys.slice();
      const hiddenGroups = new Set(view.tableHiddenGroups || []);
      const visibleKeys = keys.filter((key) => !hiddenGroups.has(key));
      const collapsed = new Set(view.tableCollapsedGroups || []);
      visibleKeys.forEach((key, groupIndex) => {
        if (groupIndex > 0) tableDisplayItems.push({ type: "group-spacer", key: `spacer-${groupIndex}` });
        const isCollapsed = collapsed.has(key);
        const groupFiles = grouped.get(key) || [];
        tableDisplayItems.push({ type: "group", key, count: groupFiles.length, collapsed: isCollapsed });
        if (!isCollapsed) {
          for (const file of groupFiles) tableDisplayItems.push({ type: "file", file, groupKey: key });
          tableDisplayItems.push({ type: "group-add", key });
        }
      });
      if (visibleKeys.length > 0) tableDisplayItems.push({ type: "group-new" });
    } else {
      for (const file of files) tableDisplayItems.push({ type: "file", file, groupKey: "" });
    }

    const writeTableGroupTarget = async (dragPaths, targetKey) => {
      if (!groupField || !Array.isArray(dragPaths) || dragPaths.length === 0) return false;
      let targetValue = targetKey === "__lmd_ungrouped__" ? "" : targetKey;
      if (groupField.type === "multi-select" || groupField.type === "relation") {
        targetValue = targetKey === "__lmd_ungrouped__" ? [] : String(targetKey).split(" · ").map((v) => v.trim()).filter(Boolean);
      } else if (groupField.type === "number" && targetKey !== "__lmd_ungrouped__") {
        const n = Number(targetKey); targetValue = Number.isFinite(n) ? n : targetKey;
      }
      let changed = false;
      for (const path of dragPaths) {
        const targetFile = this.app.vault.getAbstractFileByPath(path);
        if (!(targetFile instanceof TFile)) continue;
        const ok = await this.writeProperty(targetFile, groupField, targetValue);
        changed = changed || ok;
      }
      return changed;
    };

    const readDraggedPaths = (event) => {
      const sourcePath = event.dataTransfer.getData("text/lmd-row");
      let dragPaths = [];
      try { dragPaths = JSON.parse(event.dataTransfer.getData("text/lmd-row-group") || "[]"); } catch (_) {}
      if (!Array.isArray(dragPaths) || dragPaths.length === 0) dragPaths = sourcePath ? [sourcePath] : [];
      return files.map((f) => f.path).filter((path) => dragPaths.includes(path));
    };

    // 0.9.7 — deterministic grouped row placement. Property changes and manual
    // order are committed as one drop operation so a row never briefly vanishes
    // or reappears at an arbitrary top/bottom position after regrouping.
    const getStableBaseOrder = () => {
      const order = Array.isArray(view.manualOrder) ? view.manualOrder.slice() : [];
      for (const candidate of files) { const id = this.getStableItemId(candidate); if (id && !order.includes(id)) order.push(id); }
      return order;
    };
    const reorderDraggedBlockAtRow = (dragPaths, targetPath, after) => {
      const dragSet = new Set(dragPaths.map((path) => this.getItemIdByPath(path)).filter(Boolean));
      const targetId = this.getItemIdByPath(targetPath);
      const base = getStableBaseOrder();
      const orderedDrag = base.filter((id) => dragSet.has(id));
      const remaining = base.filter((id) => !dragSet.has(id));
      let index = remaining.indexOf(targetId);
      if (index < 0) index = remaining.length;
      if (after) index += 1;
      remaining.splice(Math.max(0, Math.min(remaining.length, index)), 0, ...orderedDrag);
      return remaining;
    };
    const reorderDraggedBlockToGroupEnd = (dragPaths, targetKey) => {
      const dragSet = new Set(dragPaths.map((path) => this.getItemIdByPath(path)).filter(Boolean));
      const base = getStableBaseOrder();
      const orderedDrag = base.filter((id) => dragSet.has(id));
      const remaining = base.filter((id) => !dragSet.has(id));
      const fileById = new Map(files.map((candidate) => [this.getStableItemId(candidate), candidate]));
      const targetMembers = remaining.filter((id) => {
        const candidate = fileById.get(id);
        return candidate && this.getTableGroupKey(candidate, groupField) === targetKey;
      });
      let index;
      if (targetMembers.length) {
        index = remaining.indexOf(targetMembers[targetMembers.length - 1]) + 1;
      } else {
        const groupOrder = Array.isArray(view.tableGroupOrder) ? view.tableGroupOrder : [];
        const targetGroupIndex = groupOrder.indexOf(targetKey);
        index = remaining.length;
        if (targetGroupIndex >= 0) {
          for (let i = 0; i < remaining.length; i++) {
            const candidate = fileById.get(remaining[i]);
            if (!candidate) continue;
            const candidateKey = this.getTableGroupKey(candidate, groupField);
            const candidateIndex = groupOrder.indexOf(candidateKey);
            if (candidateIndex > targetGroupIndex) { index = i; break; }
          }
        }
      }
      remaining.splice(index, 0, ...orderedDrag);
      return remaining;
    };
    const commitGroupedDrop = async (dragPaths, targetKey, targetPath = "", after = true) => {
      if (!groupField || !dragPaths.length) return;
      const nextOrder = targetPath
        ? reorderDraggedBlockAtRow(dragPaths, targetPath, after)
        : reorderDraggedBlockToGroupEnd(dragPaths, targetKey);
      await writeTableGroupTarget(dragPaths, targetKey);
      view.manualOrder = nextOrder;
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };

    const reorderTableGroups = async (sourceKey, targetKey, after) => {
      if (!groupField || !sourceKey || !targetKey || sourceKey === targetKey) return;
      const current = (view.tableGroupOrder || []).slice();
      const allKnown = [];
      const known = new Set();
      for (const file of files) {
        const key = this.getTableGroupKey(file, groupField);
        if (!known.has(key)) { known.add(key); allKnown.push(key); }
      }
      for (const key of current) if (!known.has(key)) { known.add(key); allKnown.push(key); }
      let order = current.filter((key) => known.has(key) && key !== sourceKey);
      for (const key of allKnown) if (!order.includes(key) && key !== sourceKey) order.push(key);
      let index = order.indexOf(targetKey);
      if (index < 0) index = order.length;
      if (after) index += 1;
      order.splice(Math.max(0, Math.min(order.length, index)), 0, sourceKey);
      view.tableGroupOrder = order;
      await this.saveDefinition(databaseFile, definition);
      await this.loadAndRender(databaseFile);
    };

    // 0.12.8-r2 — hard drag-guide boundary. The body-level grouped-row guide
    // is valid only while the pointer is over a real data row. Entering any
    // control row (新增資料列 / 新增新的 Group / spacer) immediately removes it.
    tbody.addEventListener("dragover", (event) => {
      if (!hasGrouping || !event.dataTransfer?.types?.includes("text/lmd-row")) return;
      const target = event.target instanceof Element ? event.target : null;
      const dataRow = target?.closest("tr.lmd-db-row");
      if (!dataRow || !tbody.contains(dataRow)) hideRowInsertIndicator();
    }, true);

    for (const item of tableDisplayItems) {
      if (item.type === "group-new") {
        const newGroupTr = tbody.createEl("tr", { cls: "lmd-db-table-new-group-row" });
        const newGroupTd = newGroupTr.createEl("td", { cls: "lmd-db-table-new-group-cell", attr: { colspan: String(columns.length + 1) } });
        const newGroupButton = newGroupTd.createEl("button", { cls: "lmd-db-table-new-group-button", attr: { type: "button" } });
        newGroupTr.addEventListener("dragenter", hideRowInsertIndicator);
        newGroupTr.addEventListener("dragover", hideRowInsertIndicator);
        setIcon(newGroupButton, "plus");
        newGroupButton.createSpan({ text: "新增新的 Group" });
        newGroupButton.addEventListener("click", () => {
          if (!groupField) return;
          if (groupField.type === "relation") {
            const applyRelationGroups = async (values) => {
              const picked = Array.isArray(values) ? values : [];
              if (!picked.length) return;
              const order = Array.from(new Set(view.tableGroupOrder || []));
              for (const value of picked) {
                const key = stripWikiLink(value);
                if (key && !order.includes(key)) order.push(key);
              }
              view.tableGroupOrder = order;
              await this.saveDefinition(databaseFile, definition);
              await this.loadAndRender(databaseFile);
            };
            if (isFlexibleRelation(groupField)) {
              new FlexibleRelationPickerModal(this.app, this.databaseFile?.path || "", "", [], applyRelationGroups).open();
            } else {
              if (!groupField.relationTarget) { new Notice("這個 Relation 欄位尚未綁定目標 Database。"); return; }
              new RelationPickerModal(this.app, groupField.relationTarget, [], applyRelationGroups).open();
            }
            return;
          }
          const defaultName = groupField.type === "number" ? "0" : groupField.type === "date" ? new Date().toISOString().slice(0, 10) : "新 Group";
          new ViewNameModal(this.app, "新增 Group", defaultName, async (name) => {
            let key = String(name || "").trim();
            if (!key) return;
            if (groupField.type === "number") {
              const n = Number(key);
              if (!Number.isFinite(n)) { new Notice("數字分組需要輸入有效數字。"); return; }
              key = String(n);
            }
            const order = Array.from(new Set(view.tableGroupOrder || []));
            if (!order.includes(key)) order.push(key);
            view.tableGroupOrder = order;
            const hidden = new Set(view.tableHiddenGroups || []);
            hidden.delete(key);
            view.tableHiddenGroups = Array.from(hidden);
            await this.saveDefinition(databaseFile, definition);
            await this.loadAndRender(databaseFile);
          }).open();
        });
        continue;
      }
      if (item.type === "group-spacer") {
        const spacerTr = tbody.createEl("tr", { cls: "lmd-db-table-group-spacer-row" });
        spacerTr.createEl("td", { cls: "lmd-db-table-group-spacer-cell", attr: { colspan: String(columns.length + 1) } });
        continue;
      }
      if (item.type === "group-add") {
        const addTr = tbody.createEl("tr", { cls: "lmd-db-table-group-add-row" });
        const addTd = addTr.createEl("td", { cls: "lmd-db-table-group-add-cell", attr: { colspan: String(columns.length + 1) } });
        const addButton = addTd.createEl("button", { cls: "lmd-db-table-group-add-button", attr: { type: "button" } });
        setIcon(addButton, "plus");
        addButton.createSpan({ text: "新增資料列" });
        addTr.addEventListener("dragover", (event) => {
          if (hasSort || !event.dataTransfer.types.includes("text/lmd-row")) return;
          hideRowInsertIndicator();
          event.preventDefault();
          addTr.addClass("is-group-drop-target");
        });
        addTr.addEventListener("dragleave", () => addTr.removeClass("is-group-drop-target"));
        addTr.addEventListener("drop", async (event) => {
          addTr.removeClass("is-group-drop-target");
          if (hasSort) return;
          const dragPaths = readDraggedPaths(event);
          if (!dragPaths.length) return;
          event.preventDefault();
          await commitGroupedDrop(dragPaths, item.key);
        });
        addButton.addEventListener("click", () => {
          if (!groupField || item.key === "__lmd_ungrouped__") {
            void this.createRowForView(source, view, schema);
            return;
          }
          let initialValue = item.key;
          if (groupField.type === "multi-select" || groupField.type === "relation") {
            initialValue = String(item.key).split(" · ").map((value) => value.trim()).filter(Boolean);
          } else if (groupField.type === "number") {
            const numeric = Number(item.key);
            initialValue = Number.isFinite(numeric) ? numeric : item.key;
          }
          void this.createRowForView(source, view, schema, groupField, initialValue);
        });
        continue;
      }
      if (item.type === "group") {
        const groupTr = tbody.createEl("tr", { cls: "lmd-db-table-group-row", attr: { draggable: "true" } });
        groupTr.dataset.groupKey = item.key;
        const groupTd = groupTr.createEl("td", { cls: "lmd-db-table-group-cell", attr: { colspan: String(columns.length + 1) } });
        groupTr.addEventListener("dragstart", (event) => {
          if (event.target.closest("button")) { event.preventDefault(); return; }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/lmd-table-group", item.key);
          groupTr.addClass("is-group-dragging");
        });
        groupTr.addEventListener("dragend", () => {
          groupTr.removeClass("is-group-dragging");
          for (const row of tbody.querySelectorAll(".is-group-order-before, .is-group-order-after")) row.removeClass("is-group-order-before", "is-group-order-after");
        });
        groupTr.addEventListener("dragover", (event) => {
          if (event.dataTransfer.types.includes("text/lmd-table-group")) {
            event.preventDefault();
            const rect = groupTr.getBoundingClientRect();
            const after = event.clientY >= rect.top + rect.height / 2;
            groupTr.toggleClass("is-group-order-before", !after);
            groupTr.toggleClass("is-group-order-after", after);
            return;
          }
          if (hasSort || !event.dataTransfer.types.includes("text/lmd-row")) return;
          event.preventDefault();
          groupTr.addClass("is-group-drop-target");
        });
        groupTr.addEventListener("dragleave", () => groupTr.removeClass("is-group-drop-target", "is-group-order-before", "is-group-order-after"));
        groupTr.addEventListener("drop", async (event) => {
          const wasBefore = groupTr.hasClass("is-group-order-before");
          const wasAfter = groupTr.hasClass("is-group-order-after");
          groupTr.removeClass("is-group-drop-target", "is-group-order-before", "is-group-order-after");
          const sourceGroupKey = event.dataTransfer.getData("text/lmd-table-group");
          if (sourceGroupKey) {
            event.preventDefault();
            await reorderTableGroups(sourceGroupKey, item.key, wasAfter && !wasBefore);
            return;
          }
          if (hasSort) return;
          const dragPaths = readDraggedPaths(event);
          if (!dragPaths.length) return;
          event.preventDefault();
          await commitGroupedDrop(dragPaths, item.key);
        });
        groupTr.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const menu = new Menu();
          menu.addItem((menuItem) => menuItem.setTitle("隱藏此分組").setIcon("eye-off").onClick(async () => {
            const hidden = new Set(view.tableHiddenGroups || []);
            hidden.add(item.key);
            view.tableHiddenGroups = Array.from(hidden);
            await this.saveDefinition(databaseFile, definition);
            await this.loadAndRender(databaseFile);
          }));
          menu.showAtMouseEvent(event);
        });
        const toggle = groupTd.createEl("button", { cls: "lmd-db-table-group-toggle", attr: { type: "button", "aria-label": item.collapsed ? "展開分組" : "摺疊分組" } });
        setIcon(toggle, item.collapsed ? "chevron-right" : "chevron-down");
        const groupName = groupTd.createSpan({ cls: "lmd-db-table-group-name" });
        const renderPlainGroupName = () => groupName.setText(this.getTableGroupLabel(item.key, groupField));
        if (item.key === "__lmd_ungrouped__" || !groupField) {
          renderPlainGroupName();
        } else if (groupField.type === "multi-select") {
          groupName.addClass("is-special", "is-multiselect");
          const values = String(item.key).split(" · ").map((value) => value.trim()).filter(Boolean);
          if (!values.length) renderPlainGroupName();
          else for (const value of values) groupName.createSpan({ cls: this.chipClassFor(groupField, value), text: value });
        } else if (groupField.type === "relation") {
          groupName.addClass("is-special", "is-relation", "lmd-db-relation-chips");
          const values = String(item.key).split(" · ").map((value) => value.trim()).filter(Boolean);
          if (!values.length) renderPlainGroupName();
          else for (const raw of values) {
            const target = stripWikiLink(raw);
            const resolved = this.resolveRelationFile(target, databaseFile.path);
            const label = resolved?.basename || pathBasenameNoExt(target);
            const chip = groupName.createEl("button", { cls: "lmd-db-relation-chip", text: label, attr: { type: "button" } });
            chip.title = resolved?.path || target;
            chip.draggable = false;
            chip.addEventListener("pointerdown", (event) => event.stopPropagation());
            chip.addEventListener("dragstart", (event) => { event.preventDefault(); event.stopPropagation(); });
            chip.addEventListener("click", (event) => {
              event.preventDefault(); event.stopPropagation();
              const link = resolved ? stripMdExtension(resolved.path) : target;
              void this.app.workspace.openLinkText(link, databaseFile.path, false);
            });
          }
        } else {
          renderPlainGroupName();
        }
        groupTd.createSpan({ cls: "lmd-db-table-group-count", text: String(item.count) });
        toggle.addEventListener("click", async () => {
          const collapsed = new Set(view.tableCollapsedGroups || []);
          if (collapsed.has(item.key)) collapsed.delete(item.key); else collapsed.add(item.key);
          view.tableCollapsedGroups = Array.from(collapsed);
          await this.saveDefinition(databaseFile, definition);
          await this.loadAndRender(databaseFile);
        });
        continue;
      }
      const file = item.file;
      const displayRowIndex = renderRowOrdinal++;
      displayedFiles[displayRowIndex] = file;
      const tr = tbody.createEl("tr", { cls: "lmd-db-row" });
      tr.dataset.path = file.path;
      tr.dataset.groupKey = item.groupKey || "";
      const rowColor = normalizeOptionColor(view.rowColors[file.path]);
      tr.draggable = false;

      const handleCell = tr.createEl("td", { cls: "lmd-db-row-handle-cell" });
      if (renderFreezeColumns > 0) {
        handleCell.addClass("lmd-db-frozen-handle");
        handleCell.style.left = "0px";
      }
      if (rowColor !== "default") handleCell.addClass(`lmd-db-effective-bg-${rowColor}`);
      const handle = handleCell.createEl("button", { text: "⋮⋮", cls: "lmd-db-row-handle", attr: { "aria-label": "拖曳資料列 / 點擊選取" } });
      handle.draggable = !hasSort;
      if (hasGrouping && !hasSort) handle.setAttribute("aria-label", "拖曳到其他分組可直接修改分組 property");
      else if (hasSort) handle.setAttribute("aria-label", "有排序時暫停手動拖曳；清除排序後可繼續拖曳");
      else if (hasFilter) handle.setAttribute("aria-label", "目前有篩選；可拖曳可見資料列並更新手動順序");
      handle.addEventListener("click", (event) => {
        if (handle.dataset.justDragged === "1") {
          event.preventDefault();
          event.stopPropagation();
          delete handle.dataset.justDragged;
          return;
        }
        event.preventDefault();
        clearCellSelection();
        clearColumnSelection();
        if (selectedPaths.has(file.path)) {
          selectedPaths.delete(file.path);
          tr.removeClass("is-selected");
        } else {
          selectedPaths.add(file.path);
          tr.addClass("is-selected");
        }
        updateSelectionInfo();
      });
      handle.addEventListener("dragstart", (event) => {
        if (hasSort) { event.preventDefault(); return; }
        handle.dataset.justDragged = "1";
        clearCellSelection();
        clearColumnSelection();
        const nativeSelection = window.getSelection?.();
        if (nativeSelection) nativeSelection.removeAllRanges();
        event.dataTransfer.effectAllowed = "move";
        const dragPaths = selectedPaths.has(file.path) && selectedPaths.size > 1
          ? files.map((item) => item.path).filter((path) => selectedPaths.has(path))
          : [file.path];
        if (!hasGrouping) {
          const dragged = rawFiles.filter((candidate) => dragPaths.includes(candidate.path));
          const parentIds = new Set(dragged.map((candidate) => getHierarchyParentId(candidate)));
          activeHierarchyRowDrag = { parentId: parentIds.size === 1 ? Array.from(parentIds)[0] : "", valid: parentIds.size === 1, dragPaths: dragPaths.slice() };
          hierarchyRootDrop.addClass("is-visible");
          hierarchyRootDrop.setAttribute("aria-hidden", "false");
        }
        event.dataTransfer.setData("text/lmd-row", file.path);
        event.dataTransfer.setData("text/lmd-row-group", JSON.stringify(dragPaths));
        for (const path of dragPaths) {
          const row = tbody.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
          if (row) row.addClass("is-dragging");
        }
      });
      handle.addEventListener("dragend", () => {
        hideRowInsertIndicator();
        clearHierarchyDropVisuals();
        activeHierarchyRowDrag = null;
        for (const row of tbody.querySelectorAll("tr.is-dragging")) row.removeClass("is-dragging");
      });
      tr.addEventListener("dragover", (event) => {
        if (!event.dataTransfer.types.includes("text/lmd-row") || hasSort) return;
        event.preventDefault();
        const rect = tr.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        if (!hasGrouping && activeHierarchyRowDrag) {
          const zone = hierarchyRowZone(tr, event.clientY);
          tr.removeClass("is-drop-before", "is-drop-after", "is-drop-parent-target");
          if (zone === "parent") {
            const draggedFiles = getDraggedHierarchyFiles(activeHierarchyRowDrag.dragPaths || []);
            if (!canReparentHierarchyFiles(draggedFiles, file)) { event.dataTransfer.dropEffect = "none"; return; }
            tr.addClass("is-drop-parent-target");
            event.dataTransfer.dropEffect = "move";
            return;
          }
          if (getHierarchyParentId(file) !== activeHierarchyRowDrag.parentId || activeHierarchyRowDrag.valid !== true) {
            event.dataTransfer.dropEffect = "none";
            return;
          }
          tr.toggleClass("is-drop-before", zone === "before");
          tr.toggleClass("is-drop-after", zone === "after");
          event.dataTransfer.dropEffect = "move";
          return;
        }
        if (hasGrouping) {
          // Always indicate an exact row boundary with the independent line.
          // Cross-group drops still update the grouping property on drop; they no
          // longer use the old full-row target rectangle.
          tr.removeClass("is-group-drop-target", "is-drop-before", "is-drop-after");
          showRowInsertIndicator(tr, after);
          return;
        }
        tr.toggleClass("is-drop-before", !after);
        tr.toggleClass("is-drop-after", after);
      });
      tr.addEventListener("dragleave", () => { tr.removeClass("is-drop-before", "is-drop-after", "is-group-drop-target", "is-drop-parent-target"); if (hasGrouping) hideRowInsertIndicator(); });
      tr.addEventListener("drop", async (event) => {
        const rect = tr.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        const hierarchyZone = (!hasGrouping && activeHierarchyRowDrag) ? hierarchyRowZone(tr, event.clientY) : null;
        tr.removeClass("is-drop-before", "is-drop-after", "is-group-drop-target", "is-drop-parent-target"); hideRowInsertIndicator();
        if (hasSort) return;
        if (hasGrouping) {
          const dragPaths = readDraggedPaths(event);
          if (!dragPaths.length) return;
          event.preventDefault();
          const sourceFiles = dragPaths.map((path) => files.find((candidate) => candidate.path === path)).filter(Boolean);
          const sameGroup = sourceFiles.length > 0 && sourceFiles.every((candidate) => this.getTableGroupKey(candidate, groupField) === item.groupKey);
          if (!sameGroup) {
            await commitGroupedDrop(dragPaths, item.groupKey, file.path, after);
            return;
          }

          // Same-group drag is a pure manual-order change. Keep all other groups
          // intact and insert the dragged block before/after the hovered row.
          const dragSet = new Set(dragPaths.map((path) => this.getItemIdByPath(path)).filter(Boolean));
          const targetId = this.getStableItemId(file);
          const baseOrder = view.manualOrder.length ? view.manualOrder.slice() : files.map((candidate) => this.getStableItemId(candidate)).filter(Boolean);
          for (const candidate of files) { const id = this.getStableItemId(candidate); if (id && !baseOrder.includes(id)) baseOrder.push(id); }
          const remaining = baseOrder.filter((id) => !dragSet.has(id));
          let targetIndex = remaining.indexOf(targetId);
          if (targetIndex < 0) targetIndex = remaining.length;
          if (after) targetIndex += 1;
          const orderedDragIds = baseOrder.filter((id) => dragSet.has(id));
          remaining.splice(Math.max(0, Math.min(remaining.length, targetIndex)), 0, ...orderedDragIds);
          view.manualOrder = remaining;
          await this.saveDefinition(databaseFile, definition);
          await this.loadAndRender(databaseFile);
          return;
        }
        const sourcePath = event.dataTransfer.getData("text/lmd-row");
        let dragPaths = [];
        try { dragPaths = JSON.parse(event.dataTransfer.getData("text/lmd-row-group") || "[]"); } catch (_) {}
        if (!Array.isArray(dragPaths) || dragPaths.length === 0) dragPaths = sourcePath ? [sourcePath] : [];
        dragPaths = files.map((item) => item.path).filter((path) => dragPaths.includes(path));
        if (!dragPaths.length) return;
        event.preventDefault();
        // Parent/child drag uses an intentional center zone to re-parent. Edge drops
        // remain sibling-only reorder, preserving the old no-accidental-escape rule.
        if (!hasGrouping && activeHierarchyRowDrag) {
          if (hierarchyZone === "parent") { await reparentHierarchyFiles(dragPaths, file); return; }
          if (await reorderHierarchySiblings(dragPaths, file, hierarchyZone === "after")) return;
        }
        const dragIds = dragPaths.map((path) => this.getItemIdByPath(path)).filter(Boolean);
        const dragSet = new Set(dragIds);
        const visibleOrder = files.map((item) => this.getStableItemId(item)).filter((id) => id && !dragSet.has(id));
        const targetId = this.getStableItemId(file);
        let targetIndex = visibleOrder.indexOf(targetId);
        // If the target itself is part of the dragged group, use its original visible
        // position as the boundary. This also makes dragging a selected block stable.
        if (targetIndex < 0) {
          const originalTargetIndex = files.findIndex((item) => item.path === file.path);
          targetIndex = files.slice(0, originalTargetIndex).filter((item) => !dragPaths.includes(item.path)).length;
        }
        if (after) targetIndex += 1;
        targetIndex = Math.max(0, Math.min(visibleOrder.length, targetIndex));
        visibleOrder.splice(targetIndex, 0, ...dragIds);

        if (hasFilter) {
          // A filtered drag only reorders the visible slots. Hidden rows keep their
          // exact places in the full per-view order, so clearing the filter is lossless.
          const visibleSet = new Set(files.map((item) => this.getStableItemId(item)).filter(Boolean));
          let visibleIndex = 0;
          view.manualOrder = view.manualOrder.map((id) =>
            visibleSet.has(id) ? visibleOrder[visibleIndex++] : id
          );
        } else {
          view.manualOrder = visibleOrder;
        }
        await this.saveDefinition(databaseFile, definition);
        // Manual reorder does not change schema/filter/group membership. Keep the
        // current table mounted and move only the affected row nodes; fall back to
        // the old full render if the DOM/order cannot be reconciled safely.
        if (!applyPlainRowOrderWithoutRender(visibleOrder)) await this.loadAndRender(databaseFile);
      });

      for (const column of columns) {
        if (column.id === "file.name") {
          const nameCell = tr.createEl("td", { cls: "lmd-db-name-cell lmd-db-data-cell" });
          nameCell.dataset.rowIndex = String(displayRowIndex);
          nameCell.dataset.columnIndex = String(columns.indexOf(column));
          applyFrozenPosition(nameCell, columns.indexOf(column));
          const nameColumnColor = normalizeOptionColor(view.columnColors[column.id]);
          const nameCellColor = normalizeOptionColor(view.cellColors[file.path]?.[column.id]);
          const effectiveNameColor = nameCellColor !== "default" ? nameCellColor : (nameColumnColor !== "default" ? nameColumnColor : rowColor);
          if (effectiveNameColor !== "default") nameCell.addClass(`lmd-db-effective-bg-${effectiveNameColor}`);
          const nameLine = nameCell.createDiv({ cls: "lmd-db-name-line" });
          const parentDepth = Number(parentDepthByPath.get(file.path)) || 0;
          if (parentDepth > 0) { nameLine.addClass("lmd-db-child-name-line"); nameLine.style.setProperty("--lmd-parent-depth", String(parentDepth)); }
          const stableItemId = this.getStableItemId(file);
          const hasChildRows = parentHasChildrenIds.has(stableItemId);
          // One icon, two independent states: left click keeps the existing attachment
          // behavior; right click toggles the child tree. This removes the permanent
          // empty chevron slot from rows without children while preserving both states.
          const bodyMarker = nameLine.createEl("button", { cls: "lmd-db-body-marker lmd-db-attachment-toggle", attr: { type: "button", title: "展開附屬", "aria-label": "展開附屬", "aria-expanded": "false" } });
          const isCanvas = this.isCanvasItem(file);
          setIcon(bodyMarker, isCanvas ? "layout-dashboard" : "file");
          const ownerKey = this.getAttachmentOwnerKey(file);
          if (!isCanvas && this.getExpandedAttachmentRows().has(ownerKey)) bodyMarker.setAttribute("aria-expanded", "true");
          const updateBodyMarkerHint = (hasBody = null) => {
            const collapsedParents = new Set(view.tableCollapsedParents || []);
            const childHint = hasChildRows ? (collapsedParents.has(stableItemId) ? "；右鍵展開子項目" : "；右鍵收合子項目") : "";
            if (isCanvas) {
              const label = `Canvas${childHint}`;
              bodyMarker.setAttribute("title", label); bodyMarker.setAttribute("aria-label", label);
            } else {
              const base = hasBody === true ? "有正文；點擊展開附屬" : hasBody === false ? "沒有正文；點擊展開附屬" : "點擊展開附屬";
              bodyMarker.setAttribute("title", `${base}${childHint}`); bodyMarker.setAttribute("aria-label", `${base}${childHint}`);
            }
          };
          updateBodyMarkerHint(null);
          if (!isCanvas) {
            void this.noteHasBodyContent(file).then((hasBody) => {
              if (!bodyMarker.isConnected) return;
              bodyMarker.empty();
              setIcon(bodyMarker, hasBody ? "file-text" : "file");
              updateBodyMarkerHint(hasBody);
            });
            bodyMarker.addEventListener("click", async (event) => {
              event.preventDefault(); event.stopPropagation();
              const isOpen = await this.toggleInlineAttachments(tr, file, columns.length + 1);
              bodyMarker.setAttribute("aria-expanded", isOpen ? "true" : "false");
            });
          } else {
            bodyMarker.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); });
          }
          if (hasChildRows) {
            bodyMarker.addEventListener("contextmenu", async (event) => {
              event.preventDefault(); event.stopPropagation();
              const next = new Set(view.tableCollapsedParents || []);
              if (next.has(stableItemId)) next.delete(stableItemId); else next.add(stableItemId);
              view.tableCollapsedParents = Array.from(next);
              await this.saveDefinition(databaseFile, definition);
              await this.loadAndRender(databaseFile);
            });
          }
          const nameInput = nameLine.createEl("input", { cls: "lmd-db-name-input", value: file.basename });
          // The name column is a native text-selection surface. Stop table-level
          // pointer/drag gestures here so a press-and-drag selects characters
          // instead of being interpreted as a cell/row interaction.
          nameInput.addEventListener("pointerdown", (event) => event.stopPropagation());
          nameInput.addEventListener("mousedown", (event) => event.stopPropagation());
          nameInput.addEventListener("dragstart", (event) => event.preventDefault());
          let initialName = file.basename;
          let nameComposing = false;
          nameInput.addEventListener("focus", () => this.beginEditorSession());
          nameInput.addEventListener("compositionstart", () => { nameComposing = true; this.beginCompositionSession(); });
          nameInput.addEventListener("compositionend", () => { nameComposing = false; this.endCompositionSession(); });
          nameInput.addEventListener("blur", () => this.endEditorSession());
          nameInput.addEventListener("change", async () => {
            if (nameComposing) return;
            const finalName = await this.renameRow(file, nameInput.value);
            initialName = finalName;
            nameInput.value = finalName;
          });
          nameInput.addEventListener("keydown", (event) => {
            if (event.isComposing || nameComposing || event.keyCode === 229) return;
            if (event.key === "Enter") nameInput.blur();
            if (event.key === "Escape") { nameInput.value = initialName; nameInput.blur(); }
          });
          nameInput.addEventListener("dblclick", (event) => {
            event.stopPropagation();
            void this.openDatabaseItem(file, databaseFile);
          });
          const openButton = nameLine.createEl("button", { cls: "lmd-db-open-button", attr: { type: "button", "aria-label": `開啟 ${file.basename}`, title: "開啟筆記" } });
          setIcon(openButton, "arrow-up-right");
          openButton.addEventListener("click", () => void this.openDatabaseItem(file, databaseFile));
        } else {
          const td = tr.createEl("td", { cls: "lmd-db-data-cell" });
          td.dataset.rowIndex = String(displayRowIndex);
          td.dataset.columnIndex = String(columns.indexOf(column));
          applyFrozenPosition(td, columns.indexOf(column));
          const columnColor = normalizeOptionColor(view.columnColors[column.id]);
          const cellColor = normalizeOptionColor(view.cellColors[file.path]?.[column.id]);
          const effectiveColor = cellColor !== "default" ? cellColor : (columnColor !== "default" ? columnColor : rowColor);
          if (effectiveColor !== "default") td.addClass(`lmd-db-effective-bg-${effectiveColor}`);
          this.createCellEditor(td, file, column, this.getColumnValue(file, column));
        }
      }

      if (this.getExpandedAttachmentRows().has(this.getAttachmentOwnerKey(file))) {
        void this.ensureInlineAttachmentRow(tr, file, columns.length + 1);
      }
    }


    if (!hasGrouping) {
      const bottomAddTr = tbody.createEl("tr", { cls: "lmd-db-table-bottom-add-row" });
      const bottomAddTd = bottomAddTr.createEl("td", { cls: "lmd-db-table-bottom-add-cell", attr: { colspan: String(columns.length + 1) } });
      const bottomAddButton = bottomAddTd.createEl("button", { cls: "lmd-db-table-bottom-add-button", attr: { type: "button" } });
      bottomAddTr.addEventListener("dragenter", hideRowInsertIndicator);
      bottomAddTr.addEventListener("dragover", hideRowInsertIndicator);
      setIcon(bottomAddButton, "plus");
      bottomAddButton.createSpan({ text: "新增資料列" });
      bottomAddButton.addEventListener("click", () => void this.createRowForView(source, view, schema));
    }

    const activateSplitFreeze = () => {
      if (renderFreezeColumns <= 0) {
        freezeMask.remove();
        return;
      }

      // 0.7.1 — real two-pane Freeze. Frozen cells are physically moved into
      // a separate table. No sticky, mask, clip-path, transform, or z-index
      // overlap remains between frozen and scrolling columns.
      freezeMask.remove();
      for (const el of tableWrap.querySelectorAll(".lmd-db-frozen-cell, .lmd-db-frozen-handle")) {
        el.style.left = "";
        el.style.clipPath = "";
      }
      for (const el of tableWrap.querySelectorAll("th, td")) el.style.clipPath = "";

      const split = document.createElement("div");
      split.className = "lmd-db-split-freeze";
      const frozenPane = document.createElement("div");
      frozenPane.className = "lmd-db-frozen-pane";
      const scrollPane = document.createElement("div");
      scrollPane.className = "lmd-db-scroll-pane";
      split.appendChild(frozenPane);
      split.appendChild(scrollPane);
      tableWrap.insertBefore(split, table);
      scrollPane.appendChild(table);
      tableWrap._lmdHorizontalScroller = scrollPane;

      const frozenTable = document.createElement("table");
      frozenTable.className = "lmd-db-table lmd-db-frozen-pane-table";
      frozenPane.appendChild(frozenTable);
      const frozenColgroup = document.createElement("colgroup");
      frozenTable.appendChild(frozenColgroup);

      const originalCols = Array.from(colgroup.children);
      if (originalCols[0]) frozenColgroup.appendChild(originalCols[0]);
      for (let i = 0; i < renderFreezeColumns; i++) {
        const col = originalCols[i + 1];
        if (col) frozenColgroup.appendChild(col);
      }

      const frozenThead = document.createElement("thead");
      const frozenHeaderRow = document.createElement("tr");
      frozenThead.appendChild(frozenHeaderRow);
      frozenTable.appendChild(frozenThead);
      frozenHeaderRow.appendChild(headerSelectHead);
      const originalHeads = Array.from(headerRow.querySelectorAll("th.lmd-db-column-head"));
      for (let i = 0; i < renderFreezeColumns; i++) {
        if (originalHeads[i]) frozenHeaderRow.appendChild(originalHeads[i]);
      }

      const frozenTbody = document.createElement("tbody");
      frozenTable.appendChild(frozenTbody);
      const rowPairs = [];
      for (const scrollRow of Array.from(tbody.querySelectorAll("tr.lmd-db-row"))) {
        const frozenRow = document.createElement("tr");
        frozenRow.className = scrollRow.className;
        frozenRow.dataset.path = scrollRow.dataset.path || "";
        const cells = Array.from(scrollRow.children);
        if (cells[0]) frozenRow.appendChild(cells[0]);
        for (let i = 0; i < renderFreezeColumns; i++) {
          const cell = cells[i + 1];
          if (cell) frozenRow.appendChild(cell);
        }
        frozenTbody.appendChild(frozenRow);
        rowPairs.push([frozenRow, scrollRow]);
      }

      splitFreezeState = { split, frozenPane, scrollPane, frozenTable, frozenHeaderRow, frozenTbody, rowPairs };
      syncTableWidth();

      const syncSelectionVisuals = () => {
        for (const [frozenRow, scrollRow] of rowPairs) {
          const selected = selectedPaths.has(frozenRow.dataset.path || "");
          frozenRow.classList.toggle("is-selected", selected);
          scrollRow.classList.toggle("is-selected", selected);
        }
        frozenHeaderRow.classList.toggle("is-header-row-selected", selectedHeaderRow);
        headerRow.classList.toggle("is-header-row-selected", selectedHeaderRow);
      };
      split.addEventListener("click", () => queueMicrotask(syncSelectionVisuals), true);
      split.addEventListener("pointerup", () => queueMicrotask(syncSelectionVisuals), true);

      let heightRaf = 0;
      const syncRowHeights = () => {
        heightRaf = 0;
        const headerHeight = Math.max(frozenHeaderRow.getBoundingClientRect().height, headerRow.getBoundingClientRect().height);
        frozenHeaderRow.style.height = `${headerHeight}px`;
        headerRow.style.height = `${headerHeight}px`;
        for (const [frozenRow, scrollRow] of rowPairs) {
          // Measure natural content height, not the height we wrote during a previous
          // editing session. Otherwise opening/closing an empty textarea can ratchet
          // the row taller forever until the view is rebuilt.
          frozenRow.style.height = "";
          scrollRow.style.height = "";
          const height = Math.max(frozenRow.getBoundingClientRect().height, scrollRow.getBoundingClientRect().height);
          frozenRow.style.height = `${height}px`;
          scrollRow.style.height = `${height}px`;
        }
      };
      const scheduleHeightSync = () => {
        if (heightRaf) cancelAnimationFrame(heightRaf);
        heightRaf = requestAnimationFrame(syncRowHeights);
      };
      scheduleHeightSync();
      requestAnimationFrame(scheduleHeightSync);
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(scheduleHeightSync);
        ro.observe(frozenHeaderRow); ro.observe(headerRow);
        for (const [a, b] of rowPairs) { ro.observe(a); ro.observe(b); }
        this.register(() => ro.disconnect());
      }
      scrollPane.addEventListener("scroll", () => {
        // Horizontal scrolling belongs exclusively to the scrolling pane.
        // Frozen pane never moves.
      }, { passive: true });
      syncSelectionVisuals();
    };

    activateSplitFreeze();

    // 0.12.8-r1 — Do not append a separate end-of-list drop strip below the
    // table. The lower half of the last real row is already the exact "move to
    // end" target; a second strip could overlap the bottom “新增資料列” row.


    if (files.length === 0) {
      this.contentEl.createDiv({ cls: "lmd-db-empty-state", text: "目前沒有資料。按「+ 新增資料列」建立第一筆 Markdown。" });
    }

    this.contentEl.createDiv({ cls: "lmd-db-footer", text: `${files.length} / ${rawFiles.length} 筆資料 · ${schema.length} 個 property 欄位 · ${hasGrouping ? `依「${groupField.name || groupField.id}」分組（可組內排序／跨組拖曳）` : hasSort ? "目前套用排序（手動拖曳暫停）" : hasFilter ? "目前套用篩選（可手動拖曳可見資料列）" : "手動排序已啟用"}` });
  }
}


function parseEmbeddedDatabaseSpec(source) {
  const spec = { database: "", databaseId: "", view: "", viewId: "" };
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(database|db|database-id|db-id|view|view-id)\s*:\s*(.+)$/i.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith("[[") && value.endsWith("]]")) value = value.slice(2, -2).split("|")[0].trim();
    if (/^(database|db)$/i.test(match[1])) spec.database = value;
    else if (/^(database-id|db-id)$/i.test(match[1])) spec.databaseId = value;
    else if (/^view-id$/i.test(match[1])) spec.viewId = value;
    else spec.view = value;
  }
  return spec;
}

function findDatabaseFileForEmbed(app, requested, sourcePath = "") {
  let value = normalizePath(String(requested || "").trim());
  if (!value) return null;
  if (!value.toLowerCase().endsWith(`.${DATABASE_EXTENSION}`)) value += `.${DATABASE_EXTENSION}`;
  const direct = app.vault.getAbstractFileByPath(value);
  if (direct instanceof TFile && direct.extension === DATABASE_EXTENSION) return direct;

  // Resolve relative to the Markdown note first.
  const baseDir = normalizePath(String(sourcePath || "").split("/").slice(0, -1).join("/"));
  if (baseDir) {
    const relative = app.vault.getAbstractFileByPath(normalizePath(`${baseDir}/${value}`));
    if (relative instanceof TFile && relative.extension === DATABASE_EXTENSION) return relative;
  }

  const wantedName = value.split("/").pop()?.toLowerCase();
  const matches = app.vault.getFiles().filter((file) => file.extension === DATABASE_EXTENSION && file.name.toLowerCase() === wantedName);
  return matches.length === 1 ? matches[0] : null;
}

class EmbeddedDatabaseRenderChild extends MarkdownRenderChild {
  constructor(containerEl, renderer) {
    super(containerEl);
    this.renderer = renderer;
  }
  onunload() {
    try { this.renderer?.plugin?.unregisterLiveDatabaseRenderer?.(this.renderer); } catch (_) {}
    try { this.renderer?.renderAbortController?.abort(); } catch (_) {}
    try {
      for (const bar of document.body.querySelectorAll('.lmd-db-floating-hscroll[data-embedded-owner="1"]')) bar.remove();
    } catch (_) {}
  }
}


class InsertDatabaseViewModal extends Modal {
  constructor(app, plugin, editor) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.databaseFiles = [];
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lmd-db-insert-modal");
    contentEl.createEl("h2", { text: "插入 Database View" });
    contentEl.createDiv({ cls: "setting-item-description", text: "選擇 Database 與 View，插件會自動把內嵌語法插入目前 Markdown。" });

    this.databaseFiles = this.app.vault.getFiles()
      .filter((file) => file.extension === DATABASE_EXTENSION)
      .sort((a, b) => a.path.localeCompare(b.path, "zh-Hant"));

    if (!this.databaseFiles.length) {
      contentEl.createDiv({ cls: "lmd-db-embed-error", text: "Vault 裡目前沒有 .database 檔案。" });
      return;
    }

    const databaseSetting = new Setting(contentEl).setName("Database");
    const viewSetting = new Setting(contentEl).setName("View");
    let databaseSelect;
    let viewSelect;
    let currentDefinition = null;

    const refreshViews = async (path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      currentDefinition = file instanceof TFile ? await this.plugin.readDatabaseDefinition(file) : null;
      if (currentDefinition && file instanceof TFile && !currentDefinition.id) {
        currentDefinition.id = generateSourceId();
        try { await this.app.vault.modify(file, JSON.stringify(currentDefinition, null, 2)); } catch (_) {}
      }
      if (currentDefinition) {
        const helper = Object.create(DatabaseFileView.prototype);
        helper.app = this.app;
        helper.plugin = this.plugin;
        helper.ensureViewState(currentDefinition, Array.isArray(currentDefinition.schema) ? currentDefinition.schema : []);
      }
      if (!viewSelect) return;
      viewSelect.selectEl.empty();
      const views = Array.isArray(currentDefinition?.views) ? currentDefinition.views : [];
      if (!views.length) {
        viewSelect.addOption("", "目前 View");
        return;
      }
      for (const view of views) viewSelect.addOption(String(view.id || ""), String(view.name || view.type || "View"));
      const active = currentDefinition?.activeViewId;
      if (active && views.some((view) => view.id === active)) viewSelect.setValue(active);
      else viewSelect.setValue(String(views[0]?.id || ""));
    };

    databaseSetting.addDropdown((dropdown) => {
      databaseSelect = dropdown;
      for (const file of this.databaseFiles) dropdown.addOption(file.path, file.path);
      dropdown.onChange((value) => void refreshViews(value));
    });
    viewSetting.addDropdown((dropdown) => { viewSelect = dropdown; });

    const initialPath = this.databaseFiles[0].path;
    databaseSelect.setValue(initialPath);
    await refreshViews(initialPath);

    const actions = contentEl.createDiv({ cls: "lmd-db-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const insertButton = actions.createEl("button", { cls: "mod-cta", text: "插入" });
    insertButton.addEventListener("click", () => {
      const databasePath = databaseSelect.getValue();
      const selectedViewId = viewSelect.getValue();
      const view = (currentDefinition?.views || []).find((item) => String(item.id || "") === selectedViewId);
      const viewLabel = view?.name || selectedViewId;
      const lines = ["```lmd-database", `database: ${databasePath}`];
      if (currentDefinition?.id) lines.push(`database-id: ${currentDefinition.id}`);
      if (selectedViewId) lines.push(`view-id: ${selectedViewId}`);
      if (viewLabel) lines.push(`view: ${viewLabel}`);
      lines.push("```", "");
      this.editor?.replaceSelection(lines.join("\n"));
      this.close();
    });
  }
}


module.exports = class LocalMarkdownDatabasePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this._liveDatabaseRenderers = new Set();
    this.addSettingTab(new LocalMarkdownDatabaseSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_DATABASE, (leaf) => new DatabaseFileView(leaf, this));
    this.registerExtensions([DATABASE_EXTENSION], VIEW_TYPE_DATABASE);

    // Obsidian Mobile/iPadOS can restore an unknown-extension file leaf before a
    // community plugin's registerExtensions mapping has taken effect. In that
    // case the .database file appears as a completely blank leaf. Desktop usually
    // rebinds it automatically; mobile often does not. Actively repair any open
    // .database leaf and switch it to LMD's FileView.
    const ensureMobileDatabaseLeaf = async (file = null) => {
      if (!isLmdMobileRuntime()) return;
      const target = file instanceof TFile ? file : this.app.workspace.getActiveFile?.();
      if (!(target instanceof TFile) || target.extension !== DATABASE_EXTENSION) return;
      const repairs = [];
      const visit = (leaf) => {
        try {
          const state = leaf?.getViewState?.();
          const stateFile = normalizePath(state?.state?.file || leaf?.view?.file?.path || "");
          if (stateFile !== normalizePath(target.path)) return;
          if (state?.type === VIEW_TYPE_DATABASE || leaf?.view?.getViewType?.() === VIEW_TYPE_DATABASE) return;
          repairs.push(leaf.setViewState({
            type: VIEW_TYPE_DATABASE,
            state: { file: target.path },
            active: true,
          }));
        } catch (error) { console.error("Local Markdown Database: mobile leaf repair failed", error); }
      };
      if (typeof this.app.workspace.iterateAllLeaves === "function") this.app.workspace.iterateAllLeaves(visit);
      else visit(this.app.workspace.activeLeaf);
      if (repairs.length) {
        try { await Promise.allSettled(repairs); } catch (_) {}
      }
    };
    this._ensureMobileDatabaseLeaf = ensureMobileDatabaseLeaf;
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (file instanceof TFile && file.extension === DATABASE_EXTENSION)
        setTimeout(() => void ensureMobileDatabaseLeaf(file), 0);
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      const file = this.app.workspace.getActiveFile?.();
      if (file instanceof TFile && file.extension === DATABASE_EXTENSION)
        setTimeout(() => void ensureMobileDatabaseLeaf(file), 0);
    }));
    this.app.workspace.onLayoutReady(() => {
      const file = this.app.workspace.getActiveFile?.();
      if (file instanceof TFile && file.extension === DATABASE_EXTENSION)
        setTimeout(() => void ensureMobileDatabaseLeaf(file), 50);
    });
    this.registerMarkdownCodeBlockProcessor("lmd-database", async (source, el, ctx) => {
      const spec = parseEmbeddedDatabaseSpec(source);
      let databaseFile = spec.databaseId ? await this.findDatabaseFileById(spec.databaseId) : null;
      if (!(databaseFile instanceof TFile)) databaseFile = findDatabaseFileForEmbed(this.app, spec.database, ctx.sourcePath);
      el.empty();
      el.addClass("lmd-db-embed-host");
      if (!(databaseFile instanceof TFile)) {
        el.createDiv({ cls: "lmd-db-embed-error", text: spec.database || spec.databaseId ? `找不到 Database：${spec.database || spec.databaseId}` : "請指定 database: 路徑.database" });
        return;
      }
      let definition;
      try { definition = JSON.parse(await this.app.vault.read(databaseFile)); }
      catch (error) { el.createDiv({ cls: "lmd-db-embed-error", text: `Database 讀取失敗：${String(error)}` }); return; }
      if (!isDatabaseDefinition(definition)) { el.createDiv({ cls: "lmd-db-embed-error", text: "這個 .database 檔案格式無效。" }); return; }

      // Ensure legacy databases have a view list before resolving the requested view.
      const renderer = Object.create(DatabaseFileView.prototype);
      renderer.app = this.app;
      renderer.plugin = this;
      renderer.contentEl = el;
      renderer.containerEl = el;
      renderer.databaseFile = databaseFile;
      // Each embed receives its own in-memory definition so local filters/sorts
      // cannot leak into the source database or another embed instance.
      definition = JSON.parse(JSON.stringify(definition));
      renderer.definition = definition;
      renderer.isEmbedded = true;
      renderer._localValueOverlay = new Map();
      renderer._editorDepth = 0;
      renderer._compositionDepth = 0;
      renderer._pendingExternalRefresh = false;
      renderer._pendingDefinitionRefresh = false;
      renderer.renderAbortController = new AbortController();
      el.addClass("lmd-db-view", "lmd-db-embedded");
      if (isLmdMobileRuntime()) el.addClass("lmd-db-mobile-runtime");

      // We only need schema to migrate the view list; renderDatabase will resolve
      // the effective schema again using the real source.
      renderer.ensureViewState(definition, Array.isArray(definition.schema) ? definition.schema : []);
      if (spec.viewId || spec.view) {
        const wantedId = String(spec.viewId || "").trim().toLowerCase();
        const wanted = String(spec.view || "").trim().toLowerCase();
        const entry = definition.views.find((item) => (wantedId && String(item.id || "").toLowerCase() === wantedId) || (!wantedId && (String(item.id || "").toLowerCase() === wanted || String(item.name || "").toLowerCase() === wanted)));
        if (!entry) {
          el.createDiv({ cls: "lmd-db-embed-error", text: `找不到 View：${spec.viewId || spec.view}` });
          return;
        }
        definition.activeViewId = entry.id;
      }
      const section = typeof ctx.getSectionInfo === "function" ? ctx.getSectionInfo(el) : null;
      const lineStart = Number.isFinite(Number(section?.lineStart)) ? Number(section.lineStart) : 0;
      const databaseIdentity = String(definition.id || normalizePath(databaseFile.path));
      renderer.embedInstancePrefix = [normalizePath(ctx.sourcePath || ""), databaseIdentity, String(lineStart)].join("::");

      // Once an embed owns a local tab structure, restore that structure instead of
      // reading the source database's View list. This is the hard separation between
      // main-database Views and per-document child Views. Data/schema are still shared.
      const localViewStructure = this.getEmbeddedViewStructure(renderer.embedInstancePrefix);
      if (localViewStructure?.views?.length) {
        definition.views = localViewStructure.views.map((entry) => ({
          id: String(entry.id || ""),
          name: String(entry.name || "View"),
          type: ["board", "calendar", "timeline"].includes(entry.type) ? entry.type : "table",
          state: entry.state && typeof entry.state === "object" ? JSON.parse(JSON.stringify(entry.state)) : {},
        })).filter((entry) => entry.id);
        if (!definition.views.some((entry) => entry.id === definition.activeViewId)) definition.activeViewId = definition.views[0]?.id || "";
        renderer.ensureViewState(definition, Array.isArray(definition.schema) ? definition.schema : []);
      }

      const persistedActiveView = this.getEmbeddedActiveView(renderer.embedInstancePrefix);
      if (persistedActiveView && definition.views.some((item) => item?.id === persistedActiveView)) definition.activeViewId = persistedActiveView;
      renderer.embedStateKey = renderer.getEmbedStateKey(definition.activeViewId);
      const legacyEmbedStateKey = [normalizePath(ctx.sourcePath || ""), normalizePath(databaseFile.path), String(definition.activeViewId || ""), String(lineStart)].join("::");
      let persistedEmbedState = this.getPortableEmbeddedViewState(definition, renderer.embedInstancePrefix, definition.activeViewId) || this.getEmbeddedViewState(renderer.embedStateKey);
      if (!persistedEmbedState && legacyEmbedStateKey !== renderer.embedStateKey) {
        persistedEmbedState = this.getEmbeddedViewState(legacyEmbedStateKey);
        if (persistedEmbedState) void this.saveEmbeddedViewState(renderer.embedStateKey, persistedEmbedState);
      }
      if (persistedEmbedState) {
        const activeEntry = definition.views.find((item) => item?.id === definition.activeViewId);
        if (activeEntry) activeEntry.state = Object.assign({}, activeEntry.state || {}, persistedEmbedState);
        renderer.ensureViewState(definition, Array.isArray(definition.schema) ? definition.schema : []);
      }
      const child = new EmbeddedDatabaseRenderChild(el, renderer);
      ctx.addChild(child);
      this.registerLiveDatabaseRenderer(renderer);
      try { await renderer.renderDatabase(databaseFile, definition); }
      catch (error) { console.error("Local Markdown Database: embedded render failed", error); el.empty(); el.createDiv({ cls: "lmd-db-embed-error", text: `內嵌 Database 渲染失敗：${String(error)}` }); }
    });
    // 0.17.0-hotfix.1 — note-side panels are leaf-owned only.
    // Markdown post processors execute once per rendered section, so using them as a mount
    // point can create duplicate Parent/Child panels in a single note. Keep this hook only as
    // a refresh signal; mountNoteChildPanelForLeaf owns the actual DOM instance.
    this.registerMarkdownPostProcessor((_el, ctx) => {
      const sourcePath = normalizePath(ctx?.sourcePath || "");
      if (!sourcePath || !sourcePath.toLowerCase().endsWith(".md")) return;
      this.scheduleNoteChildPanelRefresh(30);
    });

    // 0.16.1-hotfix.2 — leaf-driven child panel mounting.
    // Markdown post processors are section-scoped and their DOM ancestry changes across
    // Obsidian versions. Keep the processor as a harmless fallback, but make the panel
    // lifecycle follow Markdown leaves directly so opening a note or switching mode always
    // gets another deterministic mount attempt.
    this._noteChildPanelRefreshTimer = 0;
    const scheduleChildPanels = () => this.scheduleNoteChildPanelRefresh(60);
    this.registerEvent(this.app.workspace.on("active-leaf-change", scheduleChildPanels));
    this.registerEvent(this.app.workspace.on("layout-change", scheduleChildPanels));
    try { this.registerEvent(this.app.workspace.on("file-open", scheduleChildPanels)); } catch (_) {}
    this.app.workspace.onLayoutReady(() => this.scheduleNoteChildPanelRefresh(0));

    // Folder moves fire a burst of rename events (folder + children). Process them
    // strictly in order so a later child event cannot write an older database
    // definition over the source.path that the folder event just updated.
    this.renameEventQueue = Promise.resolve();
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      const event = {
        oldPath: String(oldPath || ""),
        newPath: String(file?.path || ""),
        isFolder: file instanceof TFolder,
        isFile: file instanceof TFile,
        extension: file instanceof TFile ? file.extension : "",
        name: file?.name || "",
      };
      this.renameEventQueue = this.renameEventQueue
        .then(() => this.handleVaultRename(event))
        .catch((error) => console.error("Local Markdown Database: rename tracking failed", error));
    }));
    this._databaseModifyTimers = new Map();
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || file.extension !== DATABASE_EXTENSION) return;
      const key = normalizePath(file.path);
      if (Number(this._portableStateWriteUntil?.get(key) || 0) >= Date.now()) {
        this._portableStateWriteUntil.delete(key);
        return;
      }
      const prior = this._databaseModifyTimers.get(key);
      if (prior) window.clearTimeout(prior);
      const timer = window.setTimeout(() => {
        this._databaseModifyTimers.delete(key);
        void this.broadcastDatabaseDefinitionChange(file).catch((error) =>
          console.error("Local Markdown Database: database modify refresh failed", error));
      }, 80);
      this._databaseModifyTimers.set(key, timer);
    }));
    this.addCommand({
      id: "create-local-markdown-database",
      name: "建立 Database",
      callback: () => void this.createDatabaseFile(),
    });
    this.addCommand({
      id: "insert-local-markdown-database-view",
      name: "插入 Database View",
      editorCallback: (editor) => new InsertDatabaseViewModal(this.app, this, editor).open(),
    });
    this.addCommand({
      id: "expand-context-attachments-to-canvas",
      name: "附屬：展開目前筆記到 Canvas",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") { new Notice("請先開啟一篇 Markdown 筆記。"); return; }
        void this.expandContextAttachmentsToCanvas(file);
      },
    });
    this.addCommand({
      id: "collapse-context-attachments-in-canvas",
      name: "附屬：收起目前筆記的 Canvas 附屬",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") { new Notice("請先開啟一篇 Markdown 筆記。"); return; }
        void this.collapseContextAttachmentsInCanvas(file);
      },
    });
  }

  scheduleNoteChildPanelRefresh(delay = 40) {
    if (this._noteChildPanelRefreshTimer) window.clearTimeout(this._noteChildPanelRefreshTimer);
    this._noteChildPanelRefreshTimer = window.setTimeout(() => {
      this._noteChildPanelRefreshTimer = 0;
      void this.refreshNoteChildPanels().catch((error) => console.error("Local Markdown Database: note child panel leaf refresh failed", error));
    }, Math.max(0, Number(delay) || 0));
  }

  async refreshNoteChildPanels() {
    const leaves = this.app.workspace.getLeavesOfType?.("markdown") || [];
    for (const leaf of leaves) {
      try { await this.mountNoteChildPanelForLeaf(leaf); }
      catch (error) { console.error("Local Markdown Database: note child panel leaf mount failed", error); }
    }
  }

  async mountNoteChildPanelForLeaf(leaf) {
    const view = leaf?.view;
    const file = view?.file;
    const root = view?.containerEl instanceof HTMLElement ? view.containerEl : null;
    if (!root) return;

    // Remove stale hosts if the leaf was reused for another file.
    const currentPath = file instanceof TFile && file.extension === "md" ? normalizePath(file.path) : "";
    for (const host of Array.from(root.querySelectorAll?.(".lmd-db-note-child-panel[data-lmd-leaf-panel='1']") || [])) {
      if (!currentPath || host.dataset.sourcePath !== currentPath) host.remove();
    }
    if (!currentPath) return;

    // Resolve the data model first. If the note is not a Database item there should be no panel.
    const context = await this.resolveNoteChildPanelContext(currentPath);
    if (!context) {
      for (const host of Array.from(root.querySelectorAll?.(`.lmd-db-note-child-panel[data-source-path="${CSS.escape(currentPath)}"]`) || [])) host.remove();
      return;
    }

    // Reading mode: mount at the end of the rendered note.
    const readingTarget = root.querySelector?.(".markdown-preview-view .markdown-preview-sizer")
      || root.querySelector?.(".markdown-reading-view .markdown-preview-sizer")
      || root.querySelector?.(".markdown-preview-view .markdown-rendered")
      || root.querySelector?.(".markdown-reading-view .markdown-rendered");

    // Live Preview/source mode: mount inside the CodeMirror scroller, after the editor content.
    // This is intentionally a sibling of cm-content, never a child of cm-content itself, so
    // CodeMirror cannot treat the panel as editable document content.
    const sourceView = root.querySelector?.(".markdown-source-view.mod-cm6");
    const sourceScroller = sourceView?.querySelector?.(".cm-scroller");
    const target = readingTarget instanceof HTMLElement ? readingTarget
      : sourceScroller instanceof HTMLElement ? sourceScroller
      : null;
    if (!(target instanceof HTMLElement)) return;

    // Keep exactly one leaf-owned panel for this note. Remove every stale/legacy duplicate
    // before choosing the surviving host; this also repairs notes that already accumulated
    // several post-processor panels in an earlier version.
    const selector = `.lmd-db-note-child-panel[data-source-path="${CSS.escape(currentPath)}"]`;
    const existingHosts = Array.from(root.querySelectorAll?.(selector) || []).filter((el) => el instanceof HTMLElement);
    let host = existingHosts.find((el) => el.parentElement === target) || null;
    for (const candidate of existingHosts) {
      if (candidate !== host) candidate.remove();
    }
    if (!(host instanceof HTMLElement)) {
      host = document.createElement("div");
      host.className = "lmd-db-note-child-panel";
      host.dataset.sourcePath = currentPath;
      target.appendChild(host);
    }
    host.dataset.lmdLeafPanel = "1";
    if (host.parentElement !== target) target.appendChild(host);
    await this.renderNoteChildPanel(host, currentPath);
  }

  async resolveNoteChildPanelContext(sourcePath) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(sourcePath || ""));
    if (!(file instanceof TFile) || file.extension !== "md") return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter || {};
    const itemId = typeof fm["lmd-id"] === "string" ? fm["lmd-id"].trim() : "";
    let databaseRef = typeof fm["lmd-database"] === "string" ? fm["lmd-database"].trim() : "";
    if (!itemId || !databaseRef) return null;
    databaseRef = stripWikiLink(databaseRef);
    let databaseFile = this.app.vault.getAbstractFileByPath(normalizePath(databaseRef));
    if (!(databaseFile instanceof TFile) && !databaseRef.toLowerCase().endsWith(".database")) {
      databaseFile = this.app.vault.getAbstractFileByPath(normalizePath(`${databaseRef}.database`));
    }
    // lmd-database is intentionally stored as a normal Obsidian wikilink. When the
    // database lives outside the note folder, the frontmatter cache often exposes only
    // the link text/basename, so resolve it with Obsidian's link resolver before giving up.
    if (!(databaseFile instanceof TFile)) {
      const resolved = this.app.metadataCache.getFirstLinkpathDest?.(databaseRef, file.path);
      if (resolved instanceof TFile && resolved.extension === DATABASE_EXTENSION) databaseFile = resolved;
    }
    if (!(databaseFile instanceof TFile)) {
      const wanted = `${databaseRef.toLowerCase().endsWith(".database") ? databaseRef : `${databaseRef}.database`}`.split("/").pop()?.toLowerCase();
      const matches = this.app.vault.getFiles().filter((candidate) => candidate.extension === DATABASE_EXTENSION && candidate.name.toLowerCase() === wanted);
      if (matches.length === 1) databaseFile = matches[0];
    }
    if (!(databaseFile instanceof TFile) || databaseFile.extension !== DATABASE_EXTENSION) return null;
    let definition;
    try { definition = JSON.parse(await this.app.vault.read(databaseFile)); }
    catch (_) { return null; }
    if (!isDatabaseDefinition(definition)) return null;

    const sourcePathNorm = normalizePath(definition.source?.path || "");
    const source = sourcePathNorm ? this.app.vault.getAbstractFileByPath(sourcePathNorm) : this.app.vault.getRoot();
    if (!(source instanceof TFolder)) return null;
    const files = source.children.filter((candidate) => candidate instanceof TFile && ["md", "canvas"].includes(String(candidate.extension || "").toLowerCase()));
    const canvasStore = definition.canvasItems && typeof definition.canvasItems === "object" ? definition.canvasItems : {};
    const getId = (candidate) => {
      if (!(candidate instanceof TFile)) return "";
      if (candidate.extension === "canvas") {
        const match = Object.values(canvasStore).find((entry) => entry && normalizePath(entry.path || "") === normalizePath(candidate.path));
        return typeof match?.id === "string" ? match.id.trim() : "";
      }
      const meta = this.app.metadataCache.getFileCache(candidate)?.frontmatter || {};
      return typeof meta["lmd-id"] === "string" ? meta["lmd-id"].trim() : "";
    };
    const getParent = (candidate) => {
      if (!(candidate instanceof TFile)) return "";
      if (candidate.extension === "canvas") {
        const match = Object.values(canvasStore).find((entry) => entry && normalizePath(entry.path || "") === normalizePath(candidate.path));
        return typeof match?.parentId === "string" ? match.parentId.trim() : "";
      }
      const meta = this.app.metadataCache.getFileCache(candidate)?.frontmatter || {};
      return typeof meta["lmd-parent"] === "string" ? meta["lmd-parent"].trim() : "";
    };
    const byId = new Map();
    const children = new Map();
    for (const candidate of files) {
      const id = getId(candidate);
      if (id) byId.set(id, candidate);
    }
    for (const candidate of files) {
      const parentId = getParent(candidate);
      if (!parentId || !byId.has(parentId)) continue;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(candidate);
    }
    const schema = Array.isArray(definition.schema) ? definition.schema.filter((field) => field?.id && !isSystemMetadataField(field.id)) : [];
    const checkboxField = schema.find((field) => field.type === "checkbox" && field.hierarchicalProgress === true) || null;
    const statusField = schema.find((field) => field.type === "single-select" && /^(status|狀態|進度)$/i.test(String(field.name || field.id || "").trim()))
      || schema.find((field) => field.type === "single-select") || null;
    return { file, itemId, databaseFile, definition, source, files, byId, children, getId, getParent, checkboxField, statusField };
  }

  async createChildFromNotePanel(context) {
    if (!context?.source || !context?.itemId || !(context.databaseFile instanceof TFile)) return null;
    if (context.definition?.source?.type !== "folder") { new Notice("目前只支援在單一資料夾來源中直接新增子項目。"); return null; }
    let index = 1;
    let baseName = "Untitled";
    let path = normalizePath(context.source.path ? `${context.source.path}/${baseName}.md` : `${baseName}.md`);
    while (this.app.vault.getAbstractFileByPath(path)) {
      index += 1;
      baseName = `Untitled ${index}`;
      path = normalizePath(context.source.path ? `${context.source.path}/${baseName}.md` : `${baseName}.md`);
    }
    const file = await this.app.vault.create(path, "");
    const itemId = `lmd-item-${generateSourceId()}`;
    const initialize = this.settings?.initializeSchemaFieldsOnCreate === true;
    const emptyValue = (field) => {
      if (field?.type === "checkbox") return false;
      if (field?.type === "multi-select" || field?.type === "relation") return [];
      if (field?.type === "number") return null;
      return "";
    };
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm["lmd-id"] = itemId;
      fm["lmd-parent"] = context.itemId;
      fm["lmd-database"] = `[[${context.databaseFile.path}]]`;
      if (initialize) for (const field of context.definition.schema || []) {
        if (!field?.id || isSystemMetadataField(field.id) || Object.prototype.hasOwnProperty.call(fm, field.id)) continue;
        fm[field.id] = emptyValue(field);
      }
    });
    // Keep manual order deterministic in all main Database views.
    try {
      const raw = await this.app.vault.read(context.databaseFile);
      const latest = JSON.parse(raw);
      if (Array.isArray(latest.views)) for (const entry of latest.views) {
        const state = entry?.state;
        if (!state || typeof state !== "object") continue;
        if (!Array.isArray(state.manualOrder)) state.manualOrder = [];
        if (!state.manualOrder.includes(itemId)) state.manualOrder.push(itemId);
      }
      await this.app.vault.modify(context.databaseFile, JSON.stringify(latest, null, 2));
    } catch (error) { console.warn("Local Markdown Database: child panel manual order update failed", error); }
    new Notice(`已新增子項目：${file.basename}`);
    return file;
  }

  async writeNoteHierarchicalCheckbox(context, file, field, targetChecked) {
    if (!context || !(context.databaseFile instanceof TFile) || !field?.id || !(file instanceof TFile)) return false;
    const helper = Object.create(DatabaseFileView.prototype);
    helper.app = this.app;
    helper.plugin = this;
    helper.settings = this.settings;
    helper.definition = context.definition;
    helper.databaseFile = context.databaseFile;
    helper.isEmbedded = false;
    helper._localValueOverlay = new Map();
    return await helper.writeHierarchicalCheckbox(file, field, targetChecked);
  }

  async renderNoteChildPanel(host, sourcePath) {
    if (!(host instanceof HTMLElement) || !host.isConnected) return;
    const context = await this.resolveNoteChildPanelContext(sourcePath);
    if (!context) { host.remove(); return; }
    host.empty();
    // Version lineage shares the note-side projection host but remains independent
    // from Parent / Child. It is a directed history, not a child tree.
    try {
      const helper = Object.create(DatabaseFileView.prototype);
      helper.app=this.app; helper.plugin=this; helper.definition=context.definition; helper.databaseFile=context.databaseFile; helper.isEmbedded=false; helper._localValueOverlay=new Map();
      const lineage = await helper.getVersionLineage(context.file);
      if (lineage.length > 1) {
        const vp = host.createDiv({ cls:"lmd-db-note-version-panel" });
        const vh = vp.createDiv({ cls:"lmd-db-note-version-header" });
        const vi = vh.createSpan({ cls:"lmd-db-note-version-icon" }); setIcon(vi,"history");
        vh.createSpan({ cls:"lmd-db-note-version-title", text:"版本歷程" });
        const strip = vp.createDiv({ cls:"lmd-db-note-version-strip" });
        lineage.forEach((entry, index) => {
          if (index) strip.createSpan({ cls:"lmd-db-note-version-arrow", text:"→" });
          const b=strip.createEl("button", { cls:"lmd-db-note-version-item", text:entry.file.basename, attr:{type:"button", title: entry.status === "current" ? "目前版本" : "開啟此版本"} });
          b.toggleClass("is-current", entry.status === "current");
          b.addEventListener("click", () => void this.app.workspace.openLinkText(entry.file.path, sourcePath, false));
        });
      }
    } catch (error) { console.warn("Local Markdown Database: note version strip failed", error); }
    const header = host.createDiv({ cls: "lmd-db-note-child-panel-header" });
    const titleWrap = header.createDiv({ cls: "lmd-db-note-child-panel-title-wrap" });
    const titleIcon = titleWrap.createSpan({ cls: "lmd-db-note-child-panel-icon" });
    setIcon(titleIcon, "list-tree");
    titleWrap.createSpan({ cls: "lmd-db-note-child-panel-title", text: "子項目" });

    const allDescendants = [];
    const collect = (id) => { for (const child of context.children.get(id) || []) { allDescendants.push(child); const cid = context.getId(child); if (cid) collect(cid); } };
    collect(context.itemId);
    const direct = context.children.get(context.itemId) || [];
    const checkboxField = context.checkboxField;
    const progressTargets = checkboxField?.hierarchyProgressScope === "direct" ? direct : allDescendants;
    const doneCount = checkboxField ? progressTargets.filter((child) => {
      if (child.extension === "canvas") {
        const store = context.definition.canvasItems || {};
        const meta = Object.values(store).find((entry) => entry && normalizePath(entry.path || "") === normalizePath(child.path));
        return meta?.properties?.[checkboxField.id] === true;
      }
      return this.app.metadataCache.getFileCache(child)?.frontmatter?.[checkboxField.id] === true;
    }).length : 0;
    const metaText = checkboxField && progressTargets.length ? `${doneCount} / ${progressTargets.length} 完成` : `${direct.length} 個直接子項目`;
    header.createSpan({ cls: "lmd-db-note-child-panel-progress", text: metaText });
    if (checkboxField && progressTargets.length) {
      const percent = Math.round((doneCount / progressTargets.length) * 100);
      const meter = host.createDiv({ cls: "lmd-db-note-child-progress-meter", attr: { "aria-label": `子項目進度 ${doneCount} / ${progressTargets.length}，${percent}%` } });
      const fill = meter.createDiv({ cls: "lmd-db-note-child-progress-meter-fill" });
      fill.style.width = `${percent}%`;
    }

    const addButton = header.createEl("button", { cls: "lmd-db-note-child-add", attr: { type: "button", title: "新增子項目", "aria-label": "新增子項目" } });
    setIcon(addButton, "plus");
    addButton.createSpan({ text: "新增子項目" });
    addButton.addEventListener("click", async (event) => {
      event.preventDefault(); event.stopPropagation();
      addButton.disabled = true;
      try {
        const fresh = await this.resolveNoteChildPanelContext(sourcePath);
        const created = fresh ? await this.createChildFromNotePanel(fresh) : null;
        if (created) {
          window.setTimeout(() => void this.renderNoteChildPanel(host, sourcePath), 180);
          void this.app.workspace.openLinkText(created.path, sourcePath, false);
        }
      } finally { addButton.disabled = false; }
    });

    const tree = host.createDiv({ cls: "lmd-db-note-child-tree" });
    if (!direct.length) {
      tree.createDiv({ cls: "lmd-db-note-child-empty", text: "目前沒有子項目。" });
      return;
    }
    const renderChildren = (parentId, depth, trail = new Set()) => {
      for (const child of context.children.get(parentId) || []) {
        const childId = context.getId(child);
        if (!childId || trail.has(childId)) continue;
        const row = tree.createDiv({ cls: "lmd-db-note-child-row" });
        row.style.setProperty("--lmd-child-depth", String(depth));
        const branch = row.createSpan({ cls: "lmd-db-note-child-branch", text: depth ? "└" : "•" });
        branch.setAttr("aria-hidden", "true");
        if (checkboxField && child.extension === "md") {
          const childStats = this.getHierarchyProgressStats(context.files, checkboxField, checkboxField.hierarchyProgressScope === "direct" ? "direct" : "descendants");
          const childStat = childStats.get(childId);
          const current = this.app.metadataCache.getFileCache(child)?.frontmatter?.[checkboxField.id] === true;
          const check = row.createEl("input", { cls: "lmd-db-note-child-check", attr: { type: "checkbox" } });
          check.checked = childStat ? (childStat.done === childStat.total && childStat.total > 0) : current;
          check.indeterminate = !!(childStat && childStat.done > 0 && childStat.done < childStat.total);
          check.addEventListener("click", (event) => event.stopPropagation());
          check.addEventListener("change", async () => {
            await this.writeNoteHierarchicalCheckbox(context, child, checkboxField, check.checked === true);
            window.setTimeout(() => void this.renderNoteChildPanel(host, sourcePath), 120);
          });
        } else {
          const icon = row.createSpan({ cls: "lmd-db-note-child-file-icon" });
          setIcon(icon, child.extension === "canvas" ? "layout-dashboard" : "file-text");
        }
        const name = row.createEl("button", { cls: "lmd-db-note-child-name", text: child.basename, attr: { type: "button" } });
        name.addEventListener("click", (event) => { event.preventDefault(); void this.app.workspace.openLinkText(child.path, sourcePath, false); });
        if (context.statusField) {
          let raw;
          if (child.extension === "canvas") {
            const store = context.definition.canvasItems || {};
            const meta = Object.values(store).find((entry) => entry && normalizePath(entry.path || "") === normalizePath(child.path));
            raw = meta?.properties?.[context.statusField.id];
          } else raw = this.app.metadataCache.getFileCache(child)?.frontmatter?.[context.statusField.id];
          if (raw !== undefined && raw !== null && raw !== "") row.createSpan({ cls: "lmd-db-note-child-status", text: String(raw) });
        }
        renderChildren(childId, depth + 1, new Set([...trail, childId]));
      }
    };
    renderChildren(context.itemId, 0, new Set([context.itemId]));
  }

  registerLiveDatabaseRenderer(renderer) {
    if (!renderer) return;
    if (!this._liveDatabaseRenderers) this._liveDatabaseRenderers = new Set();
    this._liveDatabaseRenderers.add(renderer);
  }

  unregisterLiveDatabaseRenderer(renderer) {
    this._liveDatabaseRenderers?.delete(renderer);
  }

  rendererContainsSourceFile(renderer, file) {
    if (!renderer?.definition || !file?.path) return false;
    try {
      const files = renderer.collectDatabaseSourceFiles(renderer.definition);
      return (files || []).some((item) => item?.path === file.path);
    } catch (_) {
      return false;
    }
  }

  async broadcastDatabaseRowChange(sourceRenderer, file, field, value) {
    if (!file?.path || !field?.id) return;
    const renderers = Array.from(this._liveDatabaseRenderers || []);
    for (const renderer of renderers) {
      if (!renderer || renderer === sourceRenderer) continue;
      if (!renderer.databaseFile || !renderer.contentEl?.isConnected) {
        this.unregisterLiveDatabaseRenderer(renderer);
        continue;
      }
      if (!this.rendererContainsSourceFile(renderer, file)) continue;
      try { renderer.rememberLocalColumnValue(file, field, value); } catch (_) {}
      // Never tear down an editor while an IME composition is active. Doing so
      // leaves Zhuyin's candidate window detached at the desktop corner and the
      // committed text has nowhere to go. Defer the refresh until compositionend.
      if ((renderer._compositionDepth || 0) > 0 || (renderer._editorDepth || 0) > 0) {
        renderer._pendingExternalRefresh = true;
        continue;
      }
      // Serialize refreshes per renderer. Rapid checkbox/select edits should collapse
      // into a deterministic sequence instead of racing two full renders.
      renderer._externalRefreshQueue = (renderer._externalRefreshQueue || Promise.resolve())
        .catch(() => {})
        .then(async () => {
          if (!renderer.contentEl?.isConnected || !renderer.databaseFile) return;
          await renderer.loadAndRender(renderer.databaseFile);
        });
      void renderer._externalRefreshQueue.catch((error) =>
        console.error("Local Markdown Database: cross-view refresh failed", error));
    }
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getEmbeddedViewState(key) {
    const state = this.settings?.embedViewStates?.[key];
    if (!state || typeof state !== "object") return null;
    try { return JSON.parse(JSON.stringify(state)); } catch (_) { return null; }
  }

  async saveEmbeddedViewState(key, state) {
    if (!key || !state || typeof state !== "object") return;
    if (!this.settings.embedViewStates || typeof this.settings.embedViewStates !== "object") this.settings.embedViewStates = {};
    // Store only view-instance state. Source/schema/name remain authoritative in
    // the .database file and can never be overwritten by an embed.
    this.settings.embedViewStates[key] = JSON.parse(JSON.stringify(state));
    await this.saveSettings();
  }

  getPortableEmbeddedViewState(definition, prefix, viewId) {
    const state = definition?.portableEmbedViewStates?.[prefix]?.[viewId];
    if (!state || typeof state !== "object") return null;
    try { return JSON.parse(JSON.stringify(state)); } catch (_) { return null; }
  }

  async savePortableEmbeddedViewState(databaseFile, prefix, viewId, state) {
    if (!(databaseFile instanceof TFile) || !prefix || !viewId || !state || typeof state !== "object") return;
    const key = normalizePath(databaseFile.path);
    if (!this._portableEmbedStateQueues) this._portableEmbedStateQueues = new Map();
    const previous = this._portableEmbedStateQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const raw = await this.app.vault.read(databaseFile);
      const latest = JSON.parse(raw);
      if (!latest.portableEmbedViewStates || typeof latest.portableEmbedViewStates !== "object") latest.portableEmbedViewStates = {};
      if (!latest.portableEmbedViewStates[prefix] || typeof latest.portableEmbedViewStates[prefix] !== "object") latest.portableEmbedViewStates[prefix] = {};
      latest.portableEmbedViewStates[prefix][viewId] = JSON.parse(JSON.stringify(state));
      if (!this._portableStateWriteUntil) this._portableStateWriteUntil = new Map();
      this._portableStateWriteUntil.set(key, Date.now() + 1500);
      await this.app.vault.modify(databaseFile, JSON.stringify(latest, null, 2));
    });
    this._portableEmbedStateQueues.set(key, next);
    try { await next; } finally { if (this._portableEmbedStateQueues.get(key) === next) this._portableEmbedStateQueues.delete(key); }
  }

  getEmbeddedActiveView(prefix) {
    return String(this.settings?.embedActiveViews?.[prefix] || "");
  }

  async saveEmbeddedActiveView(prefix, viewId) {
    if (!prefix) return;
    if (!this.settings.embedActiveViews || typeof this.settings.embedActiveViews !== "object") this.settings.embedActiveViews = {};
    if (viewId) this.settings.embedActiveViews[prefix] = String(viewId);
    else delete this.settings.embedActiveViews[prefix];
    await this.saveSettings();
  }

  getEmbeddedViewStructure(prefix) {
    const stored = this.settings?.embedViewStructures?.[prefix];
    if (!stored || typeof stored !== "object" || !Array.isArray(stored.views) || !stored.views.length) return null;
    try { return JSON.parse(JSON.stringify(stored)); } catch (_) { return null; }
  }

  async saveEmbeddedViewStructure(prefix, definition) {
    if (!prefix || !definition || !Array.isArray(definition.views)) return;
    if (!this.settings.embedViewStructures || typeof this.settings.embedViewStructures !== "object") this.settings.embedViewStructures = {};
    // Keep a local structural snapshot. Per-view live state (filters/sorts/etc.)
    // continues to live in embedViewStates and overlays this snapshot on load.
    this.settings.embedViewStructures[prefix] = {
      version: 1,
      views: definition.views.map((entry) => ({
        id: String(entry?.id || ""),
        name: String(entry?.name || "View"),
        type: ["board", "calendar", "timeline"].includes(entry?.type) ? entry.type : "table",
        state: JSON.parse(JSON.stringify(entry?.state || {})),
      })).filter((entry) => entry.id),
    };
    await this.saveSettings();
  }


  getContextAttachmentModel(ownerItemId) {
    const raw = this.settings?.contextAttachments?.[String(ownerItemId || "")];
    if (!raw || typeof raw !== "object") return null;
    try { return JSON.parse(JSON.stringify(raw)); } catch (_) { return null; }
  }

  async saveContextAttachmentModel(ownerItemId, model) {
    const key = String(ownerItemId || "").trim();
    if (!key) return;
    if (!this.settings.contextAttachments || typeof this.settings.contextAttachments !== "object") this.settings.contextAttachments = {};
    const clean = {
      version: 1,
      groups: Array.isArray(model?.groups) ? model.groups.map((group) => ({
        id: String(group?.id || `att-group-${generateSourceId()}`),
        name: String(group?.name || "附屬"),
        collapsed: group?.collapsed === true,
        items: Array.isArray(group?.items) ? group.items.map((item) => ({
          itemId: String(item?.itemId || ""),
          path: normalizePath(String(item?.path || "")),
          databaseId: String(item?.databaseId || ""),
          databasePath: normalizePath(String(item?.databasePath || "")),
          note: String(item?.note || ""),
        })).filter((item) => item.itemId || item.path) : [],
      })) : [],
    };
    this.settings.contextAttachments[key] = clean;
    await this.saveSettings();
  }


  getContextAttachmentCanvasPath(ownerFile) {
    if (!(ownerFile instanceof TFile)) return "";
    const dir = lmdCanvasDirname(ownerFile.path);
    const filename = `${ownerFile.basename} · 附屬.canvas`;
    return normalizePath(dir ? `${dir}/${filename}` : filename);
  }

  async readContextAttachmentCanvas(ownerFile) {
    const canvasPath = this.getContextAttachmentCanvasPath(ownerFile);
    const existing = this.app.vault.getAbstractFileByPath(canvasPath);
    if (existing instanceof TFile) {
      try {
        const parsed = JSON.parse(await this.app.vault.read(existing));
        return { file: existing, canvasPath, data: { nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [], edges: Array.isArray(parsed?.edges) ? parsed.edges : [] } };
      } catch (_) {
        return { file: existing, canvasPath, data: { nodes: [], edges: [] } };
      }
    }
    return { file: null, canvasPath, data: { nodes: [], edges: [] } };
  }

  async writeContextAttachmentCanvas(ownerFile, data) {
    const state = await this.readContextAttachmentCanvas(ownerFile);
    const text = JSON.stringify({ nodes: Array.isArray(data?.nodes) ? data.nodes : [], edges: Array.isArray(data?.edges) ? data.edges : [] }, null, 2);
    let file = state.file;
    if (file instanceof TFile) await this.app.vault.modify(file, text);
    else file = await this.app.vault.create(state.canvasPath, text);
    return file;
  }

  async resolveContextAttachmentFile(ref) {
    if (!ref || typeof ref !== "object") return null;
    if (ref.itemId) {
      const byId = await this.findMarkdownFileByStableId(ref.itemId);
      if (byId instanceof TFile) return byId;
    }
    const byPath = ref.path ? this.app.vault.getAbstractFileByPath(normalizePath(ref.path)) : null;
    return byPath instanceof TFile && byPath.extension === "md" ? byPath : null;
  }

  async expandContextAttachmentsToCanvas(ownerFile) {
    if (!(ownerFile instanceof TFile) || ownerFile.extension !== "md") return;
    const ownerItemId = await this.ensureStableItemIdForFile(ownerFile);
    const model = this.getContextAttachmentModel(ownerItemId);
    if (!model?.groups?.length) { new Notice("這篇筆記目前沒有附屬。"); return; }

    const state = await this.readContextAttachmentCanvas(ownerFile);
    const prefix = `lmdatt-${lmdStableCanvasId(ownerItemId)}`;
    const isGenerated = (id) => String(id || "").startsWith(`${prefix}-`);
    const rootId = `${prefix}-root`;
    // Preserve every user-created / Story Canvas node. Replace only this owner's
    // generated attachment expansion. The owner root is persistent so collapse
    // behaves like "remove expanded children", not "delete the source note".
    const preservedNodes = state.data.nodes.filter((node) => !isGenerated(node?.id) || node?.id === rootId);
    const preservedEdges = state.data.edges.filter((edge) => !isGenerated(edge?.id));
    let root = preservedNodes.find((node) => node?.id === rootId);
    if (!root) {
      root = { id: rootId, type: "file", file: ownerFile.path, x: 0, y: 0, width: 420, height: 260 };
      preservedNodes.push(root);
    } else {
      root.type = "file"; root.file = ownerFile.path;
      if (!Number.isFinite(Number(root.x))) root.x = 0;
      if (!Number.isFinite(Number(root.y))) root.y = 0;
      if (!Number.isFinite(Number(root.width))) root.width = 420;
      if (!Number.isFinite(Number(root.height))) root.height = 260;
    }

    const nodes = [...preservedNodes];
    const edges = [...preservedEdges];
    const rootX = Number(root.x) || 0, rootY = Number(root.y) || 0, rootW = Number(root.width) || 420;
    let groupY = rootY - Math.max(0, (model.groups.length - 1) * 150);
    let generatedCount = 0;
    for (let gi = 0; gi < model.groups.length; gi++) {
      const group = model.groups[gi];
      const groupId = `${prefix}-group-${lmdStableCanvasId(group.id || `${gi}`)}`;
      const gx = rootX + rootW + 180;
      const gy = groupY;
      const groupNode = { id: groupId, type: "text", text: `## ${String(group.name || "附屬")}`, x: gx, y: gy, width: 260, height: 110 };
      nodes.push(groupNode);
      edges.push({ id: `${prefix}-edge-root-${gi}`, fromNode: rootId, fromSide: "right", toNode: groupId, toSide: "left" });
      const items = Array.isArray(group.items) ? group.items : [];
      let itemY = gy - Math.max(0, (items.length - 1) * 95);
      for (let ii = 0; ii < items.length; ii++) {
        const ref = items[ii];
        const file = await this.resolveContextAttachmentFile(ref);
        if (!(file instanceof TFile)) continue;
        const itemKey = ref.itemId || file.path;
        const nodeId = `${prefix}-item-${lmdStableCanvasId(`${group.id || gi}:${itemKey}`)}`;
        const ix = gx + 420;
        const iy = itemY;
        nodes.push({ id: nodeId, type: "file", file: file.path, x: ix, y: iy, width: 400, height: 240 });
        const edge = { id: `${prefix}-edge-${gi}-${ii}`, fromNode: groupId, fromSide: "right", toNode: nodeId, toSide: "left" };
        if (String(ref.note || "").trim()) edge.label = String(ref.note).trim();
        edges.push(edge);
        itemY += 300;
        generatedCount++;
      }
      groupY += Math.max(300, items.length * 300 + 120);
    }

    const canvasFile = await this.writeContextAttachmentCanvas(ownerFile, { nodes, edges });
    if (canvasFile instanceof TFile) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(canvasFile);
      new Notice(`已展開 ${generatedCount} 個附屬到 Canvas。`);
    }
  }

  async collapseContextAttachmentsInCanvas(ownerFile) {
    if (!(ownerFile instanceof TFile) || ownerFile.extension !== "md") return;
    const ownerItemId = await this.ensureStableItemIdForFile(ownerFile);
    const state = await this.readContextAttachmentCanvas(ownerFile);
    if (!(state.file instanceof TFile)) { new Notice("尚未建立這篇筆記的附屬 Canvas。"); return; }
    const prefix = `lmdatt-${lmdStableCanvasId(ownerItemId)}`;
    const rootId = `${prefix}-root`;
    const nodes = state.data.nodes.filter((node) => !String(node?.id || "").startsWith(`${prefix}-`) || node?.id === rootId);
    const edges = state.data.edges.filter((edge) => !String(edge?.id || "").startsWith(`${prefix}-`));
    await this.writeContextAttachmentCanvas(ownerFile, { nodes, edges });
    new Notice("已收起 Canvas 附屬；原始 Markdown 與 Canvas 其他節點未變更。");
  }

  async ensureStableItemIdForFile(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return "";
    let id = this.app.metadataCache.getFileCache(file)?.frontmatter?.["lmd-id"];
    id = typeof id === "string" ? id.trim() : "";
    if (!id) {
      id = `lmd-item-${generateSourceId()}`;
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => { frontmatter["lmd-id"] = id; });
    }
    return id;
  }

  async findMarkdownFileByStableId(itemId) {
    const wanted = String(itemId || "").trim();
    if (!wanted) return null;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter?.["lmd-id"];
      if (String(cached || "").trim() === wanted) return file;
    }
    // Metadata cache may lag behind a recent migration/write. Read frontmatter-backed
    // files once as a fallback so attachment links remain stable across rename/move.
    for (const file of this.app.vault.getMarkdownFiles()) {
      try {
        const text = await this.app.vault.cachedRead(file);
        const match = /^---\\n[\\s\\S]*?^lmd-id:\\s*["']?([^"'\\n]+)["']?\\s*$[\\s\\S]*?^---/m.exec(text);
        if (match && String(match[1] || "").trim() === wanted) return file;
      } catch (_) {}
    }
    return null;
  }

  async findDatabaseFileById(databaseId) {
    const wanted = String(databaseId || "").trim();
    if (!wanted) return null;
    for (const file of this.app.vault.getFiles()) {
      if (file.extension !== DATABASE_EXTENSION) continue;
      try {
        const parsed = JSON.parse(await this.app.vault.read(file));
        if (parsed?.id === wanted) return file;
      } catch (_) {}
    }
    return null;
  }

  async ensureDatabaseId(file, definition = null) {
    if (!(file instanceof TFile) || file.extension !== DATABASE_EXTENSION) return null;
    const parsed = definition || await this.readDatabaseDefinition(file);
    if (!parsed) return null;
    if (!parsed.id) {
      parsed.id = generateSourceId();
      await this.app.vault.modify(file, JSON.stringify(parsed, null, 2));
    }
    return parsed.id;
  }

  async broadcastDatabaseDefinitionChange(file) {
    if (!(file instanceof TFile)) return;
    const path = normalizePath(file.path);
    const renderers = Array.from(this._liveDatabaseRenderers || []);
    for (const renderer of renderers) {
      if (!renderer?.databaseFile || !renderer.contentEl?.isConnected) {
        this.unregisterLiveDatabaseRenderer(renderer);
        continue;
      }
      if (normalizePath(renderer.databaseFile.path) !== path) continue;
      // An internal save already updated this renderer's definition object. Skipping
      // its own echoed vault modify event removes a redundant full render (the most
      // visible source of the brief white flash after table interactions) without
      // suppressing refreshes in other open/embedded renderers.
      if (Number(renderer._suppressOwnDefinitionRefreshUntil || 0) >= Date.now()) {
        renderer._suppressOwnDefinitionRefreshUntil = 0;
        continue;
      }
      if ((renderer._compositionDepth || 0) > 0 || (renderer._editorDepth || 0) > 0) {
        renderer._pendingDefinitionRefresh = true;
        continue;
      }
      renderer._definitionRefreshQueue = (renderer._definitionRefreshQueue || Promise.resolve())
        .catch(() => {})
        .then(async () => {
          if (renderer.isEmbedded === true) {
            const fresh = await this.readDatabaseDefinition(file);
            if (!fresh) return;

            // Embedded Views own their tab structure and every per-tab View state.
            // A .database definition change (schema option/color, source rename, etc.)
            // must refresh only the shared database layer. Never replace the embed's
            // local Views with `fresh.views`, because those are the main database's
            // tabs and may carry its group/filter/sort configuration. Doing so used
            // to wipe local embed tabs and make a grouped main View suddenly appear
            // inside the Markdown embed after changing a select option.
            const current = renderer.definition && typeof renderer.definition === "object"
              ? renderer.definition
              : null;
            const localViews = Array.isArray(current?.views)
              ? JSON.parse(JSON.stringify(current.views))
              : [];
            const localActiveViewId = String(current?.activeViewId || "");

            // Start from the fresh on-disk database so schema/source/database-level
            // metadata stays current, then restore the embed-owned View layer intact.
            renderer.ensureViewState(fresh, Array.isArray(fresh.schema) ? fresh.schema : []);
            if (localViews.length) {
              fresh.views = localViews;
              fresh.activeViewId = localViews.some((entry) => String(entry?.id || "") === localActiveViewId)
                ? localActiveViewId
                : String(localViews[0]?.id || "");
              // Normalize the preserved local states against the fresh schema (e.g. a
              // deleted field) without importing any main-View state.
              renderer.ensureViewState(fresh, Array.isArray(fresh.schema) ? fresh.schema : []);
            }
            renderer.definition = fresh;
          }
          await renderer.loadAndRender(file);
        });
      void renderer._definitionRefreshQueue.catch((error) => console.error("Local Markdown Database: definition refresh failed", error));
    }
  }

  async rewriteEmbeddedDatabaseReferences(oldPath, newPath, databaseId = "") {
    const oldNorm = normalizePath(oldPath || "");
    const newNorm = normalizePath(newPath || "");
    if (!oldNorm || !newNorm || oldNorm === newNorm) return;
    const oldName = oldNorm.split("/").pop() || oldNorm;
    for (const note of this.app.vault.getMarkdownFiles()) {
      let raw;
      try { raw = await this.app.vault.read(note); } catch (_) { continue; }
      if (!raw.includes("```lmd-database")) continue;
      let changed = false;
      const next = raw.replace(/```lmd-database\s*\n([\s\S]*?)```/g, (block, body) => {
        const lines = body.split(/\r?\n/);
        let blockChanged = false;
        let hasId = false;
        for (let i = 0; i < lines.length; i++) {
          const idMatch = /^\s*(?:database-id|db-id)\s*:\s*(.+?)\s*$/i.exec(lines[i]);
          if (idMatch) { hasId = true; continue; }
          const match = /^(\s*(?:database|db)\s*:\s*)(.+?)\s*$/i.exec(lines[i]);
          if (!match) continue;
          let value = match[2].trim();
          let wrapper = "";
          if (value.startsWith("[[") && value.endsWith("]]")) { wrapper = "wiki"; value = value.slice(2, -2).split("|")[0].trim(); }
          let withExt = value.toLowerCase().endsWith(`.${DATABASE_EXTENSION}`) ? normalizePath(value) : normalizePath(`${value}.${DATABASE_EXTENSION}`);
          const matchesOld = withExt === oldNorm || withExt === normalizePath(oldName);
          if (!matchesOld) continue;
          const outValue = wrapper === "wiki" ? `[[${newNorm}]]` : newNorm;
          lines[i] = `${match[1]}${outValue}`;
          blockChanged = true;
        }
        if (blockChanged && databaseId && !hasId) {
          const databaseLine = lines.findIndex((line) => /^\s*(?:database|db)\s*:/i.test(line));
          lines.splice(databaseLine >= 0 ? databaseLine + 1 : 0, 0, `database-id: ${databaseId}`);
        }
        if (blockChanged) changed = true;
        return `\`\`\`lmd-database\n${lines.join("\n")}\`\`\``;
      });
      if (changed && next !== raw) {
        try { await this.app.vault.modify(note, next); } catch (error) { console.error("Local Markdown Database: embed reference rewrite failed", note.path, error); }
      }
    }
  }

  async rewriteEmbeddedViewReferences(databaseFile, databaseId, viewId, oldName, newName) {
    if (!(databaseFile instanceof TFile) || !viewId) return;
    const dbPath = normalizePath(databaseFile.path);
    const dbName = databaseFile.name;
    const oldLower = String(oldName || "").trim().toLowerCase();
    for (const note of this.app.vault.getMarkdownFiles()) {
      let raw;
      try { raw = await this.app.vault.read(note); } catch (_) { continue; }
      if (!raw.includes("```lmd-database")) continue;
      let changed = false;
      const next = raw.replace(/```lmd-database\s*\n([\s\S]*?)```/g, (block, body) => {
        const lines = body.split(/\r?\n/);
        let referencesDatabase = false;
        let existingViewId = "";
        let viewLine = -1;
        let viewIdLine = -1;
        for (let i = 0; i < lines.length; i++) {
          const idMatch = /^\s*(?:database-id|db-id)\s*:\s*(.+?)\s*$/i.exec(lines[i]);
          if (idMatch && databaseId && idMatch[1].trim() === databaseId) referencesDatabase = true;
          const dbMatch = /^\s*(?:database|db)\s*:\s*(.+?)\s*$/i.exec(lines[i]);
          if (dbMatch) {
            let value = dbMatch[1].trim();
            if (value.startsWith("[[") && value.endsWith("]]")) value = value.slice(2,-2).split("|")[0].trim();
            const withExt = value.toLowerCase().endsWith(`.${DATABASE_EXTENSION}`) ? normalizePath(value) : normalizePath(`${value}.${DATABASE_EXTENSION}`);
            if (withExt === dbPath || withExt === normalizePath(dbName)) referencesDatabase = true;
          }
          const vid = /^\s*view-id\s*:\s*(.+?)\s*$/i.exec(lines[i]);
          if (vid) { existingViewId = vid[1].trim(); viewIdLine = i; }
          if (/^\s*view\s*:/i.test(lines[i])) viewLine = i;
        }
        if (!referencesDatabase) return block;
        if (existingViewId && existingViewId !== viewId) return block;
        if (!existingViewId && viewLine < 0) return block;
        if (!existingViewId && viewLine >= 0) {
          const m = /^\s*view\s*:\s*(.+?)\s*$/i.exec(lines[viewLine]);
          const currentName = String(m?.[1] || "").trim();
          if (oldLower && currentName.toLowerCase() !== oldLower) return block;
        }
        if (viewIdLine < 0) {
          const insertAt = viewLine >= 0 ? viewLine : lines.length;
          lines.splice(insertAt, 0, `view-id: ${viewId}`);
          if (viewLine >= 0) viewLine += 1;
        }
        if (viewLine >= 0) lines[viewLine] = `view: ${newName}`;
        else lines.push(`view: ${newName}`);
        changed = true;
        return `\`\`\`lmd-database\n${lines.join("\n")}\`\`\``;
      });
      if (changed && next !== raw) {
        try { await this.app.vault.modify(note, next); } catch (error) { console.error("Local Markdown Database: embed view reference rewrite failed", note.path, error); }
      }
    }
  }

  async readDatabaseDefinition(file) {
    try {
      const parsed = JSON.parse(await this.app.vault.read(file));
      return isDatabaseDefinition(parsed) ? parsed : null;
    } catch (_) { return null; }
  }


  async ensureManagedSourceMarker(databaseFile, definition, folder) {
    if (!(folder instanceof TFolder) || definition.source?.managed !== true) return false;
    if (!definition.source.id) definition.source.id = generateSourceId();
    const markerPath = normalizePath(folder.path ? `${folder.path}/${SOURCE_MARKER_NAME}` : SOURCE_MARKER_NAME);
    const payload = JSON.stringify({ sourceId: definition.source.id }, null, 2);
    const existing = this.app.vault.getAbstractFileByPath(markerPath);
    try {
      if (existing instanceof TFile) {
        const current = await this.app.vault.read(existing);
        if (current !== payload) await this.app.vault.modify(existing, payload);
      } else if (!existing) {
        await this.app.vault.create(markerPath, payload);
      }
      await this.app.vault.modify(databaseFile, JSON.stringify(definition, null, 2));
      return true;
    } catch (error) {
      console.error("Local Markdown Database: source marker write failed", error);
      return false;
    }
  }

  async findManagedSourceById(sourceId) {
    if (!sourceId) return null;
    const markers = this.app.vault.getFiles().filter((file) => file.name === SOURCE_MARKER_NAME);
    for (const marker of markers) {
      try {
        const parsed = JSON.parse(await this.app.vault.read(marker));
        if (parsed?.sourceId === sourceId && marker.parent instanceof TFolder) return marker.parent;
      } catch (_) {}
    }
    return null;
  }

  async recoverMovedSource(databaseFile, definition, missingPath) {
    if (definition.source?.managed === true && definition.source?.id) {
      const tracked = await this.findManagedSourceById(definition.source.id);
      if (tracked) {
        definition.source.path = tracked.path;
        await this.app.vault.modify(databaseFile, JSON.stringify(definition, null, 2));
        new Notice(`已追蹤資料來源的新位置：${tracked.path}`);
        return tracked;
      }
    }

    const oldNorm = normalizePath(missingPath || "");
    if (!oldNorm) return null;
    const oldName = oldNorm.split("/").filter(Boolean).pop() || "";
    const folders = this.app.vault.getAllLoadedFiles().filter((item) => item instanceof TFolder);
    let candidates = folders.filter((folder) => folder.name === oldName);
    if (definition.source?.managed === true) {
      const managedName = databaseFile.basename;
      const managedCandidates = folders.filter((folder) => folder.name === managedName);
      if (managedCandidates.length === 1) candidates = managedCandidates;
    }
    if (candidates.length !== 1) return null;
    const recovered = candidates[0];
    definition.source.path = recovered.path;
    if (definition.source?.managed === true) await this.ensureManagedSourceMarker(databaseFile, definition, recovered);
    else await this.app.vault.modify(databaseFile, JSON.stringify(definition, null, 2));
    new Notice(`已追蹤資料來源的新位置：${recovered.path}`);
    return recovered;
  }

  async refreshOpenDatabaseViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DATABASE)) {
      const view = leaf.view;
      const file = view?.file;
      if (view && file && typeof view.loadAndRender === "function") {
        try { await view.loadAndRender(file); } catch (_) {}
      }
    }
  }

  async handleVaultRename(event) {
    const oldPath = event?.oldPath || "";
    const newPath = event?.newPath || "";
    const dbFiles = this.app.vault.getFiles().filter((f) => f.extension === DATABASE_EXTENSION);
    for (const db of dbFiles) {
      const definition = await this.readDatabaseDefinition(db);
      if (!definition) continue;
      let changed = false;
      const oldNorm = normalizePath(oldPath || "");
      const newNorm = normalizePath(newPath || "");

      if (definition.source?.path === oldNorm || definition.source?.path?.startsWith(`${oldNorm}/`)) {
        definition.source.path = newNorm + definition.source.path.slice(oldNorm.length);
        changed = true;
      }

      if (definition.source?.type === "database-set" && Array.isArray(definition.source.paths)) {
        const nextPaths = definition.source.paths.map((path) => {
          const normalized = normalizePath(path || "");
          return normalized === oldNorm || normalized.startsWith(`${oldNorm}/`) ? newNorm + normalized.slice(oldNorm.length) : normalized;
        });
        if (JSON.stringify(nextPaths) !== JSON.stringify(definition.source.paths)) { definition.source.paths = nextPaths; changed = true; }
      }

      // Managed source fallback: if Obsidian reports the marker file rename
      // during a folder move, derive the new folder path directly from it.
      // This is still event-driven and does not guess by folder name.
      if (definition.source?.managed === true && definition.source?.id) {
        const currentSource = normalizePath(definition.source.path || "");
        const oldMarkerPath = normalizePath(oldNorm);
        if (event?.isFile && event?.name === SOURCE_MARKER_NAME && oldMarkerPath.endsWith(`/${SOURCE_MARKER_NAME}`)) {
          const oldParent = oldMarkerPath.slice(0, -(SOURCE_MARKER_NAME.length + 1));
          if (currentSource === oldParent) {
            const newMarkerPath = normalizePath(newNorm);
            const newParent = newMarkerPath.endsWith(`/${SOURCE_MARKER_NAME}`)
              ? newMarkerPath.slice(0, -(SOURCE_MARKER_NAME.length + 1))
              : "";
            if (newParent && newParent !== currentSource) {
              definition.source.path = newParent;
              changed = true;
            }
          }
        }
      }
      if (Array.isArray(definition.view?.manualOrder)) {
        const next = definition.view.manualOrder.map((path) => path === oldNorm || path.startsWith(`${oldNorm}/`) ? newNorm + path.slice(oldNorm.length) : path);
        if (JSON.stringify(next) !== JSON.stringify(definition.view.manualOrder)) { definition.view.manualOrder = next; changed = true; }
      }
      if (definition.view?.rowColors && typeof definition.view.rowColors === "object") {
        const next = {};
        for (const [path, color] of Object.entries(definition.view.rowColors)) {
          const mapped = path === oldNorm || path.startsWith(`${oldNorm}/`) ? newNorm + path.slice(oldNorm.length) : path;
          next[mapped] = color;
          if (mapped !== path) changed = true;
        }
        definition.view.rowColors = next;
      }
      if (definition.view?.cellColors && typeof definition.view.cellColors === "object") {
        const next = {};
        for (const [path, colors] of Object.entries(definition.view.cellColors)) {
          const mapped = path === oldNorm || path.startsWith(`${oldNorm}/`) ? newNorm + path.slice(oldNorm.length) : path;
          next[mapped] = colors;
          if (mapped !== path) changed = true;
        }
        definition.view.cellColors = next;
      }
      for (const field of definition.schema || []) {
        if (field.type === "relation" && (field.relationTarget === oldNorm || field.relationTarget?.startsWith(`${oldNorm}/`))) {
          field.relationTarget = newNorm + field.relationTarget.slice(oldNorm.length);
          changed = true;
        }
      }
      if (definition.canvasItems && typeof definition.canvasItems === "object") {
        for (const meta of Object.values(definition.canvasItems)) {
          if (!meta || typeof meta !== "object" || !meta.path) continue;
          const current = normalizePath(meta.path);
          if (current === oldNorm || current.startsWith(`${oldNorm}/`)) {
            meta.path = newNorm + current.slice(oldNorm.length);
            changed = true;
          }
        }
      }
      if (db.path === newNorm && event?.isFile && event?.extension === DATABASE_EXTENSION) {
        const renamedBase = newNorm.split("/").pop()?.replace(/\.database$/i, "") || definition.name;
        if (definition.name !== renamedBase) { definition.name = renamedBase; changed = true; }
        if (!definition.id) { definition.id = generateSourceId(); changed = true; }
      }
      if (definition.source?.managed === true && definition.source?.id) {
        const trackedFolder = await this.findManagedSourceById(definition.source.id);
        if (trackedFolder && definition.source.path !== trackedFolder.path) {
          definition.source.path = trackedFolder.path;
          changed = true;
        }
      }
      if (changed) await this.app.vault.modify(db, JSON.stringify(definition, null, 2));
    }

    if (event?.isFile && event?.extension === DATABASE_EXTENSION) {
      const movedDb = this.app.vault.getAbstractFileByPath(normalizePath(newPath));
      const movedDef = movedDb instanceof TFile ? await this.readDatabaseDefinition(movedDb) : null;
      await this.rewriteEmbeddedDatabaseReferences(oldPath, newPath, movedDef?.id || "");
    }

    if (event?.isFile && event?.extension === "md") {
      await this.updateRelationLinksForRenamedNote(oldPath, newPath);
    } else if (event?.isFolder) {
      await this.updateRelationLinksForRenamedFolder(oldPath, newPath);
    }
    await this.refreshOpenDatabaseViews();
  }

  async updateRelationLinksForRenamedFolder(oldPath, newPath) {
    const oldPrefix = normalizePath(oldPath || "");
    const newPrefix = normalizePath(newPath || "");
    if (!oldPrefix || oldPrefix === newPrefix) return;
    const dbFiles = this.app.vault.getFiles().filter((f) => f.extension === DATABASE_EXTENSION);
    for (const db of dbFiles) {
      const definition = await this.readDatabaseDefinition(db);
      if (!definition) continue;
      const relationFields = (definition.schema || []).filter((f) => f.type === "relation");
      if (!relationFields.length) continue;
      const source = this.app.vault.getAbstractFileByPath(normalizePath(definition.source.path || ""));
      if (!(source instanceof TFolder)) continue;
      for (const note of source.children) {
        if (!(note instanceof TFile) || note.extension !== "md") continue;
        const cache = this.app.metadataCache.getFileCache(note);
        const fm = cache?.frontmatter || {};
        let needs = false;
        for (const field of relationFields) {
          const vals = Array.isArray(fm[field.id]) ? fm[field.id] : (fm[field.id] ? [fm[field.id]] : []);
          if (vals.some((v) => { const t = stripWikiLink(v); return t === oldPrefix || t.startsWith(`${oldPrefix}/`); })) { needs = true; break; }
        }
        if (!needs) continue;
        await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
          for (const field of relationFields) {
            const raw = frontmatter[field.id];
            const vals = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            if (!vals.length) continue;
            const next = vals.map((v) => {
              const target = stripWikiLink(v);
              return target === oldPrefix || target.startsWith(`${oldPrefix}/`) ? `[[${newPrefix}${target.slice(oldPrefix.length)}]]` : v;
            });
            frontmatter[field.id] = Array.isArray(raw) ? next : next[0];
          }
        });
      }
    }
  }

  async updateRelationLinksForRenamedNote(oldPath, newPath) {
    const oldTarget = stripMdExtension(oldPath);
    const newTarget = stripMdExtension(newPath);
    if (!oldTarget || oldTarget === newTarget) return;
    const dbFiles = this.app.vault.getFiles().filter((f) => f.extension === DATABASE_EXTENSION);
    const touched = new Set();
    for (const db of dbFiles) {
      const definition = await this.readDatabaseDefinition(db);
      if (!definition) continue;
      const relationFields = (definition.schema || []).filter((f) => f.type === "relation");
      if (!relationFields.length) continue;
      const source = this.app.vault.getAbstractFileByPath(normalizePath(definition.source.path || ""));
      if (!(source instanceof TFolder)) continue;
      for (const note of source.children) {
        if (!(note instanceof TFile) || note.extension !== "md" || touched.has(note.path)) continue;
        let needs = false;
        const cache = this.app.metadataCache.getFileCache(note);
        const fm = cache?.frontmatter || {};
        for (const field of relationFields) {
          const vals = Array.isArray(fm[field.id]) ? fm[field.id] : (fm[field.id] ? [fm[field.id]] : []);
          if (vals.some((v) => stripWikiLink(v) === oldTarget)) { needs = true; break; }
        }
        if (!needs) continue;
        touched.add(note.path);
        await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
          for (const field of relationFields) {
            const raw = frontmatter[field.id];
            const vals = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            if (!vals.length) continue;
            const next = vals.map((v) => stripWikiLink(v) === oldTarget ? `[[${newTarget}]]` : v);
            frontmatter[field.id] = Array.isArray(raw) ? next : next[0];
          }
        });
      }
    }
  }

  async findDatabaseUsingSource(sourcePath, excludePath = "") {
    const wanted = normalizePath(sourcePath || "");
    for (const file of this.app.vault.getFiles()) {
      if (file.extension !== DATABASE_EXTENSION || file.path === excludePath) continue;
      try {
        const parsed = JSON.parse(await this.app.vault.read(file));
        if (!isDatabaseDefinition(parsed)) continue;
        if (normalizePath(parsed.source?.path || "") === wanted) return { file, definition: parsed };
      } catch (_) {}
    }
    return null;
  }

  async createDatabaseFile() {
    const active = this.app.workspace.getActiveFile();
    const parent = (active && active.parent) || this.app.vault.getRoot();
    const parentPath = parent.path;

    let index = 1;
    let baseName = "Untitled";
    let dbName = `${baseName}.database`;
    let dbPath = normalizePath(parentPath ? `${parentPath}/${dbName}` : dbName);
    while (this.app.vault.getAbstractFileByPath(dbPath)) {
      index += 1;
      baseName = `Untitled ${index}`;
      dbName = `${baseName}.database`;
      dbPath = normalizePath(parentPath ? `${parentPath}/${dbName}` : dbName);
    }

    new DatabaseSetupModal(this.app, async (choice) => {
      try {
        let source;
        if (choice.mode === "aggregate") {
          const paths = Array.from(new Set((choice.paths || []).map((path) => normalizePath(path)).filter(Boolean)));
          source = { type: "database-set", paths, managed: false };
        } else if (choice.mode === "managed") {
          let dataFolderName = baseName;
          let dataFolderPath = normalizePath(parentPath ? `${parentPath}/${dataFolderName}` : dataFolderName);
          let folderIndex = 1;
          while (this.app.vault.getAbstractFileByPath(dataFolderPath)) {
            folderIndex += 1;
            dataFolderName = `${baseName} Data ${folderIndex}`;
            dataFolderPath = normalizePath(parentPath ? `${parentPath}/${dataFolderName}` : dataFolderName);
          }
          await this.app.vault.createFolder(dataFolderPath);
          source = { type: "folder", path: dataFolderPath, managed: true, id: generateSourceId() };
        } else {
          const selectedPath = normalizePath(choice.path || "");
          const selectedFolder = selectedPath ? this.app.vault.getAbstractFileByPath(selectedPath) : this.app.vault.getRoot();
          if (!(selectedFolder instanceof TFolder)) { new Notice("找不到選取的資料夾。"); return; }
          source = { type: "folder", path: selectedFolder.path, managed: false };
        }

        let definition;
        const companion = source.type === "folder" && !source.managed ? await this.findDatabaseUsingSource(source.path, dbPath) : null;
        if (companion?.definition) {
          definition = JSON.parse(JSON.stringify(companion.definition));
          definition.version = Number(definition.version) || 1;
          definition.id = generateSourceId();
          definition.name = baseName;
          definition.source = source;
          // A second Database over the same folder should inherit schema semantics
          // (Relation vs multi-select), option/tag colors and view/cell styling.
          // The underlying Markdown files remain the same; only this .database file is new.
        } else {
          definition = {
            version: 1,
            id: generateSourceId(),
            name: baseName,
            source,
            schema: [],
            view: { columnOrder: ["file.name"], columnWidths: { "file.name": 220 }, manualOrder: [], sort: [], filters: [], wrap: false, freezeColumns: 0, frozenColumnIds: [], rowColors: {}, columnColors: {}, cellColors: {} },
          };
        }
        const file = await this.app.vault.create(dbPath, JSON.stringify(definition, null, 2));
        if (source.managed) {
          const folder = this.app.vault.getAbstractFileByPath(source.path);
          if (folder instanceof TFolder) await this.ensureManagedSourceMarker(file, definition, folder);
        }
        await this.app.workspace.getLeaf(false).openFile(file);
        if (source.type === "database-set") new Notice(`聚合 Database 已建立；${source.paths.length} 個來源。`);
        else new Notice(source.managed ? `Database 已建立；Managed 資料來源：${source.path}` : `Database 已建立；使用現有資料夾：${source.path || "/"}`);
      } catch (error) {
        console.error("Local Markdown Database: failed to create database", error);
        new Notice("建立 Database 失敗。請查看開發者主控台。");
      }
    }).open();
  }
};
