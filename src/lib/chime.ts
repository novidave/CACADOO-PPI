/**
 * The Cacaduu sound: three rising notes. The QR terminal plays it when a sale is paid (database update 68), and
 * Asistent → Objednávky plays it when a new food order comes (update 74). It uses Web Audio, with no file and no
 * library, and is skipped quietly where the device has no sound. `ctx` is a context the page already unlocked with a
 * tap (browsers allow sound only after one); without it a new context is made and closed again. A phone also
 * vibrates briefly.
 */
export function chime(ctx?: AudioContext | null) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const audio = ctx ?? (Ctx ? new Ctx() : null);
    if (audio) {
      [[784, 0], [1047, 0.13], [1319, 0.26]].forEach(([f, at]) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        const t = audio.currentTime + at;
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        o.connect(g).connect(audio.destination);
        o.start(t);
        o.stop(t + 0.45);
      });
      if (!ctx) window.setTimeout(() => void audio.close(), 1000);
    }
  } catch {}
  try {
    navigator.vibrate?.([60, 40, 60]);
  } catch {}
}
