import { createSign, randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const org = 'TigerAppsOrg';
const sender = 'it.admin@princetonusg.com';

export function githubHandle(value) {
  const handle = (value || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^@/, '').replace(/\/$/, '');
  return handle && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(handle) ? handle : null;
}

export class Github {
  constructor(config) { this.config = config; }

  async token() {
    const now = Math.floor(Date.now() / 1000);
    const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: this.config.githubAppId })}`;
    const signature = createSign('RSA-SHA256').update(message).sign(this.config.githubPrivateKey).toString('base64url');
    const response = await fetch(`https://api.github.com/app/installations/${this.config.githubInstallationId}/access_tokens`, {
      method: 'POST', headers: { Authorization: `Bearer ${message}.${signature}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    });
    if (!response.ok) throw new Error(`GitHub App authorization failed (${response.status})`);
    return (await response.json()).token;
  }

  async request(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${await this.token()}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json',
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response.status === 204 ? {} : response.json();
  }

  async membership(handle) {
    return this.request(`/orgs/${org}/memberships/${encodeURIComponent(handle)}`);
  }

  async invite(row) {
    const handle = githubHandle(row.github);
    let body;
    if (handle) {
      const member = await this.membership(handle);
      if (member?.state === 'active') return 'Already an organization member.';
      if (member?.state === 'pending') return 'An organization invitation is already pending.';
      const user = await this.request(`/users/${encodeURIComponent(handle)}`);
      if (!user?.id) throw new Error('The roster GitHub username was not found.');
      body = { invitee_id: user.id, role: 'direct_member' };
    } else {
      const pending = await this.request(`/orgs/${org}/invitations?per_page=100`);
      if (pending?.some(invite => invite.email?.toLowerCase() === row.email)) return 'An organization invitation is already pending.';
      body = { email: row.email, role: 'direct_member' };
    }
    await this.request(`/orgs/${org}/invitations`, { method: 'POST', body: JSON.stringify(body) });
    return 'Invitation sent; membership is pending acceptance.';
  }

  async remove(row) {
    const handle = githubHandle(row?.github);
    if (!handle) return 'No reliable GitHub username in the roster; Board must check GitHub manually.';
    const member = await this.membership(handle);
    if (!member) return 'No GitHub organization membership found.';
    if (member.role === 'admin') return 'GitHub organization owner; server owner must handle this manually.';
    await this.request(`/orgs/${org}/memberships/${encodeURIComponent(handle)}`, { method: 'DELETE' });
    return 'GitHub organization membership removed.';
  }
}

export function announcementRecipients(rows, team) {
  return [...new Set(rows.filter(row => !team || row.team.split(',').map(name => name.trim()).includes(team))
    .map(row => row.email).filter(email => /^[^\s@]+@princeton\.edu$/.test(email)))].sort();
}

export function mailMessage({ subject, body, to, cc, bcc = [], discordUrl }) {
  const address = value => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Invalid email address.');
    return value;
  };
  const safeSubject = subject.replace(/[\r\n]/g, ' ').trim();
  if (!safeSubject) throw new Error('Announcement needs a subject.');
  if (discordUrl && !/^https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}\/\d{17,20}$/.test(discordUrl)) throw new Error('Invalid Discord announcement link.');
  const subjectWords = [];
  let chunk = '', bytes = 0;
  for (const character of safeSubject) {
    const size = Buffer.byteLength(character);
    // 39 bytes keeps even the first Subject line within RFC 2047's 76-character limit.
    if (bytes + size > 39) { subjectWords.push(chunk); chunk = ''; bytes = 0; }
    chunk += character;
    bytes += size;
  }
  subjectWords.push(chunk);
  const encodedSubject = subjectWords.map(word => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
  const boundary = `tigerapps-${randomUUID()}`;
  const escape = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const html = `<!doctype html><html><body style="margin:0;background:#f5f3ef;font-family:Arial,sans-serif;color:#1d2633">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #e8e2d8;border-radius:12px"><tr><td style="padding:32px">
    <div style="color:#b45f12;font-size:12px;font-weight:bold;letter-spacing:2px">TIGERAPPS</div>
    <h1 style="margin:18px 0 20px;font-size:26px;line-height:1.25">${escape(safeSubject)}</h1>
    <div style="font-size:16px;line-height:1.65">${escape(body).replace(/\r?\n/g, '<br>')}</div>
    ${discordUrl ? `<p style="margin:32px 0"><a href="${discordUrl}" style="display:inline-block;padding:12px 18px;background:#1d2633;border-radius:7px;color:#fff;text-decoration:none;font-weight:bold">Open in Discord</a></p>` : '<p style="margin:32px 0 0"></p>'}
    <p style="margin:0;font-size:12px;line-height:1.5;color:#68717b">Sent via the TigerApps Discord bot.</p>
  </td></tr></table>
</td></tr></table></body></html>`;
  const plain = `${body}${discordUrl ? `\n\nOpen in Discord: ${discordUrl}` : ''}\n\nSent via the TigerApps Discord bot.`;
  const headers = [
    `From: TigerApps <${sender}>`, `To: ${address(to)}`,
    ...(cc ? [`Cc: ${address(cc)}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.map(address).join(',\r\n ')}`] : []),
    `Reply-To: ${address(to)}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, content) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(content).toString('base64').match(/.{1,76}/g).join('\r\n')}\r\n`;
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${part('text/plain', plain)}${part('text/html', html)}--${boundary}--\r\n`).toString('base64url');
}

