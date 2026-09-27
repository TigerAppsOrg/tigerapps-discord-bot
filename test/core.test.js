import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateServerConfig } from '../src/config.js';
import { createBot } from '../src/bot.js';
import { Github, announcementRecipients, githubHandle, mailMessage } from '../src/integrations.js';
import { verifiedPrincetonEmail } from '../src/oauth.js';
import { Roster, parseRoster, rosterFunctions, rosterTeams } from '../src/roster.js';
import { State } from '../src/state.js';

const header = ['Name', 'Team', 'Role', 'Year', 'Phone', 'GitHub', 'Website', 'Email'];

test('Clean roster requires its exact schema and unique email identities', () => {
  const rows = parseRoster([header, ['A', 'TigerOps, The Forum', 'SWE, Designer', '2028', '', 'a', '', 'A@princeton.edu']]);
  assert.equal(rows[0].email, 'a@princeton.edu');
  assert.deepEqual(rosterTeams(rows[0], ['TigerOps', 'The Forum']), ['TigerOps', 'The Forum']);
  assert.deepEqual(rosterFunctions(rows[0], ['Engineering', 'Design']), ['Engineering', 'Design']);
  assert.throws(() => parseRoster([header, ['A', '', '', '', '', '', '', 'a@princeton.edu'], ['B', '', '', '', '', '', '', 'A@princeton.edu']]), /duplicate/);
  assert.throws(() => parseRoster([['Wrong', ...header.slice(1)]]), /columns have changed/);
});

test('Google sign-in requires the verified Princeton hosted domain and stable account ID', () => {
  const valid = { sub: 'google-account-id', email: 'A@princeton.edu', email_verified: true, hd: 'princeton.edu' };
  assert.equal(verifiedPrincetonEmail(valid), 'a@princeton.edu');
  assert.throws(() => verifiedPrincetonEmail({ ...valid, hd: 'gmail.com' }), /Princeton/);
  assert.throws(() => verifiedPrincetonEmail({ ...valid, email_verified: false }), /Princeton/);
  assert.throws(() => verifiedPrincetonEmail({ ...valid, sub: '' }), /Princeton/);
});

test('one Princeton account links to one Discord account across reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tigerapps-state-'));
  try {
    const file = join(dir, 'state.json');
    const state = new State(file);
    state.link('google-1', 'a@princeton.edu', 'discord-1');
    assert.equal(new State(file).linkedByDiscord('discord-1').email, 'a@princeton.edu');
    assert.throws(() => state.link('google-1', 'a@princeton.edu', 'discord-2'), /already linked/);
    assert.throws(() => state.link('google-2', 'b@princeton.edu', 'discord-1'), /already linked/);
    assert.throws(() => state.link('google-2', 'a@princeton.edu', 'discord-2'), /already linked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mail hides recipients and rejects header injection', () => {
  const raw = Buffer.from(mailMessage({ subject: 'All hands', body: 'Hello', to: 'lead@princeton.edu',
    cc: 'it.admin@princetonusg.com', bcc: ['a@princeton.edu', 'b@princeton.edu'] }), 'base64url').toString();
  assert.match(raw, /Cc: it\.admin@princetonusg\.com/);
  assert.match(raw, /Bcc: a@princeton\.edu,\r\n b@princeton\.edu/);
  const many = Buffer.from(mailMessage({ subject: 'All hands', body: 'Hello', to: 'lead@princeton.edu',
    bcc: Array.from({ length: 60 }, (_, i) => `member${i}@princeton.edu`) }), 'base64url').toString();
  assert.ok(many.split('\r\n\r\n')[0].split('\r\n').every(line => Buffer.byteLength(line) <= 998));
  assert.throws(() => mailMessage({ subject: 'News', body: 'x', to: 'bad@example.com\r\nBcc: attacker@example.com', bcc: ['a@princeton.edu'] }), /Invalid email/);
  assert.deepEqual(announcementRecipients([{ team: 'TigerOps, The Forum', email: 'a@princeton.edu' }, { team: 'The Forum', email: 'b@princeton.edu' }], 'TigerOps'), ['a@princeton.edu']);
});

test('GitHub removal cannot remove an organization owner', async () => {
  assert.equal(githubHandle('https://github.com/Test-User/'), 'Test-User');
  assert.equal(githubHandle('not/a/handle'), null);
  const github = new Github({});
  github.membership = async () => ({ state: 'active', role: 'admin' });
  github.request = async () => { throw new Error('unexpected delete'); };
  assert.match(await github.remove({ github: 'Test-User' }), /owner/);
});

test('GitHub invitations request direct-member access only', async () => {
  const github = new Github({});
  let invitation;
  github.membership = async () => null;
  github.request = async (path, options) => {
    if (path === '/users/Test-User') return { id: 42 };
    if (path === '/orgs/TigerAppsOrg/invitations') { invitation = JSON.parse(options.body); return { id: 9 }; }
    throw new Error(`Unexpected path ${path}`);
  };
  assert.match(await github.invite({ github: 'Test-User', email: 'a@princeton.edu' }), /pending/);
  assert.deepEqual(invitation, { invitee_id: 42, role: 'direct_member' });
});

