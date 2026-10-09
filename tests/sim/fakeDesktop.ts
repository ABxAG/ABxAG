/**
 * A simulated Windows desktop for loop/executor integration tests.
 *
 * Implements the subset of desktop-agent tools the agent uses, backed by a
 * tiny model of a WhatsApp-like messenger. Nothing touches the real OS and no
 * real message can be sent.
 */

interface Element {
  key: string;
  role: string;
  name: string;
  value?: string;
  actions?: string[];
  focused?: boolean;
  selected?: boolean;
}

export class FakeDesktop {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  messengerOpen = false;
  searchText = "";
  openChat: string | null = null;
  compose = "";
  attachment: string | null = null;
  focusedKey: string | null = null;
  clipboardFiles: string[] = [];
  sent: Array<{ to: string; file: string | null; text: string }> = [];
  /** Hide the Send button for this many inspections (simulates a slow UI). */
  hideSendFor = 0;
  /** Make the next uiAction on this element key fail as if the UI changed. */
  vanishOnce: string | null = null;
  windowLeft = 100;
  readonly chats = ["Papa", "Mummy", "Rahul"];
  readonly files = [
    { name: "IMG_1032.png", path: "C:\\Users\\Test\\Pictures\\IMG_1032.png", kind: "image", modified: "2026-10-02T10:00:00" },
    { name: "IMG_1031.png", path: "C:\\Users\\Test\\Pictures\\IMG_1031.png", kind: "image", modified: "2026-10-01T09:00:00" },
  ];
  private snapshot = 0;
  private ids = new Map<string, string>();

  get call() {
    return async (tool: string, args: Record<string, unknown>) => this.handle(tool, args);
  }

  private elements(): Element[] {
    if (!this.messengerOpen) return [{ key: "desktop.recycle", role: "listitem", name: "Recycle Bin" }];
    const list: Element[] = [
      { key: "search", role: "edit", name: "Search or start a new chat", value: this.searchText, actions: ["value"], focused: this.focusedKey === "search" },
    ];
    for (const chat of this.chats.filter((name) => !this.searchText || name.toLowerCase().includes(this.searchText.toLowerCase()))) {
      list.push({ key: `chat:${chat}`, role: "listitem", name: chat, actions: ["select", "invoke"], selected: this.openChat === chat });
    }
    if (this.openChat) {
      list.push({ key: "header", role: "text", name: `Chat with ${this.openChat}` });
      list.push({ key: "compose", role: "edit", name: "Type a message", value: this.compose, actions: ["value"], focused: this.focusedKey === "compose" });
      if (this.attachment) list.push({ key: "preview", role: "image", name: `Preview: ${this.attachment.split("\\").pop()}` });
      if ((this.attachment || this.compose) && this.hideSendFor <= 0) list.push({ key: "send", role: "button", name: "Send", actions: ["invoke"] });
    }
    for (const message of this.sent.filter((m) => m.to === this.openChat)) {
      list.push({ key: `sent:${message.file}`, role: "text", name: `Message sent: ${message.file ? message.file.split("\\").pop() : message.text}` });
    }
    return list;
  }

  private stateKey(): string {
    return JSON.stringify([this.messengerOpen, this.searchText, this.openChat, this.compose, this.attachment, this.sent.length, this.windowLeft]);
  }

  private window() {
    return this.messengerOpen
      ? { hwnd: 4242, title: this.openChat ? `${this.openChat} - WhatsApp` : "WhatsApp", class: "WhatsAppWindow", process: "WhatsApp.exe", pid: 99, rect: { left: this.windowLeft, top: 50, right: this.windowLeft + 900, bottom: 750 }, minimized: false, foreground: true }
      : { hwnd: 1, title: "Program Manager", class: "Progman", process: "explorer.exe", pid: 1, rect: { left: 0, top: 0, right: 1920, bottom: 1080 }, minimized: false, foreground: true };
  }

