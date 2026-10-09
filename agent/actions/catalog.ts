/**
 * The universal action catalog.
 *
 * A small set of application-independent primitives instead of hundreds of
 * app-specific commands. Element-targeted actions take IDs from the current
 * perception (`e*` = UI Automation, `v*` = vision-grounded); raw screen
 * coordinates are only accepted for genuinely unlabeled canvas content and
 * must fall inside the current target window.
 *
 * Each definition declares its permission capability, the physical resources
 * it leases, whether it can run inside a batch without a fresh model decision,
 * and the concise status text shown to the user.
 */
import type { Capability } from "../../permissions/types";
import type { JsonSchema } from "../../shared/jsonSchema";
import type { ResourceName } from "../scheduler";

export type ActionGroup =
  | "core" | "vision" | "mouse" | "window" | "app" | "files" | "clipboard"
  | "browser" | "web" | "download" | "shell" | "system" | "memory" | "task" | "messaging";

export interface ActionDefinition {
  name: string;
  group: ActionGroup;
  description: string;
  args: JsonSchema;
  capability: Capability;
  resources: (args: Record<string, unknown>) => ResourceName[];
  /** Present-tense status while running ("Opening Chrome…"). */
  progress: (args: Record<string, unknown>) => string;
  /** May run back-to-back inside one planner batch (low-risk, reversible). */
  batchable: boolean;
  /** Perception should be refreshed after this action. */
  changesUi: boolean;
}

