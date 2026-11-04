import { assertEquals } from 'jsr:@std/assert@1';
import { inLang } from './translate.ts';

Deno.test('notices in English', () => {
  assertEquals(inLang('📋 Vas a cubrir a Ana Torres', 'en'), '📋 You’ll cover Ana Torres');
  assertEquals(inLang('📊 Resumen del día · mié 5 nov', 'en'), '📊 Daily summary · Wed, Nov 5');
  assertEquals(inLang('Alta · Dolor · salón 17 · pidió Ana Torres.', 'en'), 'High · Dolor · room 17 · requested by Ana Torres.');
  assertEquals(inLang('Salón 17 · Baño. Toca «Yo lo relevo» si puedes ir.', 'en'), 'Room 17 · Restroom. Tap “I’ll relieve” if you can go.');
});

Deno.test('Spanish stays, unknown text stays', () => {
  assertEquals(inLang('📋 Vas a cubrir a Ana Torres', 'es'), '📋 Vas a cubrir a Ana Torres');
  assertEquals(inLang('Hallway', 'en'), 'Hallway');
  assertEquals(inLang('', 'en'), '');
});
