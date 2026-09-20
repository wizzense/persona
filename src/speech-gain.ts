/** The ONE number the speak event carries for loudness, made safe to hand to a
 *  GainNode.
 *
 *  main.cjs resolves master x actor from cast.json and sends the product; this
 *  is the renderer's side of that boundary. It is a function, and a tested
 *  one, because of what happens when it is wrong: `gain.value = NaN` THROWS,
 *  playSpoken's fail-soft catch swallows it, and the avatar goes silent with
 *  no error anywhere -- a volume bug that reads as a dead voice service.
 *
 *  An ABSENT volume is full volume, never zero: an older main process that
 *  does not send the field yet must keep sounding exactly as it did. */
export const SPEECH_GAIN_MAX = 2;

export function speechGain(volume: unknown): number {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return 1;
  if (volume <= 0) return 0;
  return Math.min(volume, SPEECH_GAIN_MAX);
}
