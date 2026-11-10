// Microsoft Teams: Adaptive Card accepted by Workflows ("Post to a channel when a webhook request
// is received") and by legacy Incoming Webhooks.

const TEAMS_HOST_SUFFIXES = ['.webhook.office.com', '.logic.azure.com', '.powerplatform.com', '.powerautomate.com'];

export function isTeamsUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && TEAMS_HOST_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

export const CATEGORIES: Record<string, string> = {
  enfermedad: 'Enfermedad',
  cita_medica: 'Cita médica',
  personal: 'Asunto personal',
  familiar: 'Emergencia familiar',
  oficial: 'Capacitación / oficial',
  otro: 'Otro',
  actividad: 'Actividad de la escuela',
};

export function fmtDateEs(date: string): string {
  const s = new Date(`${date}T12:00:00Z`).toLocaleDateString('es', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function fmtRangeEs(start: string, end: string): string {
  return start === end ? fmtDateEs(start) : `${fmtDateEs(start)} al ${fmtDateEs(end).toLowerCase()}`;
}

export function scheduleText(a: { partial: boolean; start_time: string | null; end_time: string | null }): string {
  if (!a.partial) return 'Día completo';
  const t = (v: string | null) => (v ? v.slice(0, 5) : '');
  return a.end_time ? `${t(a.start_time)} – ${t(a.end_time)}` : `Desde ${t(a.start_time)}`;
}

type Fact = { title: string; value: string | null | undefined | false };

export function buildCard({
  title,
  subtitle,
  facts = [],
  text,
  linkUrl,
  linkTitle = 'Abrir en Hallway',
}: {
  title: string;
  subtitle?: string;
  facts?: Fact[];
  text?: string;
  linkUrl?: string | null;
  linkTitle?: string;
}) {
  const body: Record<string, unknown>[] = [{ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true }];
  if (subtitle) body.push({ type: 'TextBlock', text: subtitle, isSubtle: true, spacing: 'None', wrap: true });
  const shown = facts.filter((f) => f.value).map((f) => ({ title: f.title, value: String(f.value) }));
  if (shown.length) body.push({ type: 'FactSet', facts: shown });
  if (text) body.push({ type: 'TextBlock', text, wrap: true });
  const content: Record<string, unknown> = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
  };
  if (linkUrl?.startsWith('https://')) content.actions = [{ type: 'Action.OpenUrl', title: linkTitle, url: linkUrl }];
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }],
  };
}

export async function postToTeams(url: string, card: unknown): Promise<void> {
  if (!isTeamsUrl(url)) throw new Error('URL de Teams no válida');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Teams respondió ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}
