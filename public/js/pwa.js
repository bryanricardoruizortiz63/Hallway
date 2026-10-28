import { savedAccounts } from './accounts.js';
import { deletePushSubscription, savePushSubscription } from './backend.js';
import { VAPID_PUBLIC_KEY } from './config.js';

let deferredInstall = null;
let swRegistration = null;

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    window.dispatchEvent(new CustomEvent('lah:installable'));
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
  });
  if ('serviceWorker' in navigator) {
    // sw.js always from the server: it says whether there is a new version of the app.
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        swRegistration = reg;
      })
      .catch((err) => console.warn('No se pudo registrar el service worker', err));
    keepUpToDate();
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'navigate' && e.data.url) {
        const hash = new URL(e.data.url, location.href).hash;
        // A notice of the other account on this phone: app.js switches to it first.
        if (e.data.uid) window.dispatchEvent(new CustomEvent('lah:open-notice', { detail: { link: hash, uid: e.data.uid } }));
        else if (hash) location.hash = hash;
      } else if (e.data?.type === 'push') {
        // { urgent, title, body, link }: urgent notices ring inside the app too (see alarm.js).
        window.dispatchEvent(new CustomEvent('lah:push', { detail: e.data }));
      }
    });
  }
}

// Something typed or chosen on screen that hasn't been saved.
const editing = () =>
  [...document.querySelectorAll('input, textarea, select')].some((el) => {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
    if (el.tagName === 'SELECT') {
      const initial = [...el.options].findIndex((o) => o.defaultSelected);
      return el.selectedIndex !== Math.max(initial, 0);
    }
    return el.value !== el.defaultValue;
  });

// The app opens from the copy installed on the phone (sw.js). An app left open (on an iPhone it usually just goes to
// the background) also looks for a new version when it comes back; once installed, the app reloads while it's out of
// sight, unless something is half written.
function keepUpToDate() {
  let updated = false;
  let checked = Date.now();
  // The first service worker ever doesn't bring a new version: the page already is the one it installed.
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    updated = controlled;
    controlled = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (updated && !editing()) location.reload();
    } else if (swRegistration && Date.now() - checked > 60000) {
      checked = Date.now();
      swRegistration.update().catch(() => {});
    }
  });
}

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const canPromptInstall = () => !!deferredInstall;

export async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  return outcome === 'accepted';
}

// ---- Push notifications ----------------------------------------------------

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration() {
  if (swRegistration) return swRegistration;
  // `ready` never settles when the service worker could not be registered (e.g. private browsing),
  // which would otherwise freeze sign-out.
  return Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(b64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

/** The accounts saved on this phone: their notices keep arriving here too (see accounts.js). */
const savedIds = () => savedAccounts().map((a) => a.id);

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function enablePush() {
  if (!pushSupported()) {
    throw new Error(
      isIos() && !isStandalone()
        ? 'En iPhone primero añade la app a tu pantalla de inicio y ábrela desde allí.'
        : 'Este navegador no admite notificaciones.',
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Permiso denegado. Actívalo en la configuración del navegador para este sitio.');
  }
  const reg = await registration();
  if (!reg) throw new Error('No se pudo activar el servicio de notificaciones. Recarga la app e inténtalo de nuevo.');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  await savePushSubscription(sub, savedIds());
  return sub;
}

export async function disablePush() {
  const sub = await currentPushSubscription();
  if (!sub) return;
  await deletePushSubscription(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/** Re-links this device's subscription to the signed-in user (e.g. after switching accounts). */
export async function syncPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const sub = await currentPushSubscription();
    if (sub) await savePushSubscription(sub, savedIds());
  } catch {
    /* best effort */
  }
}

/** Removes the server-side link so the next person using this phone doesn't get our notifications. */
export async function unlinkPush() {
  try {
    const sub = await currentPushSubscription();
    if (sub) await deletePushSubscription(sub.endpoint);
  } catch {
    /* best effort */
  }
}