  private inspect(query?: string) {
    if (this.hideSendFor > 0) this.hideSendFor -= 1;
    this.snapshot += 1;
    this.ids.clear();
    const elements = this.elements()
      .filter((element) => !query || element.name.toLowerCase().includes(query.toLowerCase()))
      .map((element, index) => {
        const id = `e${index + 1}`;
        this.ids.set(id, element.key);
        const y = 60 + index * 30;
        return { id, role: element.role, name: element.name, rect: { left: this.windowLeft + 10, top: y, right: this.windowLeft + 300, bottom: y + 24 }, enabled: true, ...(element.value ? { value: element.value } : {}), ...(element.actions ? { actions: element.actions } : {}), ...(element.focused ? { focused: true } : {}), ...(element.selected ? { selected: true } : {}) };
      });
    return { snapshot_id: `s${this.snapshot}`, window: this.window(), elements, element_count_total: elements.length, truncated: false, duration_ms: 3 };
  }

  private act(key: string, action: string, value?: string) {
    if (this.vanishOnce === key) {
      this.vanishOnce = null;
      this.windowLeft += 40; // the layout shifts; the next observation has new rects
      throw new Error("ELEMENT_NOT_FOUND: the element no longer exists (the UI changed).");
    }
    if (!this.elements().some((element) => element.key === key)) throw new Error("ELEMENT_NOT_FOUND: the element no longer exists (the UI changed).");
    if (key === "search") {
      this.focusedKey = "search";
      if (action === "set_value") this.searchText = value || "";
    } else if (key === "compose") {
      this.focusedKey = "compose";
      if (action === "set_value") this.compose = value || "";
    } else if (key.startsWith("chat:")) {
      this.openChat = key.slice(5);
      this.compose = "";
      this.attachment = null;
      this.focusedKey = "compose";
    } else if (key === "send") {
      this.doSend();
    }
    return { method: action === "click" ? "uia.invoke" : `uia.${action}`, used_pointer: false, moved_since_snapshot: false, verified_value: action === "set_value" ? true : undefined };
  }

  private doSend() {
    if (!this.openChat || (!this.attachment && !this.compose)) return;
    this.sent.push({ to: this.openChat, file: this.attachment, text: this.compose });
    this.attachment = null;
    this.compose = "";
  }

