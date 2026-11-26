import { describe, expect, it, vi } from 'vitest';

vi.mock('../shared/db/prisma.js', () => ({ prisma: {} }));

import { workflowOutput } from './checkPluggySecret.js';

describe('workflowOutput', () => {
  it('asks for the e-mail only when a new reminder was written, with the date and the stage', () => {
    expect(workflowOutput({ status: 'due', expiresOn: '2027-05-25', daysLeft: 30, stage: '30d', notified: 2 })).toBe(
      'status=due\nnotify=true\nexpires_on=2027-05-25\ndays_left=30\nstage=30d\n',
    );
    expect(workflowOutput({ status: 'due', expiresOn: '2027-05-25', daysLeft: 29, stage: '30d', notified: 0 })).toBe(
      'status=due\nnotify=false\nexpires_on=2027-05-25\ndays_left=29\nstage=30d\n',
    );
    expect(workflowOutput({ status: 'refused', expiresOn: '2027-05-25', daysLeft: 100, stage: 'refused', notified: 1 })).toContain(
      'notify=true',
    );
  });

  it('ok and not configured never ask for the e-mail', () => {
    expect(workflowOutput({ status: 'ok', expiresOn: '2027-05-25', daysLeft: 135, notified: 0 })).toBe(
      'status=ok\nnotify=false\nexpires_on=2027-05-25\ndays_left=135\n',
    );
    expect(workflowOutput({ status: 'not_configured', notified: 0 })).toBe('status=not_configured\nnotify=false\n');
  });
});
