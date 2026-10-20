// In-app alarm for urgent notices (a student who didn't arrive, a parent at the door, a relief request) while
// the app is open: a full-screen notice with sound and vibration until the person looks at it or closes it.
// A web app can't ring like an alarm when the phone is silenced or the app is closed; the push notification
// (long vibration, stays on screen) covers that. The live board rings once (ringOnce) when something needs looking at.
import { html } from './lib.js';
import { icon } from './icons.js';

const RING_EVERY_MS = 2500;
const RING_FOR_MS = 60000;

let audio = null;
let overlay = null;
let timer = null;

/** Browsers only play sound after the person touched the page, so the first touch unlocks it. */
export function unlockAudio() {
  const unlock = () => {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      audio.resume?.();
    } catch {
      audio = null;
    }
  };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
}

function ring() {
  try {
    navigator.vibrate?.([500, 200, 500, 200, 900]);
  } catch {
    /* not supported */
  }
  if (!audio || audio.state !== 'running') return;
  const start = audio.currentTime;
  [0, 0.28, 0.56].forEach((offset, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = i === 2 ? 1175 : 880;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start(start + offset);
    osc.stop(start + offset + 0.24);
  });
}

/** Whether a sound can play now: the person already touched the page. */
export const soundReady = () => !!audio && audio.state === 'running';

/** One ring (sound and vibration), without the notice on screen: the live board's alerts. */
export function ringOnce() {
  ring();
}

function stop() {
  clearInterval(timer);
  timer = null;
  try {
    navigator.vibrate?.(0);
  } catch {
    /* not supported */
  }
  overlay?.remove();
  overlay = null;
}

/**
 * Shows the alarm (replacing one already on screen). onOpen runs when the person taps "Ver", onClose when
 * they close it; both after the alarm stops.
 */
export function showAlarm({ title, body, link }, { onOpen, onClose } = {}) {
  stop();
  // A turn for the service (Enfermería, Trabajo Social…): its own look, «Turno nuevo» and «Ver turno».
  const turn = /^#\/turns\/\d+$/.test(link || '');
  overlay = document.createElement('div');
  overlay.className = turn ? 'alarm alarm-turn' : 'alarm';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'alarm-title');
  overlay.innerHTML = String(html`
    <div class="alarm-card">
      <span class="alarm-icon">${icon(turn ? 'pulse' : 'alert', 34)}</span>
      ${turn ? html`<p class="alarm-kicker">${/^❓/.test(title || '') ? '¿Ya llegó?' : 'Turno nuevo'}</p>` : ''}
      <h2 id="alarm-title">${(turn ? (title || '').replace(/^(📋|❓)\s*/u, '') : title) || 'Aviso urgente'}</h2>
      ${body ? html`<p>${body}</p>` : ''}
      <button type="button" class="btn btn-primary btn-lg btn-block" data-alarm-open>${turn ? 'Ver turno' : 'Ver'}</button>
      <button type="button" class="btn btn-ghost btn-block" data-alarm-close>Cerrar</button>
    </div>`);
  document.body.append(overlay);
  overlay.querySelector('[data-alarm-open]').addEventListener('click', () => {
    stop();
    onOpen?.();
  });
  overlay.querySelector('[data-alarm-close]').addEventListener('click', () => {
    stop();
    onClose?.();
  });
  overlay.querySelector('[data-alarm-open]').focus();
  ring();
  const until = Date.now() + RING_FOR_MS;
  timer = setInterval(() => (Date.now() > until ? clearInterval(timer) : ring()), RING_EVERY_MS);
}

let blink = null;

/**
 * While the app is in the background (another tab, the phone's screen on another app), the tab's title blinks
 * with the notice, so a computer left on the service panel shows it from the taskbar. It stops on coming back.
 */
export function blinkTitle(text) {
  if (blink || document.visibilityState === 'visible') return;
  const original = document.title;
  let on = false;
  const timer = setInterval(() => {
    on = !on;
    document.title = on ? `🔔 ${text}` : original;
  }, 1000);
  const back = () => {
    if (document.visibilityState !== 'visible') return;
    clearInterval(timer);
    document.title = original;
    document.removeEventListener('visibilitychange', back);
    blink = null;
  };
  document.addEventListener('visibilitychange', back);
  blink = timer;
}