  private async handle(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    this.calls.push({ tool, args });
    try {
      switch (tool) {
        case "observeDesktopState":
          return { ok: true, result: { observation: { active_window: { title: this.window().title, pid: 99, bounds: this.window().rect }, visible_windows: [{ title: this.window().title, pid: 99, bounds: this.window().rect }] } } };
        case "screenFingerprint": {
          const key = args.target === "rect" ? "rect" : this.stateKey();
          let hash = 7;
          for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 251;
          const columns = Number(args.columns) || 24, rows = Number(args.rows) || 14;
          return { ok: true, result: { region: { left: 0, top: 0, right: 1920, bottom: 1080 }, columns, rows, cells: Array.from({ length: columns * rows }, (_, i) => (hash * (i + 3)) % 255) } };
        }
        case "inputState":
          return { ok: true, result: { idle_ms: 60_000, cursor: { x: 5, y: 5 } } };
        case "inspectUi":
          return { ok: true, result: this.inspect() };
        case "findUi":
          return { ok: true, result: this.inspect(String(args.query || "")) };
        case "uiAction": {
          const key = this.ids.get(String(args.element_id));
          if (!key) return { ok: false, error: `ELEMENT_NOT_FOUND: ${args.element_id} is not in snapshot.` };
          const result = this.act(key, String(args.action || "click"), args.value as string | undefined);
          return { ok: true, result: { element: { id: args.element_id, role: "x", name: key }, ...result } };
        }
        case "typeUnicode":
          if (this.focusedKey === "compose") this.compose += String(args.text);
          else if (this.focusedKey === "search") this.searchText += String(args.text);
          return { ok: true, result: { result: "typed" } };
        case "pressKey":
          if (String(args.key) === "enter" && this.focusedKey === "compose") this.doSend();
          return { ok: true, result: { result: "pressed" } };
        case "hotkey": {
          const keys = (args.keys as string[]).join("+");
          if (keys === "ctrl+v" && this.focusedKey === "compose" && this.clipboardFiles.length) this.attachment = this.clipboardFiles[0];
          return { ok: true, result: { result: "hotkey" } };
        }
        case "copyFilesToClipboard":
          this.clipboardFiles = (args.paths as string[]).slice();
          return { ok: true, result: { result: "copied", paths: this.clipboardFiles } };
        case "openApplication":
          if (/whatsapp/i.test(String(args.name))) this.messengerOpen = true;
          return { ok: true, result: { result: `Opened ${args.name}` } };
        case "listVisibleWindows":
          return { ok: true, result: { windows: [{ title: this.window().title, pid: 99, bounds: this.window().rect }] } };
        case "recentFiles":
          return { ok: true, result: { files: this.files.map((file) => ({ ...file, size: 1000, modified_epoch: 0 })) } };
        case "statPath": {
          const file = this.files.find((item) => item.path.toLowerCase() === String(args.path).toLowerCase());
          return { ok: true, result: file ? { exists: true, kind: file.kind, path: file.path, name: file.name } : { exists: false } };
        }
        case "browserState":
          return { ok: false, error: "not a browser" };
        case "getActiveWindow":
          return { ok: true, result: { title: this.window().title } };
        default:
          return { ok: false, error: `FakeDesktop does not implement ${tool}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Rule-based stand-in for the planning model. It only sees what a real model
 * would see — the compiled prompt text — and answers with the same schema.
 */
export class ScriptedPlanner {
  calls = 0;
  lastPrompt = "";
  constructor(private readonly file = "C:\\Users\\Test\\Pictures\\IMG_1032.png", private readonly contact = "Papa") {}

  generate = async (_task: string, request: { messages: Array<{ parts: Array<{ type: string; text?: string }> }> }) => {
    this.calls += 1;
    const text = request.messages[0].parts.find((part) => part.type === "text")?.text || "";
    this.lastPrompt = text;
    const id = (pattern: RegExp) => text.split("\n").find((line) => pattern.test(line))?.match(/^(e\d+)/)?.[1];
    const decision = (status: string, actions: Array<{ tool: string; args: Record<string, unknown>; expect?: string }>, matched: boolean | null = true) => ({
      json: {
        verification_of_previous: { matched, evidence: "scripted" },
        situation: "scripted",
        goal_status: status,
        plan: ["scripted"],
        status_for_user: "Working…",
        actions: actions.map((action) => ({ tool: action.tool, args_json: JSON.stringify(action.args), expect: action.expect || "" })),
        confidence: 0.9,
      },
      modelId: "scripted",
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      latencyMs: 1,
      text: "",
      toolCalls: [],
      finishReason: "STOP",
    });
    if (/Message sent: IMG_1032\.png/.test(text)) return decision("done", [{ tool: "task.finish", args: { success: true, summary: `Sent IMG_1032.png to ${this.contact}.` } }]);
    if (!/WhatsApp\.exe/.test(text)) return decision("continue", [{ tool: "app.launch", args: { name: "WhatsApp" } }], null);
    if (!new RegExp(`Chat with ${this.contact}`).test(text)) {
      const chat = id(new RegExp(`listitem "${this.contact}"`));
      if (chat && /value="Papa"/i.test(text)) return decision("continue", [{ tool: "ui.click", args: { element: chat } }]);
      const search = id(/edit "Search or start a new chat"/);
      return decision("continue", [{ tool: "ui.type", args: { element: search, text: this.contact, replace: true } }]);
    }
    if (/Preview: IMG_1032\.png/.test(text)) {
      const send = id(/button "Send"/);
      if (!send) return decision("continue", [{ tool: "wait", args: { seconds: 0.3, until: "time" } }]);
      return decision("continue", [{ tool: "ui.click", args: { element: send } }]);
    }
    const compose = id(/edit "Type a message"/);
    return decision("continue", [
      { tool: "clipboard.copy_files", args: { paths: [this.file] } },
      { tool: "ui.click", args: { element: compose } },
      { tool: "keyboard.hotkey", args: { keys: ["ctrl", "v"] } },
    ]);
  };
}
