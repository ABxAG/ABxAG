/**
 * Companion doll string commands ("sit", "wave", "perform:dance", …) mapped
 * to actor commands. Pure and tiny so voice routing stays testable.
 */
import type { ActorCommand } from './CompanionActor';

export function mapCompanionStringCommand(command: string): ActorCommand | { act: 'perform'; name: string } | null {
  if (command === 'sit') return { act: 'sit' };
  if (command === 'stand') return { act: 'stand' };
  if (command === 'wave') return { act: 'perform', name: 'wave' };
  // Full body control from voice ("doll dance karo", "companion backflip"):
  // any "perform:<action>" passes the action name straight through.
  if (command.startsWith('perform:')) {
    const name = command.slice('perform:'.length).trim();
    return name ? { act: 'perform', name } : null;
  }
  return null;
}
