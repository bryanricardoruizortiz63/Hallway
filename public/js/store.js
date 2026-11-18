import { afterSignOut } from './accounts.js';
import { signOut, unreadByTab, unreadCount } from './backend.js';
import { isStaff, reportsOwn } from './lib.js';
import { navItems } from './nav.js';
import { unlinkPush } from './pwa.js';

export const state = {
  me: null, // { user, school }
  /** The platform panel's session token: only in memory, so a reload means signing in again. */
  platformSession: null,
  nextPath: null,
  unread: 0,
  tabCounts: null, // unread notices per tab (setTabCounts)
  needsCode: false, // two or more accounts on this phone and today's authenticator code not given yet
};

export function go(path, { replace = false } = {}) {
  const hash = `#${path}`;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function homePath() {
  const user = state.me?.user;
  if (!user) return state.platformSession ? '/platform' : '/login';
  if (isStaff(user)) return '/dashboard';
  // A role that doesn't report its own absences starts on its first tab.
  return reportsOwn(user) ? '/home' : navItems(user)[0].path;
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

/**
 * The count on each tab of the bottom bar: its unread notices (Alertas, Turnos, Ausencias…), so what needs attention
 * stands out. The tab of Ausencias is /dashboard or /home depending on the person.
 */
export function setTabCounts(counts) {
  state.tabCounts = counts;
  for (const el of document.querySelectorAll('[data-tab-count]')) {
    const path = el.dataset.tabCount;
    const n = (path === '/dashboard' || path === '/home' ? counts?.absences : counts?.[path]) || 0;
    el.hidden = !n;
    el.textContent = n > 99 ? '99+' : String(n);
  }
}

/** False when it couldn't ask (the caller may wait longer before trying again). */
export async function refreshUnread() {
  if (!state.me || state.me.user.must_change_password) return true;
  try {
    const [n, byTab] = await Promise.all([unreadCount(), unreadByTab().catch(() => null)]);
    setUnread(n);
    if (byTab) setTabCounts(byTab);
    return true;
  } catch {
    return false;
  }
}

export async function logout() {
  const id = state.me?.user.id;
  await unlinkPush();
  // Clear state first so the SIGNED_OUT event isn't treated as an expired session.
  state.me = null;
  state.platformSession = null;
  await signOut();
  // Another account saved on this phone opens instead (the page reloads).
  if (id && (await afterSignOut(id))) return;
  setUnread(0);
  document.getElementById('toasts')?.replaceChildren();
  go('/login', { replace: true });
}