const element = { type: "string", description: "Element ID from the latest observation (e12 or v3)." };
const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "string", description, ...extra });
const num = (description: string, minimum?: number, maximum?: number): JsonSchema => ({ type: "number", description, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

const pointer = (): ResourceName[] => ["mouse", "focus"];
const keys = (): ResourceName[] => ["keyboard", "focus"];
const none = (): ResourceName[] => [];
const short = (value: unknown, max = 40) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const fileName = (value: unknown) => short(String(value ?? "").split(/[\\/]/).pop() || value, 40);

export const ACTIONS: ActionDefinition[] = [
  // ---- core UI interaction ------------------------------------------------
  { name: "ui.click", group: "core", description: "Activate a control (button, link, tab, list item, checkbox). Uses accessibility patterns when possible so the user's mouse is not moved.", args: obj({ element, method: str("auto (default) or mouse to force a real pointer click", { enum: ["auto", "mouse"] }) }, ["element"]), capability: "CONTROL_INPUT", resources: (a) => (a.method === "mouse" || String(a.element).startsWith("v") ? pointer() : ["focus"]), progress: () => "Clicking…", batchable: true, changesUi: true },
  { name: "ui.double_click", group: "core", description: "Double-click an element (e.g. open a file in File Explorer).", args: obj({ element }, ["element"]), capability: "CONTROL_INPUT", resources: pointer, progress: () => "Opening…", batchable: true, changesUi: true },
  { name: "ui.right_click", group: "core", description: "Open an element's context menu.", args: obj({ element }, ["element"]), capability: "CONTROL_INPUT", resources: pointer, progress: () => "Opening menu…", batchable: true, changesUi: true },
  { name: "ui.type", group: "core", description: "Type text. With element: focus it first; replace=true clears existing text. submit=true presses Enter afterwards. Unicode safe.", args: obj({ element: { ...element, description: "Optional target field." }, text: str("Text to type", { maxLength: 5000 }), replace: bool("Replace existing text"), submit: bool("Press Enter after typing") }, ["text"]), capability: "CONTROL_INPUT", resources: keys, progress: (a) => `Typing "${short(a.text, 24)}"…`, batchable: true, changesUi: true },
  { name: "ui.select", group: "core", description: "Select a list/tree/tab item without activating it.", args: obj({ element }, ["element"]), capability: "CONTROL_INPUT", resources: () => ["focus"], progress: () => "Selecting…", batchable: true, changesUi: true },
  { name: "ui.toggle", group: "core", description: "Toggle a checkbox or switch.", args: obj({ element }, ["element"]), capability: "CONTROL_INPUT", resources: () => ["focus"], progress: () => "Toggling…", batchable: true, changesUi: true },
  { name: "ui.expand", group: "core", description: "Expand (or collapse=true) a menu, tree node or combo box.", args: obj({ element, collapse: bool("Collapse instead") }, ["element"]), capability: "CONTROL_INPUT", resources: () => ["focus"], progress: () => "Expanding…", batchable: true, changesUi: true },
  { name: "ui.scroll", group: "core", description: "Scroll inside an element (or the active window when element is omitted). amount 1-15 notches.", args: obj({ element: { ...element, description: "Optional scroll container." }, direction: str("up or down", { enum: ["up", "down"] }), amount: num("Notches", 1, 15) }, ["direction"]), capability: "CONTROL_INPUT", resources: pointer, progress: () => "Scrolling…", batchable: true, changesUi: true },
  { name: "ui.find", group: "core", description: "Search the current window's controls by visible text (use when the list was truncated).", args: obj({ query: str("Text to look for"), window: str("Optional window title") }, ["query"]), capability: "SCREEN_CAPTURE", resources: none, progress: (a) => `Looking for "${short(a.query, 24)}"…`, batchable: false, changesUi: false },
  { name: "ui.inspect", group: "core", description: "Re-observe a specific window by title (otherwise the active window is observed automatically each step).", args: obj({ window: str("Window title (partial)") }, ["window"]), capability: "SCREEN_CAPTURE", resources: none, progress: () => "Looking at the window…", batchable: false, changesUi: false },
  { name: "keyboard.press", group: "core", description: "Press one key (enter, escape, tab, backspace, delete, up, down, left, right, home, end, pageup, pagedown, f5…), optionally several times.", args: obj({ key: str("Key name"), times: num("Repeat count", 1, 20) }, ["key"]), capability: "CONTROL_INPUT", resources: keys, progress: (a) => `Pressing ${short(a.key, 12)}…`, batchable: true, changesUi: true },
  { name: "keyboard.hotkey", group: "core", description: "Press a key combination, e.g. [\"ctrl\",\"l\"], [\"alt\",\"left\"], [\"ctrl\",\"v\"].", args: obj({ keys: { type: "array", items: { type: "string" }, maxItems: 4 } }, ["keys"]), capability: "CONTROL_INPUT", resources: keys, progress: (a) => `Pressing ${(a.keys as string[] || []).join("+")}…`, batchable: true, changesUi: true },
  { name: "wait", group: "core", description: "Wait for the UI to settle: until=loading_done (browser), title_contains, element_appears (visible text), or just seconds.", args: obj({ seconds: num("Maximum seconds", 0.2, 20), until: str("Condition", { enum: ["time", "loading_done", "title_contains", "element_appears", "screen_stable"] }), value: str("Text for the condition") }, ["seconds"]), capability: "SCREEN_CAPTURE", resources: none, progress: () => "Waiting for it to load…", batchable: true, changesUi: false },

  // ---- vision fallback ------------------------------------------------------
  { name: "screen.look", group: "vision", description: "Look at the window with the vision model when accessibility data is missing or ambiguous. Optional question. Returns a summary and visual element IDs (v*).", args: obj({ question: str("What to find out"), scope: str("window (default) or screen", { enum: ["window", "screen"] }) }), capability: "SCREEN_CAPTURE", resources: none, progress: () => "Looking at the screen…", batchable: false, changesUi: false },
  { name: "screen.locate", group: "vision", description: "Visually locate one described target (e.g. 'the photo of a red car', 'second image in the chat'). Returns a v* ID usable with ui.click. Reports ambiguity instead of guessing.", args: obj({ description: str("What to locate"), scope: str("window or screen", { enum: ["window", "screen"] }) }, ["description"]), capability: "SCREEN_CAPTURE", resources: none, progress: (a) => `Finding ${short(a.description, 30)}…`, batchable: false, changesUi: false },

  // ---- raw pointer (last resort) ------------------------------------------
  { name: "mouse.click_point", group: "mouse", description: "LAST RESORT for unlabeled canvas content: click x,y (physical pixels) that you derived from the CURRENT observation; must be inside the active window. Give a reason.", args: obj({ x: num("Screen x"), y: num("Screen y"), button: str("left or right", { enum: ["left", "right"] }), reason: str("Why no element ID can be used") }, ["x", "y", "reason"]), capability: "CONTROL_INPUT", resources: pointer, progress: () => "Clicking…", batchable: false, changesUi: true },
  { name: "mouse.drag", group: "mouse", description: "Drag from one element to another element (e.g. a file onto a drop zone).", args: obj({ from: element, to: element }, ["from", "to"]), capability: "CONTROL_INPUT", resources: pointer, progress: () => "Dragging…", batchable: false, changesUi: true },

  // ---- windows & apps --------------------------------------------------------
  { name: "window.focus", group: "window", description: "Bring a window to the front (restores it if minimized).", args: obj({ title: str("Window title (partial)") }, ["title"]), capability: "CONTROL_INPUT", resources: () => ["focus"], progress: (a) => `Switching to ${short(a.title, 24)}…`, batchable: true, changesUi: true },
  { name: "window.set", group: "window", description: "Move/resize/minimize/maximize/restore/close a window.", args: obj({ title: str("Window title (partial)"), action: str("Action", { enum: ["move", "resize", "move_resize", "minimize", "maximize", "restore", "close"] }), x: num("Left"), y: num("Top"), width: num("Width", 120), height: num("Height", 80) }, ["title", "action"]), capability: "CONTROL_INPUT", resources: () => ["focus"], progress: (a) => `${short(a.action, 12)} window…`, batchable: true, changesUi: true },
  { name: "window.list", group: "window", description: "List open windows.", args: obj({}), capability: "SCREEN_CAPTURE", resources: none, progress: () => "Checking open windows…", batchable: false, changesUi: false },
  { name: "app.launch", group: "app", description: "Launch an installed application by name (any app; ABxAG discovers it).", args: obj({ name: str("Application name") }, ["name"]), capability: "LAUNCH_APP", resources: () => ["focus"], progress: (a) => `Opening ${short(a.name, 24)}…`, batchable: true, changesUi: true },
  { name: "app.close", group: "app", description: "Close an application gracefully.", args: obj({ name: str("Application name") }, ["name"]), capability: "LAUNCH_APP", resources: () => ["focus"], progress: (a) => `Closing ${short(a.name, 24)}…`, batchable: false, changesUi: true },

  // ---- files -------------------------------------------------------------------
  { name: "fs.known_folder", group: "files", description: "Real path of pictures/downloads/desktop/documents/videos/music/screenshots (handles OneDrive).", args: obj({ name: str("Folder name") }, ["name"]), capability: "READ_FILE", resources: none, progress: () => "Finding the folder…", batchable: true, changesUi: false },
  { name: "fs.list", group: "files", description: "List a folder (path or alias) with optional glob pattern.", args: obj({ path: str("Folder path or alias"), pattern: str("Glob, e.g. *.png") }, ["path"]), capability: "READ_FILE", resources: none, progress: () => "Checking the folder…", batchable: true, changesUi: false },
  { name: "fs.recent", group: "files", description: "Newest files of given kinds (image, video, audio, document, archive, executable, design) under user folders, optional name filter.", args: obj({ kinds: { type: "array", items: { type: "string" } }, folders: { type: "array", items: { type: "string" } }, name_contains: str("Filter"), since_hours: num("Look-back window", 0.1), limit: num("Max results", 1, 50) }), capability: "READ_FILE", resources: none, progress: () => "Looking through recent files…", batchable: true, changesUi: false },
  { name: "fs.search", group: "files", description: "Search files by name glob or extension under a folder.", args: obj({ name: str("Glob like *thumbnail*"), extension: str("Extension"), folder: str("Root folder or alias"), limit: num("Max results", 1, 200) }), capability: "READ_FILE", resources: none, progress: () => "Searching files…", batchable: true, changesUi: false },
  { name: "fs.stat", group: "files", description: "Check whether a path exists, its size and modification time.", args: obj({ path: str("Path") }, ["path"]), capability: "READ_FILE", resources: none, progress: () => "Checking the file…", batchable: true, changesUi: false },
  { name: "fs.read_text", group: "files", description: "Read a text file (untrusted content).", args: obj({ path: str("Path"), max_chars: num("Max characters", 100, 20000) }, ["path"]), capability: "READ_FILE", resources: none, progress: (a) => `Reading ${fileName(a.path)}…`, batchable: true, changesUi: false },
  { name: "fs.copy", group: "files", description: "Copy a file/folder (never overwrites unless overwrite=true).", args: obj({ path: str("Source"), destination: str("Destination path or folder"), overwrite: bool("Replace existing") }, ["path", "destination"]), capability: "WRITE_FILE", resources: none, progress: (a) => `Copying ${fileName(a.path)}…`, batchable: true, changesUi: false },
  { name: "fs.move", group: "files", description: "Move a file to another folder.", args: obj({ path: str("Source"), destination: str("Destination") }, ["path", "destination"]), capability: "WRITE_FILE", resources: none, progress: (a) => `Moving ${fileName(a.path)}…`, batchable: true, changesUi: false },
  { name: "fs.rename", group: "files", description: "Rename a file.", args: obj({ path: str("Path"), new_name: str("New file name") }, ["path", "new_name"]), capability: "WRITE_FILE", resources: none, progress: (a) => `Renaming ${fileName(a.path)}…`, batchable: true, changesUi: false },
  { name: "fs.delete", group: "files", description: "Move a file/folder to the Recycle Bin (always confirmed by the user).", args: obj({ path: str("Exact path") }, ["path"]), capability: "DELETE_FILE", resources: none, progress: (a) => `Deleting ${fileName(a.path)}…`, batchable: false, changesUi: false },
  { name: "fs.create_text", group: "files", description: "Create a text file (fails if it exists).", args: obj({ path: str("Path"), content: str("Content", { maxLength: 100000 }) }, ["path"]), capability: "WRITE_FILE", resources: none, progress: (a) => `Creating ${fileName(a.path)}…`, batchable: true, changesUi: false },
  { name: "fs.open", group: "files", description: "Open a file or folder with its default app (installers/scripts need explicit user confirmation).", args: obj({ path: str("Path") }, ["path"]), capability: "LAUNCH_APP", resources: () => ["focus"], progress: (a) => `Opening ${fileName(a.path)}…`, batchable: true, changesUi: true },
  { name: "fs.select", group: "files", description: "Open a folder in File Explorer and select files in it (extension like zip, a name glob, or exact names). Use for any 'select these files' step; it changes nothing on disk.", args: obj({ folder: str("Folder path or alias"), extension: str("Extension without dot"), pattern: str("Glob, e.g. *.zip"), names: { type: "array", items: { type: "string" }, maxItems: 200 } }, ["folder"]), capability: "LAUNCH_APP", resources: () => ["focus"], progress: (a) => `Selecting files in ${fileName(a.folder)}…`, batchable: true, changesUi: true },
  { name: "fs.reveal", group: "files", description: "Show a file selected in File Explorer.", args: obj({ path: str("Path") }, ["path"]), capability: "LAUNCH_APP", resources: () => ["focus"], progress: (a) => `Showing ${fileName(a.path)}…`, batchable: true, changesUi: true },

  // ---- clipboard ----------------------------------------------------------------
  { name: "clipboard.copy_files", group: "clipboard", description: "Put files on the clipboard (like Ctrl+C in Explorer) so they can be pasted into chats, mail or upload fields with ctrl+v.", args: obj({ paths: { type: "array", items: { type: "string" }, maxItems: 20 } }, ["paths"]), capability: "CLIPBOARD", resources: () => ["clipboard"], progress: () => "Copying the file…", batchable: true, changesUi: false },
  { name: "clipboard.write_text", group: "clipboard", description: "Put text on the clipboard without pasting.", args: obj({ text: str("Text", { maxLength: 100000 }) }, ["text"]), capability: "CLIPBOARD", resources: () => ["clipboard"], progress: () => "Copying text…", batchable: true, changesUi: false },
  { name: "clipboard.read", group: "clipboard", description: "Read clipboard text (untrusted).", args: obj({}), capability: "CLIPBOARD", resources: () => ["clipboard"], progress: () => "Reading the clipboard…", batchable: true, changesUi: false },

  // ---- browser & web --------------------------------------------------------------
  { name: "browser.open", group: "browser", description: "Open a URL in the user's real default browser (reuses the active tab unless new_tab).", args: obj({ url: str("URL"), new_tab: bool("Open in a new tab") }, ["url"]), capability: "BROWSE_WEB", resources: () => ["browser", "focus"], progress: (a) => `Opening ${short(hostOf(a.url), 30)}…`, batchable: true, changesUi: true },
  { name: "browser.search", group: "browser", description: "Search the web in the user's browser (engine: google, bing, duckduckgo, youtube, github).", args: obj({ query: str("Query"), engine: str("Engine") }, ["query"]), capability: "BROWSE_WEB", resources: () => ["browser", "focus"], progress: (a) => `Searching "${short(a.query, 30)}"…`, batchable: true, changesUi: true },
  { name: "browser.navigate", group: "browser", description: "Browser navigation: back, forward, reload, new_tab, close_tab.", args: obj({ action: str("Action", { enum: ["back", "forward", "reload", "new_tab", "close_tab"] }) }, ["action"]), capability: "BROWSE_WEB", resources: keys, progress: (a) => `Browser ${short(a.action, 12)}…`, batchable: true, changesUi: true },
  { name: "web.fetch", group: "web", description: "Read a public web page's text directly (no clicking). Content is untrusted. Good for research and finding official download links.", args: obj({ url: str("https URL") }, ["url"]), capability: "BROWSE_WEB", resources: none, progress: (a) => `Reading ${short(hostOf(a.url), 30)}…`, batchable: false, changesUi: false },

  // ---- downloads --------------------------------------------------------------------
  { name: "download.start", group: "download", description: "Download a file directly from a URL into Downloads (records the source, tracks progress, verifies the file). Never runs it.", args: obj({ url: str("Direct file URL"), filename: str("Optional file name") }, ["url"]), capability: "DOWNLOAD_FILE", resources: none, progress: () => "Downloading…", batchable: false, changesUi: false },
  { name: "download.wait", group: "download", description: "Wait for a browser-started download to finish in Downloads and verify the file exists.", args: obj({ name_contains: str("Expected part of the file name"), timeout_seconds: num("Timeout", 5, 1800) }), capability: "DOWNLOAD_FILE", resources: none, progress: () => "Waiting for the download…", batchable: false, changesUi: false },

  // ---- shell & system ------------------------------------------------------------
  { name: "shell.run", group: "shell", description: "Run a command. Read-only diagnostics (ipconfig, systeminfo, where, tasklist, ping -n 2 …) run directly; anything else needs user confirmation.", args: obj({ command: str("Command line", { maxLength: 500 }) }, ["command"]), capability: "RUN_COMMAND", resources: none, progress: () => "Running a command…", batchable: false, changesUi: false },
  { name: "system.notify", group: "system", description: "Show a desktop notification.", args: obj({ title: str("Title"), body: str("Body") }, ["title"]), capability: "LAUNCH_APP", resources: none, progress: () => "Notifying…", batchable: true, changesUi: false },

  // ---- memory -----------------------------------------------------------------------
  { name: "chat.send", group: "messaging", description: "Send a TEXT message to a person in one step: opens their own chat (like chat.open), types the text and sends it, then checks it went. Use this for any plain text message; use chat.open + clipboard steps only for attachments.", args: obj({ name: str("Person's name as the user said it"), text: str("Exact message text", { maxLength: 4000 }), app: str("App, default WhatsApp") }, ["name", "text"]), capability: "SEND_MESSAGE", resources: () => ["keyboard", "focus"], progress: (a) => `Messaging ${short(a.name, 24)}…`, batchable: false, changesUi: true },
  { name: "chat.open", group: "messaging", description: "Open a person's OWN chat in a messaging app (WhatsApp by default): launches the app, searches the name in the app's search box (tolerates small spelling differences), opens the matching personal chat — never a group or a name inside a group — and verifies the chat header. Use this before typing any message.", args: obj({ name: str("Person's name as the user said it, or search_name from contacts.resolve"), app: str("App, default WhatsApp") }, ["name"]), capability: "CONTROL_INPUT", resources: () => ["mouse", "keyboard", "focus"], progress: (a) => `Opening ${short(a.name, 24)}'s chat…`, batchable: false, changesUi: true },
  { name: "contacts.resolve", group: "memory", description: "Resolve a person reference (Papa, Mummy, a name) to the user's saved contact and the exact name to search for in an app.", args: obj({ name: str("Who"), app: str("App, e.g. whatsapp") }, ["name"]), capability: "READ_FILE", resources: none, progress: (a) => `Checking who "${short(a.name, 20)}" is…`, batchable: true, changesUi: false },
  { name: "memory.remember", group: "memory", description: "Remember a durable, useful fact learned during the task (a folder location, a preference, the exact chat name of a contact).", args: obj({ fact: str("Third-person fact", { maxLength: 400 }), kind: str("Kind", { enum: ["preference", "location", "contact", "habit"] }) }, ["fact", "kind"]), capability: "READ_FILE", resources: none, progress: () => "Noting that…", batchable: true, changesUi: false },

  // ---- task control (handled by the loop) -----------------------------------------
  { name: "task.ask_user", group: "task", description: "Ask the user one short question when something is genuinely ambiguous or blocked (login needed, two matching contacts…). Optionally offer options.", args: obj({ question: str("Short question", { maxLength: 300 }), options: { type: "array", items: { type: "string" }, maxItems: 5 } }, ["question"]), capability: "READ_FILE", resources: none, progress: () => "Asking you…", batchable: false, changesUi: false },
  { name: "task.finish", group: "task", description: "Finish the task. success=true ONLY when the observation proves the goal is done.", args: obj({ success: bool("Goal verifiably achieved"), summary: str("One factual sentence about the outcome", { maxLength: 300 }) }, ["success", "summary"]), capability: "READ_FILE", resources: none, progress: () => "Wrapping up…", batchable: false, changesUi: false },
];

export const ACTION_MAP = new Map(ACTIONS.map((action) => [action.name, action]));

function hostOf(value: unknown): string {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return String(value ?? "");
  }
}

/**
 * Context-aware exposure: only groups relevant to the goal and the current
 * screen are shown to the planner, keeping prompts small.
 */
export function exposedGroups(goal: string, context: { process?: string | null; isBrowser?: boolean; recentTools?: string[] }): Set<ActionGroup> {
  const groups = new Set<ActionGroup>(["core", "vision", "window", "app", "task", "memory"]);
  const text = goal.toLowerCase();
  if (context.isBrowser || /(http|www\.|\.com|site|website|web|search|google|youtube|browser|chrome|edge|online|internet|official|download|whatsapp web|gmail|login)/.test(text)) {
    groups.add("browser");
    groups.add("web");
  }
  if (/(file|folder|photo|image|picture|pic|thumbnail|video|document|pdf|screenshot|download|explorer|copy|move|rename|delete|organi[sz]e|tasveer|foto)/.test(text) || /explorer/i.test(context.process || "")) {
    groups.add("files");
  }
  if (/(download|installer|setup|\.exe|\.msi|\.zip)/.test(text)) groups.add("download");
  if (/(msg|message|send|bhej|text|chat|whatsapp|\bwp\b|\bwa\b|telegram|signal|messenger|reply|call|baat)/.test(text)) groups.add("messaging");
  if (/(send|bhej|attach|share|paste|copy|clipboard|whatsapp|telegram|mail)/.test(text)) groups.add("clipboard");
  if (/(command|terminal|cmd|powershell|ping|ipconfig|script)/.test(text)) groups.add("shell");
  if (/(notify|remind|alert)/.test(text)) groups.add("system");
  if (/(drag|draw|canvas|paint|game|slider)/.test(text)) groups.add("mouse");
  for (const tool of context.recentTools || []) {
    const definition = ACTION_MAP.get(tool);
    if (definition) groups.add(definition.group);
  }
  return groups;
}

export function catalogText(groups: Set<ActionGroup>): string {
  return ACTIONS.filter((action) => groups.has(action.group)).map((action) => {
    const props = (action.args.properties || {}) as Record<string, JsonSchema>;
    const required = new Set(action.args.required || []);
    const signature = Object.entries(props).map(([key, schema]) => {
      const type = schema.enum ? (schema.enum as string[]).join("|") : Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
      return `${key}${required.has(key) ? "" : "?"}:${type}`;
    }).join(", ");
    return `- ${action.name}(${signature}) — ${action.description}`;
  }).join("\n");
}