export class Mailer {
  constructor(config) {
    this.auth = new OAuth2Client(config.gmailClientId, config.gmailClientSecret);
    this.auth.setCredentials({ refresh_token: config.gmailRefreshToken });
  }

  async send(message) {
    const { token } = await this.auth.getAccessToken();
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: mailMessage(message) }),
    });
    if (!response.ok) throw new Error(`Gmail send outcome needs review (${response.status})`);
    return (await response.json()).id;
  }
}

export const mailSender = sender;

export const timeZone = 'America/New_York';
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = value => String(value).padStart(2, '0');

const offsetMinutes = instant => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(instant)).find(part => part.type === 'timeZoneName').value;
  const [, sign, hours, minutes] = name.match(/([+-])(\d{2}):(\d{2})/) || [null, '+', '0', '0'];
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
};

// wall-clock Eastern time to an exact instant, the second pass settles which side of a DST change it is on
export function easternInstant(date, time) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const first = wall - offsetMinutes(wall) * 60_000;
  return new Date(wall - offsetMinutes(first) * 60_000);
}

export function parseWhen(dateText, timeText, now = new Date()) {
  const text = dateText.trim().toLowerCase().replace(/^(mon|tues?|wed|thu|thurs?|fri|sat|sun)(day|nesday|rsday|urday)?\.?,?\s+/, '').replace(/(\d)(st|nd|rd|th)\b/, '$1');
  let year, month, day, match;
  if ((match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [year, month, day] = match.slice(1).map(Number);
  else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) {
    [month, day] = [Number(match[1]), Number(match[2])];
    if (match[3]) year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  } else if ((match = text.match(/^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/)) &&
      (month = months.findIndex(name => [name, name.slice(0, 3), name.slice(0, 4)].includes(match[1])) + 1)) {
    day = Number(match[2]);
    if (match[3]) year = Number(match[3]);
  } else throw new Error('Use a date like Oct 8 or 10/8.');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  if (!year) {
    year = Number(today.slice(0, 4));
    if (`${year}-${pad(month)}-${pad(day)}` < today) year++;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error('That date does not exist.');
  const date = `${year}-${pad(month)}-${pad(day)}`;

  match = timeText.toLowerCase().replace(/\s+/g, '').replace(/[–—]|to/g, '-')
    .match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?(?:-(\d{1,2})(?::(\d{2}))?(am|pm)?)?$/);
  if (!match) throw new Error('Use a time like 6:45-7:15pm.');
  const minutes = (hour, minute = '0', half) => {
    hour = Number(hour);
    if (Number(minute) > 59 || hour > 23 || (half && (hour < 1 || hour > 12))) throw new Error('Use a time like 6:45-7:15pm.');
    if (!half && hour >= 1 && hour <= 12) throw new Error('Add am or pm to the time.');
    return (half ? hour % 12 + (half === 'pm' ? 12 : 0) : hour) * 60 + Number(minute);
  };
  let start = minutes(match[1], match[2], match[3] || match[6]);
  let end = match[4] ? minutes(match[4], match[5], match[6] || match[3]) : start + 60;
  // 11-1pm means 11am to 1pm
  if (!match[3] && match[6] && start >= end) start -= 12 * 60;
  if (start < 0 || end <= start || end >= 24 * 60) throw new Error('The event needs to end after it starts, on the same day.');
  const clock = value => `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
  const when = { date, start: clock(start), end: clock(end) };
  const wallTime = time => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(easternInstant(date, time));
  if (wallTime(when.start) !== when.start || wallTime(when.end) !== when.end) throw new Error('That time is skipped by the daylight saving change.');
  if (easternInstant(date, when.start) <= now) throw new Error('That time has already passed.');
  return when;
}

// recurring events stop at the end of the semester they start in
export function semesterEnd(date) {
  return `${date.slice(0, 4)}-${Number(date.slice(5, 7)) >= 6 ? '12-20' : '05-31'}`;
}

export function calendarEvent({ title, location, date, start, end, repeat }) {
  return {
    summary: title, location,
    start: { dateTime: `${date}T${start}:00`, timeZone },
    end: { dateTime: `${date}T${end}:00`, timeZone },
    ...(repeat ? { recurrence: [`RRULE:FREQ=WEEKLY;INTERVAL=${repeat};UNTIL=${easternInstant(semesterEnd(date), '23:59').toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`] } : {}),
  };
}

export class Calendar {
  constructor(config) {
    this.id = config.calendarId;
    this.auth = new OAuth2Client(config.gmailClientId, config.gmailClientSecret);
    this.auth.setCredentials({ refresh_token: config.gmailRefreshToken });
  }

  async request(path, options = {}) {
    const { token } = await this.auth.getAccessToken();
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.id)}${path}`, {
      ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null))?.error?.message;
      throw new Error(`Calendar request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return response.status === 204 ? {} : response.json();
  }

  create(event) {
    return this.request('/events', { method: 'POST', body: JSON.stringify(event) });
  }

  // the bot owns every Princeton address on this calendar and leaves other sharing alone
  async share(readers, writers) {
    const desired = new Map([...readers.map(email => [email, 'reader']), ...writers.map(email => [email, 'writer'])]);
    // one page of 250 sharing rules covers the club
    const current = ((await this.request('/acl?maxResults=250')).items || [])
      .filter(rule => rule.scope?.type === 'user' && /@princeton\.edu$/.test(rule.scope.value));
    const changes = { added: 0, changed: 0, removed: 0 };
    for (const rule of current.filter(rule => !desired.has(rule.scope.value))) {
      await this.request(`/acl/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
      changes.removed++;
    }
    for (const [email, role] of desired) {
      const rule = current.find(rule => rule.scope.value === email);
      if (rule?.role === role) continue;
      await this.request(rule ? `/acl/${encodeURIComponent(rule.id)}` : '/acl?sendNotifications=true', {
        method: rule ? 'PUT' : 'POST', body: JSON.stringify({ role, scope: { type: 'user', value: email } }),
      });
      changes[rule ? 'changed' : 'added']++;
    }
    return changes;
  }
}
