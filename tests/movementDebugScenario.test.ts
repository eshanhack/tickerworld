import { describe, expect, it } from 'vitest';
import {
  runMovementDebugScenarioScript,
  type MovementDebugScenarioControls,
} from '../src/Game';
import type { FoxMotionDebugSnapshot } from '../src/player/FoxPlayer';
import { movementDebugSnapshotText } from '../src/ui/MovementDebugPanel';

interface ScheduledAction {
  readonly delay: number;
  readonly action: () => void;
}

function scenarioHarness(prepare = true) {
  let inputReady = false;
  let jumps = 0;
  let drops = 0;
  const calls: string[] = [];
  const scheduled: ScheduledAction[] = [];
  const controls: MovementDebugScenarioControls = {
    prepareInput: () => {
      calls.push('prepare');
      inputReady = prepare;
      return prepare;
    },
    setVirtualInput: (x, forward, sprint = false) => {
      calls.push(`move:${x}:${forward}:${sprint}`);
    },
    setGlideHeld: (held) => {
      calls.push(`glide:${held}`);
    },
    // Mirrors PlayerInputController.requestJump: a disabled path drops the edge.
    requestJump: () => {
      calls.push('jump');
      if (inputReady) jumps += 1;
    },
    schedule: (delay, action) => scheduled.push({ delay, action }),
    heavyDrop: () => { drops += 1; },
  };
  return {
    controls,
    calls,
    scheduled,
    jumps: () => jumps,
    drops: () => drops,
  };
}

describe('movement debug scenario integration', () => {
  it('restores the live input path before emitting short/full-chain jump edges', () => {
    const short = scenarioHarness();
    expect(runMovementDebugScenarioScript('short', short.controls)).toBe(true);
    expect(short.calls.slice(0, 3)).toEqual([
      'prepare',
      'move:0:0:false',
      'glide:false',
    ]);
    expect(short.jumps()).toBe(0);
    expect(short.scheduled.map(({ delay }) => delay)).toEqual([0, 48]);
    short.scheduled[0]!.action();
    expect(short.jumps()).toBe(1);

    const chain = scenarioHarness();
    expect(runMovementDebugScenarioScript('chain', chain.controls)).toBe(true);
    expect(chain.jumps()).toBe(0);
    expect(chain.scheduled.map(({ delay }) => delay)).toEqual([0, 1_350, 1_800]);
    chain.scheduled[0]!.action();
    expect(chain.jumps()).toBe(2);
  });

  it('keeps modal/context gating authoritative and emits no partial scenario', () => {
    const blocked = scenarioHarness(false);
    expect(runMovementDebugScenarioScript('chain', blocked.controls)).toBe(false);
    expect(blocked.calls).toEqual(['prepare']);
    expect(blocked.scheduled).toHaveLength(0);
    expect(blocked.jumps()).toBe(0);
    expect(blocked.drops()).toBe(0);
  });

  it('formats the movement lab readout without encoding-sensitive glyphs', () => {
    const text = movementDebugSnapshotText({
      locomotionState: 'jump-rise',
      fixedSteps: 2,
      interpolationAlpha: 0.5,
      horizontalSpeed: 4.25,
      verticalVelocity: 6.5,
      airtime: 0.15,
      coyoteRemaining: 0.1,
      jumpBufferRemaining: 0.08,
      jumpsUsed: 1,
      glideBank: -0.2,
      inputEnabled: true,
      jumpHeld: false,
      jumpEdgeQueued: false,
      jumpRequestSequence: 1,
      inputClearSequence: 0,
      jumpSequence: 1,
      doubleJumpSequence: 0,
      bufferedDoubleSequence: 0,
      delayedDoubleSequence: 0,
      glideSequence: 0,
      maxAirtimeObserved: 0.15,
      stateTransitionSequence: 2,
      activeParticles: 3,
      activeRings: 1,
      activeTrailSegments: 0,
    } as FoxMotionDebugSnapshot);

    expect(text).toContain('jump-rise | 2 fixed steps | alpha 0.50');
    expect(text).not.toMatch(/[ÂÎâ]/u);
  });
});
