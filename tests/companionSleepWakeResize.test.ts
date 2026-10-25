/**
 * Tests for companion sleep/wake and hide/show functionality
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the companion module
let CompanionManager;

beforeEach(async () => {
  const mod = await import('../electron/companion.cjs');
  CompanionManager = mod.CompanionManager;
});

describe('Companion Sleep/Wake/Hide/Show', () => {
  it('should have sleep, wake, hide_window, show_window command handlers', () => {
    const handleCommandStr = CompanionManager.prototype.handleCommand.toString();
    assert.ok(handleCommandStr.includes("case 'sleep':"), 'should handle sleep command');
    assert.ok(handleCommandStr.includes("case 'wake':"), 'should handle wake command');
    assert.ok(handleCommandStr.includes("case 'hide_window':"), 'should handle hide_window command');
    assert.ok(handleCommandStr.includes("case 'show_window':"), 'should handle show_window command');
  });

  it('should have adjustScale method for resize', () => {
    const handleCommandStr = CompanionManager.prototype.handleCommand.toString();
    assert.ok(handleCommandStr.includes('resize:'), 'should handle resize: string commands');
    assert.ok(handleCommandStr.includes('adjustScale'), 'should call adjustScale method');
    // Updated: now checks for delta/absolute/reset properties directly (not command.type === 'resize')
    assert.ok(handleCommandStr.includes('command.delta !== undefined'), 'should handle delta in object');
  });

  it('should have sleeping and windowHidden getters', () => {
    // Getters are defined on the prototype via `get sleeping()` in the class
    const proto = Object.getPrototypeOf(CompanionManager.prototype);
    const sleepingDesc = Object.getOwnPropertyDescriptor(CompanionManager.prototype, 'sleeping');
    const windowHiddenDesc = Object.getOwnPropertyDescriptor(CompanionManager.prototype, 'windowHidden');
    assert.ok(sleepingDesc && typeof sleepingDesc.get === 'function', 'should have sleeping getter');
    assert.ok(windowHiddenDesc && typeof windowHiddenDesc.get === 'function', 'should have windowHidden getter');
  });
});

describe('Companion Resize Commands', () => {
  let handleCommandStr;

  beforeEach(() => {
    handleCommandStr = CompanionManager.prototype.handleCommand.toString();
  });

  it('should parse resize: string commands correctly', () => {
    // Check for delta parsing (+0.25, -0.25)
    assert.ok(handleCommandStr.includes('payload.startsWith(\'+\') || payload.startsWith(\'-\')'), 
      'should parse relative delta commands');
    assert.ok(handleCommandStr.includes('payload === \'reset\''), 
      'should parse reset command');
    assert.ok(handleCommandStr.includes('Number(payload)'), 
      'should parse absolute scale commands');
  });

  it('should handle object payload for resize', () => {
    // Updated: now checks for delta/absolute/reset properties directly (not command.type === 'resize')
    assert.ok(handleCommandStr.includes('command.delta !== undefined'), 
      'should handle delta in object');
    assert.ok(handleCommandStr.includes('command.absolute !== undefined'), 
      'should handle absolute in object');
    assert.ok(handleCommandStr.includes('command.reset'), 
      'should handle reset in object');
  });
});

describe('Companion Think/FollowAnchor Guards', () => {
  let thinkStr;
  let followStr;

  beforeEach(() => {
    thinkStr = CompanionManager.prototype.think.toString();
    followStr = CompanionManager.prototype.followAnchor.toString();
  });

  it('should skip think() when sleeping', () => {
    assert.ok(thinkStr.includes('this.sleeping || this.mode === \'window_hidden\''), 
      'should return early when sleeping or window_hidden');
  });

  it('should skip followAnchor when sleeping or window_hidden', () => {
    assert.ok(followStr.includes('this.sleeping || this.mode === \'window_hidden\''), 
      'should return early when sleeping or window_hidden');
  });
});