import { createSign } from 'node:crypto';
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

export function mailMessage({ subject, body, to, cc, bcc }) {
  const address = value => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Invalid email address.');
    return value;
  };
  const safeSubject = subject.replace(/[\r\n]/g, ' ').trim();
  if (!safeSubject || !bcc.length) throw new Error('Announcement needs a subject and recipients.');
  const headers = [
    `From: TigerApps <${sender}>`, `To: ${address(to)}`,
    ...(cc ? [`Cc: ${address(cc)}`] : []),
    `Bcc: ${bcc.map(address).join(',\r\n ')}`,
    `Reply-To: ${address(to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(safeSubject).toString('base64')}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`).toString('base64url');
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
