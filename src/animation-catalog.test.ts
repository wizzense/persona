import { describe, expect, it, vi } from 'vitest';
import {
  ANIMATION_CATALOG,
  ANIMATION_MAP,
  nextAnimation,
  randomAnimation,
  isFileAnimation,
  parseFileAnimation,
} from './animation-catalog';

describe('Persona animation contract', () => {
  it('uses every stable replacement slot exactly once in the catalog', () => {
    expect(Object.values(ANIMATION_CATALOG).sort()).toEqual([
      'dance.vrma',
      'finger-gun.vrma',
      'greeting.vrma',
      'happy.vrma',
      'idle.vrma',
      'talk1.vrma',
      'talk2.vrma',
      'talk3.vrma',
    ]);
    expect(ANIMATION_MAP.IDLE).toEqual(['idle.vrma']);
    expect(ANIMATION_MAP.TALK).toHaveLength(3);
    expect(ANIMATION_MAP.HAPPY).toEqual(['happy.vrma']);
    expect(ANIMATION_MAP.FINGER_GUN).toEqual(['finger-gun.vrma']);
    expect(ANIMATION_MAP.DANCE).toEqual(['dance.vrma']);
  });

  it('can select the last talking clip without escaping that category', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(randomAnimation('TALK')).toBe('talk3.vrma');
    vi.restoreAllMocks();
  });

  it('cycles through every talking clip without consecutive repeats', () => {
    const first = nextAnimation('TALK');
    const second = nextAnimation('TALK', first);
    const third = nextAnimation('TALK', second);
    const wrapped = nextAnimation('TALK', third);

    expect([first, second, third]).toEqual([
      'talk1.vrma',
      'talk2.vrma',
      'talk3.vrma',
    ]);
    expect(wrapped).toBe(first);
  });

  describe('FILE: animations', () => {
    it('recognizes valid FILE: animation patterns', () => {
      expect(isFileAnimation('FILE:custom-anim.vrma')).toBe(true);
      expect(isFileAnimation('FILE:anim_01.vrma')).toBe(true);
      expect(isFileAnimation('FILE:test.vrma')).toBe(true);
    });

    it('rejects invalid FILE: patterns', () => {
      expect(isFileAnimation('FILE:../x.vrma')).toBe(false);
      expect(isFileAnimation('FILE:/etc/passwd')).toBe(false);
      expect(isFileAnimation('FILE:anim.txt')).toBe(false);
      expect(isFileAnimation('IDLE')).toBe(false);
      expect(isFileAnimation('FILE:')).toBe(false);
    });

    it('parses FILE: animation filenames', () => {
      expect(parseFileAnimation('FILE:custom-anim.vrma')).toBe('custom-anim.vrma');
      expect(parseFileAnimation('FILE:test_01.vrma')).toBe('test_01.vrma');
      expect(parseFileAnimation('IDLE')).toBeNull();
      expect(parseFileAnimation('FILE:../x.vrma')).toBeNull();
    });
  });
});
