/** The two languages of the app: what each person chose (profiles.language). */
export type Lang = 'es' | 'en';

export const langOf = (value: unknown): Lang => (value === 'en' ? 'en' : 'es');
