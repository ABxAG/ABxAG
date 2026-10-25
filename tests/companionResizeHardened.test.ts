/**
 * Hardened Companion Resize Tests — Source Code Pattern Verification
 * Follows the same pattern as companionSleepWakeResize.test.ts
 * Verifies the hardened implementation is present in source code
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

describe('Companion Resize Hardened — Source Verification', () => {
  let handleCommandStr;
  let adjustScaleStr;
  let destroyStr;
  let constructorStr;

  beforeEach(() => {
    handleCommandStr = CompanionManager.prototype.handleCommand.toString();
    adjustScaleStr = CompanionManager.prototype.adjustScale.toString();
    destroyStr = CompanionManager.prototype.destroy.toString();
    constructorStr = CompanionManager.prototype.constructor.toString();
  });

  describe('Constructor — Debounce State', () => {
    it('should initialize _resizeDebounceTimer and _resizePending', () => {
      assert.ok(constructorStr.includes('_resizeDebounceTimer'), 'should have _resizeDebounceTimer property');
      assert.ok(constructorStr.includes('_resizePending'), 'should have _resizePending property');
      assert.ok(constructorStr.includes('null'), 'should initialize to null');
    });
  });

  describe('adjustScale — Hardened Implementation', () => {
    it('should have debounce logic with 500ms timer', () => {
      assert.ok(adjustScaleStr.includes('_resizeDebounceTimer'), 'should check _resizeDebounceTimer');
      assert.ok(adjustScaleStr.includes('_resizePending'), 'should use _resizePending');
      assert.ok(adjustScaleStr.includes('setTimeout'), 'should use setTimeout for debounce');
      assert.ok(adjustScaleStr.includes('500'), 'should have 500ms debounce window');
    });

    it('should clamp scale with logging at boundaries', () => {
      assert.ok(adjustScaleStr.includes('Math.max(0.4, Math.min(2.5'), 'should clamp to 0.4-2.5');
      assert.ok(adjustScaleStr.includes('scale clamp:'), 'should log clamp events');
      assert.ok(adjustScaleStr.includes('range 0.4-2.5'), 'should include range in log');
    });

    it('should have atomic persist — ack only after saveSettings resolves', () => {
      assert.ok(adjustScaleStr.includes('await this.options.saveSettings'), 'should await saveSettings');
      assert.ok(adjustScaleStr.includes('try {'), 'should have try-catch for persist');
      assert.ok(adjustScaleStr.includes('scale persist failed'), 'should log persist failure');
      assert.ok(adjustScaleStr.includes('happyFace'), 'should play ack animation on success');
    });

    it('should handle no-op cases', () => {
      assert.ok(adjustScaleStr.includes('scale unchanged'), 'should log unchanged scale');
      assert.ok(adjustScaleStr.includes('no valid operation'), 'should handle invalid options');
    });

    it('should return early if win is null', () => {
      assert.ok(adjustScaleStr.includes('if (!this.win) return'), 'should guard against null win');
    });
  });

  describe('handleCommand — Resize Parsing', () => {
    it('should parse resize: string commands', () => {
      assert.ok(handleCommandStr.includes('resize:'), 'should handle resize: prefix');
      assert.ok(handleCommandStr.includes('payload === \'reset\''), 'should parse reset');
      assert.ok(handleCommandStr.includes('payload.startsWith(\'+\') || payload.startsWith(\'-\')'), 'should parse delta');
      assert.ok(handleCommandStr.includes('Number(payload)'), 'should parse absolute');
    });

    it('should parse object payload with delta/absolute/reset', () => {
      assert.ok(handleCommandStr.includes('command.delta !== undefined'), 'should handle delta in object');
      assert.ok(handleCommandStr.includes('command.absolute !== undefined'), 'should handle absolute in object');
      assert.ok(handleCommandStr.includes('command.reset'), 'should handle reset in object');
    });

    it('should NOT use old command.type === \'resize\' pattern', () => {
      // Ensure old pattern is removed
      const hasOldPattern = handleCommandStr.includes('command.type === \'resize\'');
      assert.ok(!hasOldPattern, 'should not use old command.type pattern');
    });
  });

  describe('destroy — Cleanup', () => {
    it('should clear debounce timer on destroy', () => {
      assert.ok(destroyStr.includes('_resizeDebounceTimer'), 'should reference _resizeDebounceTimer');
      assert.ok(destroyStr.includes('clearTimeout'), 'should clear timeout');
      assert.ok(destroyStr.includes('_resizePending = null'), 'should clear pending');
    });
  });
});

describe('Companion Resize — Bengali Number Parsing Logic', () => {
  // Test the parsing logic directly (same as in liveAgentTools.ts)
  const parseBengaliNumber = (str) => {
    const bengaliDigits = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
    let normalized = str;
    for (let i = 0; i < 10; i++) {
      normalized = normalized.replaceAll(bengaliDigits[i], String(i));
    }
    const match = normalized.match(/([0-9]*\.?[0-9]+)/);
    return match ? Number(match[1]) : null;
  };

  it('should parse Bengali digits "১.৫" to 1.5', () => {
    assert.strictEqual(parseBengaliNumber('১.৫'), 1.5);
  });

  it('should parse mixed "size ১.৫" to 1.5', () => {
    assert.strictEqual(parseBengaliNumber('size ১.৫'), 1.5);
  });

  it('should parse "১" to 1', () => {
    assert.strictEqual(parseBengaliNumber('১'), 1);
  });

  it('should parse "২.৫" to 2.5', () => {
    assert.strictEqual(parseBengaliNumber('২.৫'), 2.5);
  });

  it('should parse English "1.5" to 1.5', () => {
    assert.strictEqual(parseBengaliNumber('1.5'), 1.5);
  });

  it('should return null for no number', () => {
    assert.strictEqual(parseBengaliNumber('reset size'), null);
  });
});

describe('voice/liveAgentTools.ts — Bengali Parsing Integration', () => {
  let liveAgentToolsStr;

  beforeEach(async () => {
    const mod = await import('../voice/liveAgentTools.ts');
    liveAgentToolsStr = mod.handleLiveAgentTool.toString();
  });

  it('should have Bengali digit parsing in companionResize handler', () => {
    assert.ok(liveAgentToolsStr.includes('bengaliDigits') || liveAgentToolsStr.includes('০'), 
      'should have Bengali digit mapping');
    assert.ok(liveAgentToolsStr.includes('replaceAll'), 'should replace Bengali digits');
    assert.ok(liveAgentToolsStr.includes('match') && liveAgentToolsStr.includes('[0-9]*\\.?[0-9]+'), 
      'should extract number from string');
  });
});