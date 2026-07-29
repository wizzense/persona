export const ANIMATION_CATALOG = {
  idle: 'idle.vrma',
  talk1: 'talk1.vrma',
  talk2: 'talk2.vrma',
  talk3: 'talk3.vrma',
  greeting: 'greeting.vrma',
  happy: 'happy.vrma',
  fingerGun: 'finger-gun.vrma',
  dance: 'dance.vrma',
} as const;

export type AnimationType =
  | 'IDLE'
  | 'GREETING'
  | 'TALK'
  | 'HAPPY'
  | 'FINGER_GUN'
  | 'DANCE';

export const ANIMATION_MAP: Record<AnimationType, readonly string[]> = {
  IDLE: [ANIMATION_CATALOG.idle],
  GREETING: [ANIMATION_CATALOG.greeting],
  TALK: [
    ANIMATION_CATALOG.talk1,
    ANIMATION_CATALOG.talk2,
    ANIMATION_CATALOG.talk3,
  ],
  HAPPY: [ANIMATION_CATALOG.happy],
  FINGER_GUN: [ANIMATION_CATALOG.fingerGun],
  DANCE: [ANIMATION_CATALOG.dance],
};

export function isFileAnimation(animation: string): boolean {
  return animation.startsWith('FILE:') && /^FILE:[\w.-]+\.vrma$/.test(animation);
}

export function parseFileAnimation(animation: string): string | null {
  if (!isFileAnimation(animation)) return null;
  return animation.slice(5);
}

export function randomAnimation(type: AnimationType): string {
  const choices = ANIMATION_MAP[type];
  return choices[Math.floor(Math.random() * choices.length)]!;
}

export function nextAnimation(
  type: AnimationType,
  previous: string | null = null,
): string {
  const choices = ANIMATION_MAP[type];
  const previousIndex = previous == null ? -1 : choices.indexOf(previous);
  return choices[(previousIndex + 1) % choices.length]!;
}
