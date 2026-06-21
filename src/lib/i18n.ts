export type AppLanguage = 'en' | 'fr';

const fr: Record<string, string> = {
  'GAME SESSION': 'SESSION DE JEU',
  'CREDIT PAYMENT': 'PAIEMENT DE CRÉDIT',
  'CREDIT ADDED': 'CRÉDIT AJOUTÉ',
  'SCAN PAYMENT': 'PAIEMENT SCANNÉ',
  'Tournament Registration': 'Inscription au tournoi',
  'Registration Accepted': 'Inscription acceptée',
  'Registration Rejected': 'Inscription refusée',
  'Tournament Started': 'Tournoi démarré',
  'Tournament Completed': 'Tournoi terminé',
  'Match Scheduled': 'Match programmé',
  'Match Confirmed': 'Match confirmé',
  'Match Updated': 'Match mis à jour',
  'Match Completed': 'Match terminé',
  'New Message': 'Nouveau message',
  'New Match Message': 'Nouveau message de match',
  'Schedule Proposal': 'Proposition de planning',
  'Schedule Confirmed': 'Planning confirmé',
  'Player Replaced': 'Joueur remplacé',
  'You have been added to a tournament.': 'Vous avez été ajouté à un tournoi.',
  'Your tournament registration was accepted.': 'Votre inscription au tournoi a été acceptée.',
  'Your tournament registration was rejected.': 'Votre inscription au tournoi a été refusée.',
  'Your match has been scheduled.': 'Votre match a été programmé.',
  'Your match time has been confirmed.': 'L’horaire de votre match a été confirmé.',
  'Your match has been completed.': 'Votre match est terminé.',
  'You received a new match message.': 'Vous avez reçu un nouveau message de match.',
  'A new time slot was proposed for your match.': 'Un nouveau créneau a été proposé pour votre match.',
  'Your tournament has started.': 'Votre tournoi a commencé.',
  'Your tournament has completed.': 'Votre tournoi est terminé.',
};

const phrasePatterns: Array<[RegExp, string]> = [
  [/^Your registration for (.+) has been accepted\.$/, 'Votre inscription à $1 a été acceptée.'],
  [/^Your registration for (.+) has been rejected\.$/, 'Votre inscription à $1 a été refusée.'],
  [/^(.+) has registered for (.+)\.$/, '$1 s’est inscrit à $2.'],
  [/^You have been added to (.+)\.$/, 'Vous avez été ajouté à $1.'],
  [/^You have been replaced in (.+)\.$/, 'Vous avez été remplacé dans $1.'],
  [/^Your match against (.+) has been scheduled for (.+)\.$/, 'Votre match contre $1 est programmé pour $2.'],
  [/^(.+) sent a message in your match\.$/, '$1 a envoyé un message dans votre match.'],
  [/^(.+) proposed a time slot for your match\.$/, '$1 a proposé un créneau pour votre match.'],
];

export function normalizeLanguage(value: unknown): AppLanguage {
  return value === 'fr' ? 'fr' : 'en';
}

export function translateText(text: string, language: AppLanguage): string {
  if (language === 'en') return text;
  if (fr[text]) return fr[text];

  for (const [pattern, replacement] of phrasePatterns) {
    if (pattern.test(text)) {
      return text.replace(pattern, replacement);
    }
  }

  return text;
}

export function formatNotificationDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hour}:${minute}`;
}
