import { signOut, unreadCount } from './backend.js';
import { isStaff } from './lib.js';
import { unlinkPush } from './pwa.js';

export const state = {
  me: null, // { user, school }
  platformPassword: null,
  nextPath: null,
  unread: 0,
};

export function go(path, { replace = false } = {}) {
  const hash = `#${path}`;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function homePath() {
  const user = state.me?.user;
  if (!user) return state.platformPassword ? '/platform' : '/login';
  return isStaff(user) ? '/dashboard' : '/home';
}

export function setUnread(n) {
  state.unread = n;
  for (const el of document.querySelectorAll('[data-unread]')) {
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : String(n);
  }
  if ('setAppBadge' in navigator) {
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
}

/** False when it couldn't ask (the caller may wait longer before trying again). */
export async function refreshUnread() {
  if (!state.me || state.me.user.must_change_password) return true;
  try {
    setUnread(await unreadCount());
    return true;
  } catch {
    return false;
  }
}

export async function logout() {
  await unlinkPush();
  // Clear state first so the SIGNED_OUT event isn't treated as an expired session.
  state.me = null;
  state.platformPassword = null;
  await signOut();
  setUnread(0);
  document.getElementById('toasts')?.replaceChildren();
  go('/login', { replace: true });
}
