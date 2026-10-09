export type Capability =
  | "READ_FILE"
  | "WRITE_FILE"
  | "DELETE_FILE"
  | "DOWNLOAD_FILE"
  | "EXECUTE_DOWNLOAD"
  | "SEND_MESSAGE"
  | "RUN_COMMAND"
  | "INSTALL_SOFTWARE"
  | "MODIFY_SYSTEM_SETTINGS"
  | "ACCESS_MICROPHONE"
  | "ACCESS_CAMERA"
  | "CONTROL_INPUT"
  | "SCREEN_CAPTURE"
  | "LAUNCH_APP"
  | "BROWSE_WEB"
  | "CLIPBOARD"
  | "NETWORK_API"
  | "PURCHASE"
  | "ACCOUNT_CHANGE"
  | "POWER_CONTROL";

export type Decision = "allow" | "ask" | "deny";

export interface PermissionContext {
  /** Resolved recipient display name for SEND_MESSAGE. */
  recipient?: string;
  recipientContactId?: string | null;
  /** Absolute target path for file capabilities. */
  path?: string;
  /** Target web domain. */
  domain?: string;
  /** Command line for RUN_COMMAND. */
  command?: string;
  /** Free-form extra detail shown in the confirmation prompt. */
  detail?: string;
  /** Hard-delete (bypassing the Recycle Bin). */
  permanent?: boolean;
}

export interface ScopedRule {
  id: string;
  description: string;
  when: {
    trustedContact?: boolean;
    newRecipient?: boolean;
    pathPrefix?: string;
    domain?: string;
    commandPrefix?: string;
  };
  decision: Decision;
}

export interface CapabilityPolicy {
  decision: Decision;
  rules?: ScopedRule[];
}

export type MessageConfirmationMode =
  | "always_confirm"
  | "confirm_new_recipients"
  | "trusted_without_confirmation"
  | "never_without_preview";

export interface PermissionPolicy {
  version: 1;
  capabilities: Record<Capability, CapabilityPolicy>;
  messageConfirmation: MessageConfirmationMode;
  /** Contact IDs the user marked as trusted. */
  trustedContacts: string[];
  /** Contact IDs a message has previously been sent to with approval. */
  knownRecipients: string[];
}

export interface PermissionVerdict {
  capability: Capability;
  decision: Decision;
  reason: string;
  ruleId?: string;
  /** True when policy cannot be relaxed below "ask" (installs, purchases…). */
  locked: boolean;
}

export const CAPABILITY_INFO: Record<Capability, { label: string; description: string; risk: "low" | "medium" | "high" }> = {
  READ_FILE: { label: "Read files", description: "List, search and read files in your folders.", risk: "low" },
  WRITE_FILE: { label: "Create & edit files", description: "Create, copy, move and rename files.", risk: "medium" },
  DELETE_FILE: { label: "Delete files", description: "Move files to the Recycle Bin (permanent delete always asks).", risk: "high" },
  DOWNLOAD_FILE: { label: "Download files", description: "Save files from the internet to your Downloads folder.", risk: "medium" },
  EXECUTE_DOWNLOAD: { label: "Run downloaded files", description: "Open installers or scripts that were downloaded.", risk: "high" },
  SEND_MESSAGE: { label: "Send messages", description: "Send messages or files through apps like WhatsApp.", risk: "high" },
  RUN_COMMAND: { label: "Run commands", description: "Run shell commands beyond the safe read-only set.", risk: "high" },
  INSTALL_SOFTWARE: { label: "Install software", description: "Run installers or change installed programs.", risk: "high" },
  MODIFY_SYSTEM_SETTINGS: { label: "System settings", description: "Change Windows settings such as startup entries.", risk: "high" },
  ACCESS_MICROPHONE: { label: "Microphone", description: "Listen through your microphone during voice sessions.", risk: "medium" },
  ACCESS_CAMERA: { label: "Camera", description: "Camera-based presence (off unless you enable it).", risk: "high" },
  CONTROL_INPUT: { label: "Mouse & keyboard", description: "Click, type and scroll on your desktop.", risk: "medium" },
  SCREEN_CAPTURE: { label: "See the screen", description: "Capture screenshots and read on-screen UI.", risk: "medium" },
  LAUNCH_APP: { label: "Open apps", description: "Launch and switch applications.", risk: "low" },
  BROWSE_WEB: { label: "Use the browser", description: "Open websites and search in your browser.", risk: "low" },
  CLIPBOARD: { label: "Clipboard", description: "Read and write the clipboard.", risk: "medium" },
  NETWORK_API: { label: "Public APIs", description: "Call verified public data APIs (weather, currency…).", risk: "low" },
  PURCHASE: { label: "Purchases", description: "Anything that spends money.", risk: "high" },
  ACCOUNT_CHANGE: { label: "Account changes", description: "Change passwords, profiles or account security.", risk: "high" },
  POWER_CONTROL: { label: "Power", description: "Shut down, restart, sleep or lock the PC.", risk: "high" },
};

/** Capabilities whose decision can never be relaxed to "allow". */
export const LOCKED_TO_ASK: ReadonlySet<Capability> = new Set([
  "EXECUTE_DOWNLOAD",
  "INSTALL_SOFTWARE",
  "PURCHASE",
  "ACCOUNT_CHANGE",
  "POWER_CONTROL",
]);
