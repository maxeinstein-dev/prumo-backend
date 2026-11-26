/**
 * Reminder of the Pluggy Client Secret (P25 L6). A secret lasts 180 days from when it was made
 * (https://docs.pluggy.ai/docs/authentication); once expired Pluggy refuses it and Open Finance stops.
 *
 * Run daily by the prumo-ops job. From 30 days before the end (again at 7 days and once expired), and whenever Pluggy
 * already refuses the keys, every member of the households with Open Finance gets ONE in-app notification per stage
 * (the bell of the site and of the Android app); the result tells the workflow to open its issue (the e-mail).
 *
 * PLUGGY_SECRET_CREATED_AT ('YYYY-MM-DD') is the day the secret was made: not a secret, set next to the keys.
 * The secret itself is only handed to the credential check; it never reaches a notification, a log or the result.
 */

export const SECRET_VALIDITY_DAYS = 180;

export type ReminderStage = '30d' | '7d' | 'expired' | 'refused';

export interface SecretCheckDb {
  openFinanceLink: {
    findMany(args: { distinct: ['householdId']; select: { householdId: true } }): Promise<Array<{ householdId: string }>>;
  };
  householdMember: {
    findMany(args: { where: { householdId: { in: string[] } }; select: { userId: true } }): Promise<Array<{ userId: string }>>;
  };
  notification: {
    findFirst(args: {
      where: { userId: string; metadata: { path: string[]; equals: string } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export type SecretCheckResult =
  | { status: 'not_configured'; notified: 0 }
  | { status: 'ok'; expiresOn: string; daysLeft: number; notified: 0 }
  | { status: 'due' | 'refused'; expiresOn: string; daysLeft: number; stage: ReminderStage; notified: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string): number | null {
  if (!YMD.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

function brDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

export function secretReminderStage(
  createdAt: string,
  today: string,
): { expiresOn: string; daysLeft: number; stage: Exclude<ReminderStage, 'refused'> | null } {
  const created = parseDay(createdAt);
  const now = parseDay(today);
  if (created === null || now === null) throw new Error('Invalid date');
  // Counted the safe way: on the 180th day after it was made the secret is treated as expired.
  const expires = created + SECRET_VALIDITY_DAYS * DAY_MS;
  const daysLeft = Math.round((expires - now) / DAY_MS);
  const stage = daysLeft <= 0 ? 'expired' : daysLeft <= 7 ? '7d' : daysLeft <= 30 ? '30d' : null;
  return { expiresOn: new Date(expires).toISOString().slice(0, 10), daysLeft, stage };
}

function messageFor(stage: ReminderStage, expiresOn: string, daysLeft: number): { title: string; message: string } {
  const steps =
    'Gere um novo Client Secret no painel da Pluggy (dashboard.pluggy.ai), troque PLUGGY_CLIENT_SECRET no Render e nos ' +
    'segredos do prumo-ops e atualize PLUGGY_SECRET_CREATED_AT com a data de hoje.';
  if (stage === 'refused') {
    return {
      title: 'A Pluggy recusou o segredo',
      message: `A Pluggy não aceitou as chaves do Open Finance (o segredo atual venceria em ${brDate(expiresOn)}). ${steps}`,
    };
  }
  if (stage === 'expired') {
    return {
      title: 'O segredo da Pluggy venceu',
      message: `O Client Secret do Open Finance venceu em ${brDate(expiresOn)} e a leitura dos bancos parou. ${steps}`,
    };
  }
  return {
    title: 'Renove o segredo da Pluggy',
    message: `O Client Secret do Open Finance vence em ${brDate(expiresOn)} (faltam ${daysLeft} dias). ${steps}`,
  };
}

export async function runPluggySecretCheck(options: {
  env: { PLUGGY_CLIENT_ID?: string; PLUGGY_CLIENT_SECRET?: string; PLUGGY_SECRET_CREATED_AT?: string };
  today: string;
  db: SecretCheckDb;
  checkCredentials: () => Promise<'ok' | 'refused'>;
}): Promise<SecretCheckResult> {
  const { env, today, db } = options;
  const hasKeys = !!env.PLUGGY_CLIENT_ID?.trim() && !!env.PLUGGY_CLIENT_SECRET?.trim();
  const createdAt = env.PLUGGY_SECRET_CREATED_AT?.trim() ?? '';
  if (!hasKeys && !createdAt) return { status: 'not_configured', notified: 0 };
  if (parseDay(createdAt) === null) {
    throw new Error("PLUGGY_SECRET_CREATED_AT is missing or not a 'YYYY-MM-DD' date: the secret reminder cannot run");
  }

  const { expiresOn, daysLeft, stage: dateStage } = secretReminderStage(createdAt, today);
  const credentials = hasKeys ? await options.checkCredentials() : 'refused';
  const stage: ReminderStage | null = credentials === 'refused' && dateStage !== 'expired' ? 'refused' : dateStage;
  if (!stage) return { status: 'ok', expiresOn, daysLeft, notified: 0 };

  const reminderKey = `pluggy-secret:${expiresOn}:${stage}`;
  const { title, message } = messageFor(stage, expiresOn, daysLeft);

  const households = (await db.openFinanceLink.findMany({ distinct: ['householdId'], select: { householdId: true } })).map(
    (row) => row.householdId,
  );
  let notified = 0;
  if (households.length > 0) {
    const members = await db.householdMember.findMany({ where: { householdId: { in: households } }, select: { userId: true } });
    for (const userId of [...new Set(members.map((row) => row.userId))]) {
      const existing = await db.notification.findFirst({
        where: { userId, metadata: { path: ['reminderKey'], equals: reminderKey } },
        select: { id: true },
      });
      if (existing) continue;
      await db.notification.create({
        data: {
          userId,
          type: 'SYSTEM_ALERT',
          status: 'UNREAD',
          title,
          message,
          metadata: { kind: 'pluggy-secret', reminderKey, expiresOn },
        },
      });
      notified++;
    }
  }

  return { status: stage === 'refused' ? 'refused' : 'due', expiresOn, daysLeft, stage, notified };
}
