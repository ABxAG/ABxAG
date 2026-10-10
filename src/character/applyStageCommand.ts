/**
 * Shared stage-command routing for every live 3D character instance.
 *
 * The main window and the desktop-companion window each own a
 * CharacterSystem. Voice/tool commands ("jump", "dress red") arrive as plain
 * `{kind, ...}` payloads; this applies action/outfit kinds to any system.
 * Switches are handled by the host App, not here. Returns true when the
 * command was understood (even if this particular model cannot do it).
 */

export type StageCommand =
  | { kind: 'action'; action: string; target?: StageTarget }
  | { kind: 'outfit'; cloth?: string | null; hair?: string | null; target?: StageTarget };

/** Which doll(s) a command is for. Missing = both (previous behaviour). */
export type StageTarget = 'stage' | 'companion' | 'both';

export function targetMatches(cmd: StageCommand | { target?: StageTarget }, side: 'stage' | 'companion'): boolean {
  const target = cmd.target ?? 'both';
  return target === 'both' || target === side;
}

export function isStageCommand(value: unknown): value is StageCommand {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'action' || kind === 'outfit';
}

export type StageCommandTarget = {
  performAction: (action: string) => unknown;
  setOutfitTint: (tint: { cloth?: string | null; hair?: string | null }) => unknown;
};

export function applyStageCommand(
  system: StageCommandTarget | null | undefined,
  cmd: StageCommand,
): boolean {
  if (!system) return false;
  if (cmd.kind === 'action') {
    system.performAction(cmd.action);
    return true;
  }
  if (cmd.kind === 'outfit') {
    system.setOutfitTint({ cloth: cmd.cloth, hair: cmd.hair });
    return true;
  }
  return false;
}
