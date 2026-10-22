// A bounded 2.64s high/low alert, only in a visible CRM. Background sound belongs
// to the OS; a running AudioContext cannot prove the physical speaker is audible.
let audio: AudioContext | undefined;
let preparation:
  { context: AudioContext; promise: Promise<boolean>; userGesture: boolean } | undefined;
let reportedReady: boolean | undefined;
let playingUntil = 0;
const active = new Map<OscillatorNode, GainNode>();
const key = (userId: string) => `artisti-notification-sound:${userId}`;
const temporary = new Map<string, boolean>();

export function notificationSoundReady() {
  return audio?.state === 'running';
}

function publishSoundState() {
  const ready = notificationSoundReady();
  if (ready === reportedReady) return;
  reportedReady = ready;
  window.dispatchEvent(new Event('artisti-sound-state'));
}

export function stopNotificationSound() {
  for (const [oscillator, gain] of active) {
    oscillator.onended = null;
    try {
      oscillator.stop();
    } catch {
      /* A node may already have ended or not have started. */
    }
    oscillator.disconnect();
    gain.disconnect();
  }
  active.clear();
  playingUntil = 0;
}

async function within(promise: Promise<boolean>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function soundEnabled(userId: string) {
  if (temporary.has(userId)) return temporary.get(userId)!;
  try {
    return localStorage.getItem(key(userId)) !== 'off';
  } catch {
    return temporary.get(userId) ?? true;
  }
}

export async function prepareNotificationSound({
  timeoutMs = 800,
  userGesture = false,
}: { timeoutMs?: number; userGesture?: boolean } = {}) {
  try {
    if (document.hidden || timeoutMs <= 0) return false;
    const Audio =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Audio) return false;
    if (!audio || audio.state === 'closed') {
      stopNotificationSound();
      if (audio) audio.onstatechange = null;
      audio = new Audio();
      audio.onstatechange = () => {
        // Never replay the remainder of an old alert after an interruption.
        if (!notificationSoundReady()) stopNotificationSound();
        publishSoundState();
      };
    }
    const context = audio;
    publishSoundState();
    if (notificationSoundReady()) return true;
    if (
      !preparation ||
      preparation.context !== context ||
      (userGesture && !preparation.userGesture)
    ) {
      // Invoke resume synchronously inside a tap when available. Safari may leave
      // its promise pending until another gesture; bound it and allow a later retry.
      const resumed = context.resume().then(
        () => context === audio && context.state === 'running',
        () => false,
      );
      // A real gesture must be able to supersede a blocked automatic attempt.
      const attempt = { context, promise: within(resumed, 800), userGesture };
      preparation = attempt;
      void attempt.promise.finally(() => {
        if (preparation === attempt) preparation = undefined;
        publishSoundState();
      });
    }
    const ready = await within(preparation.promise, Math.min(timeoutMs, 800));
    return ready && context === audio && notificationSoundReady() && !document.hidden;
  } catch {
    publishSoundState();
    return false;
  }
}

export function setSoundEnabled(userId: string, enabled: boolean) {
  try {
    localStorage.setItem(key(userId), enabled ? 'on' : 'off');
    temporary.delete(userId);
  } catch {
    /* Private browsing may not allow persistence. */
    temporary.set(userId, enabled);
  }
  if (!enabled) stopNotificationSound();
  window.dispatchEvent(new Event('artisti-sound-preference'));
}

export function playNotificationSound() {
  if (document.hidden || !audio || audio.state !== 'running') return false;
  // Nearby messages still create individual pushes; overlapping sounds become
  // one short alert rather than an increasingly loud pile of oscillators.
  if (active.size && audio.currentTime < playingUntil) return true;
  stopNotificationSound();
  try {
    const start = audio.currentTime;
    for (let index = 0; index < 12; index++) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const at = start + index * 0.22;
      oscillator.type = 'square';
      oscillator.frequency.value = index % 2 === 0 ? 880 : 660;
      active.set(oscillator, gain);
      gain.gain.setValueAtTime(0, at);
      // Fixed headroom and no overlapping trains: do not stack gain on bursts.
      gain.gain.linearRampToValueAtTime(0.45, at + 0.01);
      gain.gain.setValueAtTime(0.45, at + 0.14);
      gain.gain.linearRampToValueAtTime(0, at + 0.21);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.onended = () => {
        active.delete(oscillator);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(at);
      oscillator.stop(at + 0.22);
    }
    playingUntil = start + 12 * 0.22;
    return true;
  } catch {
    stopNotificationSound();
    return false;
  }
}
