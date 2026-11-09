// Emails from the platform itself (not from a school's account) through Resend: the secret RESEND_API_KEY.
const FROM = 'Hallway <notificaciones@hallwayedu.com>';

export async function sendPlatformEmail(to: string, subject: string, text: string): Promise<void> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('Falta RESEND_API_KEY');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 200), text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}
