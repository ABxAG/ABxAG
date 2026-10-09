/**
 * Deterministic action risk classification.
 *
 * The planner is a language model and can be wrong or manipulated by text on
 * a web page. So the capability an action needs is derived here from what the
 * action *does* in the current UI — the label of the element being clicked,
 * the app it lives in, the key being pressed — not from what the planner says
 * it is doing. A high-risk capability that the user's own request never asked
 * for is additionally flagged as possible prompt injection.
 */
import type { Capability, PermissionContext } from "../../permissions/types";
import type { DesktopState, UiElement } from "../perception/engine";

export interface RiskAssessment {
  capabilities: Array<{ capability: Capability; context: PermissionContext; reason: string }>;
  /** Capabilities the user's goal does not mention — treated as suspicious. */
  goalMismatch: Capability[];
  highRisk: boolean;
}

const MESSAGING_PROCESS = /whatsapp|telegram|signal|discord|slack|teams|ms-teams|messenger|skype|outlook|thunderbird|mail/i;
const MESSAGING_URL = /web\.whatsapp\.com|web\.telegram\.org|mail\.google\.com|outlook\.(live|office)\.com|discord\.com\/channels|messenger\.com|instagram\.com\/direct|x\.com\/messages|twitter\.com\/messages|slack\.com|teams\.(microsoft|live)\.com|linkedin\.com\/messaging/i;
const SEND_LABEL = /^(send|send message|send now|reply|post|share|submit|forward|bhejo|bhej|भेजें|भेजो)\b|\bsend\b/i;
const PURCHASE_LABEL = /(buy now|place (your )?order|pay now|pay ₹|pay \$|proceed to pay|confirm (payment|purchase|order)|complete purchase|checkout|purchase|subscribe now|start subscription)/i;
const DELETE_LABEL = /^(delete|permanently delete|delete forever|erase|empty recycle bin|uninstall|wipe|format|remove permanently|discard all)/i;
const ACCOUNT_LABEL = /(change password|reset password|delete (my )?account|close account|deactivate account|sign out (of )?all|log ?out everywhere|two[- ]?factor|2fa|security key|recovery (email|phone)|remove device)/i;
const INSTALL_LABEL = /^(install|install now|run anyway|run|yes|continue installation|finish)$/i;
const INSTALLER_CONTEXT = /(setup|installer|install|user account control|smartscreen|windows protected your pc|uac)/i;
const SYSTEM_PROCESS = /^(systemsettings|regedit|mmc|gpedit|secpol|services|windowsdefender|sechealthui|control|firewall|wf|taskschd|compmgmt|devmgmt)\b/i;

const GOAL_HINTS: Partial<Record<Capability, RegExp>> = {
  SEND_MESSAGE: /(send|bhej|message|msg|whatsapp|text|mail|email|reply|share|forward|post|telegram|dm|chat)/i,
  PURCHASE: /(buy|order|purchase|pay|kharid|checkout|subscribe)/i,
  DELETE_FILE: /(delete|remove|hata|mita|clean|clear|uninstall|trash|recycle|erase)/i,
  ACCOUNT_CHANGE: /(password|account|login|sign ?out|2fa|security)/i,
  INSTALL_SOFTWARE: /(install|setup|run the (installer|setup)|update)/i,
  EXECUTE_DOWNLOAD: /(install|setup|run|open|launch|execute|chala)/i,
  RUN_COMMAND: /(run|command|terminal|cmd|powershell|script|execute)/i,
  MODIFY_SYSTEM_SETTINGS: /(setting|settings|enable|disable|turn (on|off)|startup|firewall|defender|registry|bluetooth|wifi|display|sound)/i,
};

export interface RiskInput {
  tool: string;
  args: Record<string, unknown>;
  baseCapability: Capability;
  state: DesktopState | null;
  goal: string;
  recipient?: { name: string; contactId: string | null } | null;
  targetElement?: UiElement | null;
  targetLabel?: string | null;
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const capabilities: RiskAssessment["capabilities"] = [];
  const add = (capability: Capability, reason: string, context: PermissionContext = {}) => {
    if (!capabilities.some((item) => item.capability === capability)) capabilities.push({ capability, context, reason });
  };
  add(input.baseCapability, "base capability of the action", contextFor(input));