test('Status Review update checks the email and column before writing', async () => {
  const roster = Object.create(Roster.prototype);
  let updated = false;
  roster.request = async (path, options) => {
    const decoded = decodeURIComponent(path);
    if (decoded.includes('H7')) return { values: [['a@princeton.edu']] };
    if (decoded.includes('J1')) return { values: [['Status Review']] };
    if (decoded.includes('J7') && options?.method === 'PUT') {
      updated = JSON.parse(options.body).values[0][0] === true; return {};
    }
    throw new Error('Unexpected roster call');
  };
  await roster.flag({ row: 7, email: 'a@princeton.edu' });
  assert.equal(updated, true);
  updated = false;
  await assert.rejects(roster.flag({ row: 7, email: 'b@princeton.edu' }), /row moved/);
  assert.equal(updated, false);
});

test('server mapping rejects duplicate role IDs and malformed channels', () => {
  const config = {
    guildId: '1275140369457348638',
    roles: { guest: '1000000000000000001', member: '1000000000000000002', alumni: '1000000000000000003', teamLead: '1000000000000000004', board: '1000000000000000005' },
    channels: { startHere: '2000000000000000001', publicChat: '2000000000000000002', announcements: '2000000000000000003', boardLog: '2000000000000000004' },
    teams: {}, functions: {}, years: {},
  };
  assert.equal(validateServerConfig(config), config);
  assert.throws(() => validateServerConfig({ ...config, roles: { ...config.roles, member: config.roles.guest } }), /reuses/);
  assert.throws(() => validateServerConfig({ ...config, channels: { ...config.channels, startHere: 'invalid' } }), /startHere/);
});

test('server reads file-backed credentials from private paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tigerapps-config-'));
  const server = {
    guildId: '1275140369457348638',
    roles: { guest: '1000000000000000001', member: '1000000000000000002', alumni: '1000000000000000003', teamLead: '1000000000000000004', board: '1000000000000000005' },
    channels: { startHere: '2000000000000000001', publicChat: '2000000000000000002', announcements: '2000000000000000003', boardLog: '2000000000000000004' },
    teams: {}, functions: {}, years: {},
  };
  const files = Object.fromEntries(['SERVER_CONFIG_FILE', 'GOOGLE_SERVICE_ACCOUNT_FILE', 'GITHUB_PRIVATE_KEY_FILE', 'GMAIL_REFRESH_TOKEN_FILE']
    .map((key, i) => [key, join(dir, `${i}.txt`)]));
  const env = { ...files, DISCORD_TOKEN: 'bot', DISCORD_APP_ID: 'app', DISCORD_CLIENT_SECRET: 'discord',
    PUBLIC_BASE_URL: 'https://api.tigerapps.org', GOOGLE_CLIENT_ID: 'google', GOOGLE_CLIENT_SECRET: 'google-secret',
    GMAIL_CLIENT_ID: 'gmail', GMAIL_CLIENT_SECRET: 'gmail-secret', ROSTER_SPREADSHEET_ID: 'sheet',
    GITHUB_APP_ID: 'github', GITHUB_INSTALLATION_ID: 'installation' };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  writeFileSync(files.SERVER_CONFIG_FILE, JSON.stringify(server));
  writeFileSync(files.GOOGLE_SERVICE_ACCOUNT_FILE, JSON.stringify({ client_email: 'bot@example.com', private_key: 'key' }));
  writeFileSync(files.GITHUB_PRIVATE_KEY_FILE, 'private key\n');
  writeFileSync(files.GMAIL_REFRESH_TOKEN_FILE, 'refresh token\n');
  try {
    for (const key of ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GITHUB_PRIVATE_KEY', 'GMAIL_REFRESH_TOKEN']) delete process.env[key];
    Object.assign(process.env, env);
    const config = loadConfig();
    assert.equal(config.googleServiceAccount.client_email, 'bot@example.com');
    assert.equal(config.githubPrivateKey, 'private key');
    assert.equal(config.gmailRefreshToken, 'refresh token');
  } finally {
    for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commands use interaction roles and cancellation preserves a claimed action', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tigerapps-interaction-'));
  const state = new State(join(dir, 'state.json'));
  const { client } = createBot({ baseUrl: 'http://localhost:3000', server: {
    guildId: '1275140369457348638', roles: { board: 'board', teamLead: 'lead' },
    channels: { startHere: 'channel' }, teams: {},
  } }, state, {}, {}, {});
  const base = { guildId: '1275140369457348638', user: { id: 'user' },
    isModalSubmit: () => false, isStringSelectMenu: () => false };
  const emit = interaction => new Promise(resolve => client.emit('interactionCreate', {
    ...base, isChatInputCommand: () => false, isButton: () => false,
    reply: resolve, update: resolve, showModal: resolve, ...interaction,
  }));
  try {
    state.update(data => { data.actions.claimed = { actorId: 'user', status: 'executing', expiresAt: Date.now() + 60_000 }; });
    const denied = await emit({ isButton: () => true, customId: 'cancel:claimed' });
    assert.match(denied.content, /already started/);
    assert.equal(state.get().actions.claimed.status, 'executing');
    const modal = await emit({ isChatInputCommand: () => true, commandName: 'announce',
      inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['board']) } },
      options: { getString: () => null }, });
    assert.equal(modal.toJSON().title, 'TigerApps announcement');
  } finally { client.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
