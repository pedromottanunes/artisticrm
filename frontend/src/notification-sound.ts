// A short, distinct three-pulse alert. Web Audio requires a user gesture; this
// only runs in an open, visible CRM. Background push sound belongs to the OS.
let audio: AudioContext | undefined;
let lastPlayed = 0;
const key = (userId: string) => `artisti-notification-sound:${userId}`;
const temporary = new Map<string, boolean>();

export function soundEnabled(userId: string) {
  if (temporary.has(userId)) return temporary.get(userId)!;
  try {
    return localStorage.getItem(key(userId)) !== 'off';
  } catch {
    return temporary.get(userId) ?? true;
  }
}

export async function prepareNotificationSound() {
  try {
    const Audio =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Audio) return false;
    if (!audio || audio.state === 'closed') audio = new Audio();
    if (audio.state !== 'running') await audio.resume();
    return audio.state === 'running';
  } catch {
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
  window.dispatchEvent(new Event('artisti-sound-preference'));
}

export function playNotificationSound() {
  if (!audio || audio.state !== 'running') return false;
  // Nearby messages still create individual pushes; overlapping sounds become
  // one short alert rather than an increasingly loud pile of oscillators.
  if (Date.now() - lastPlayed < 1100) return true;
  try {
    const start = audio.currentTime;
    for (const [index, frequency] of [880, 1175, 880].entries()) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const at = start + index * 0.32;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.22, at + 0.015);
      gain.gain.setValueAtTime(0.22, at + 0.16);
      gain.gain.linearRampToValueAtTime(0, at + 0.25);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(at);
      oscillator.stop(at + 0.26);
    }
    lastPlayed = Date.now();
    return true;
  } catch {
    return false;
  }
}