  const state = input.state;
  const process = (state?.activeWindow?.process || "").replace(/\.exe$/i, "");
  const title = state?.activeWindow?.title || "";
  const url = state?.browser?.url || "";
  const messaging = MESSAGING_PROCESS.test(process) || MESSAGING_URL.test(url) || /whatsapp|telegram|discord|slack|messenger/i.test(title);
  const label = (input.targetLabel ?? input.targetElement?.name ?? "").trim();
  const isActivation = /^(ui\.click|ui\.invoke|mouse\.(click|double_click))$/.test(input.tool);
  const key = String(input.args.key || "").toLowerCase();
  const hotkey = Array.isArray(input.args.keys) ? input.args.keys.map((k) => String(k).toLowerCase()) : [];
  const pressesEnter = (input.tool === "keyboard.press" && (key === "enter" || key === "return"))
    || (input.tool === "keyboard.hotkey" && hotkey.includes("enter"));
  const focused = state?.elements.find((element) => element.focused);
  const composing = Boolean(focused && (focused.role === "edit" || focused.role === "document"));

  if (messaging && ((isActivation && SEND_LABEL.test(label)) || (pressesEnter && composing))) {
    add("SEND_MESSAGE", isActivation ? `activating "${label}" in a messaging app` : "pressing Enter in a message box", {
      recipient: input.recipient?.name || chatTitle(title),
      recipientContactId: input.recipient?.contactId ?? null,
      detail: `${process || state?.browser?.browser || "app"}: ${title}`,
    });
  }
  if (isActivation && PURCHASE_LABEL.test(label)) add("PURCHASE", `activating "${label}"`, { detail: url || title });
  if (isActivation && ACCOUNT_LABEL.test(label)) add("ACCOUNT_CHANGE", `activating "${label}"`, { detail: url || title });
  if (isActivation && DELETE_LABEL.test(label)) add("DELETE_FILE", `activating "${label}"`, { detail: title, permanent: /permanent|forever|empty recycle|erase|wipe|format/i.test(label) });
  if (isActivation && INSTALL_LABEL.test(label) && (INSTALLER_CONTEXT.test(title) || state?.dialogs.some((d) => INSTALLER_CONTEXT.test(d)))) {
    add("INSTALL_SOFTWARE", `confirming an installer step ("${label}")`, { detail: title });
  }
  if ((isActivation || input.tool === "ui.toggle" || input.tool === "ui.set_value") && SYSTEM_PROCESS.test(process)) {
    add("MODIFY_SYSTEM_SETTINGS", `changing a control in ${process}`, { detail: title });
  }
  if (input.tool === "fs.open" && input.args.__executable === true) {
    add("EXECUTE_DOWNLOAD", "opening an executable, installer or script", contextFor(input));
  }

  const goalMismatch = capabilities
    .map((item) => item.capability)
    .filter((capability) => GOAL_HINTS[capability] && !GOAL_HINTS[capability]!.test(input.goal));
  const highRisk = capabilities.some((item) => ["SEND_MESSAGE", "PURCHASE", "ACCOUNT_CHANGE", "DELETE_FILE", "INSTALL_SOFTWARE", "EXECUTE_DOWNLOAD", "RUN_COMMAND", "MODIFY_SYSTEM_SETTINGS", "POWER_CONTROL"].includes(item.capability));
  return { capabilities, goalMismatch, highRisk };
}

function contextFor(input: RiskInput): PermissionContext {
  const context: PermissionContext = {};
  if (typeof input.args.path === "string") context.path = input.args.path;
  if (typeof input.args.url === "string") {
    try {
      context.domain = new URL(String(input.args.url)).hostname;
    } catch {
      /* not a URL */
    }
  }
  if (typeof input.args.command === "string") context.command = input.args.command;
  if (input.args.permanent === true) context.permanent = true;
  if (input.tool === "chat.send") {
    context.recipient = input.recipient?.name || String(input.args.name || "");
    context.recipientContactId = input.recipient?.contactId ?? null;
    context.detail = `${String(input.args.app || "WhatsApp")}: "${String(input.args.text || "").slice(0, 120)}"`;
  }
  return context;
}

/** WhatsApp/Telegram desktop titles are usually the open chat name. */
function chatTitle(title: string): string | undefined {
  const cleaned = title.replace(/\s*[-|–]\s*(WhatsApp|Telegram|Discord|Slack|Messenger).*$/i, "").trim();
  return cleaned && cleaned.length < 80 ? cleaned : undefined;
}
