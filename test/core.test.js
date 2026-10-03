import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateServerConfig } from '../src/config.js';
import { announcementPost, announcementPreview, assistedOnboardingDm, createBot, failureMessage, memberHeadshot, memberInfoCard, roleChange } from '../src/bot.js';
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
    state.link('board:b@princeton.edu', 'b@princeton.edu', 'discord-2');
    state.link('google-2', 'b@princeton.edu', 'discord-2');
    assert.equal(Object.keys(state.get().links).includes('board:b@princeton.edu'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('role changes apply the final set once and preserve unrelated roles', async () => {
  let updated;
  let calls = 0;
  const member = { guild: { id: 'guild' }, roles: {
    cache: new Map([['guild', {}], ['guest', {}], ['unrelated', {}]]),
    set: async ids => { updated = ids; calls++; },
  } };
  await roleChange(member, ['member'], ['guest', 'member']);
  assert.deepEqual(new Set(updated), new Set(['member', 'unrelated']));
  assert.equal(calls, 1);
});

test('announcement posts ping only the selected role', () => {
  const server = { roles: { member: 'club-role' }, teams: { TigerOps: { roleId: 'ops-role' }, 'The Forum': { roleId: 'forum-role' } } };
  const message = { subject: 'Update', body: 'Hello', team: 'The Forum' };
  assert.deepEqual(announcementPost(message, server), {
    content: '**Update**\n\nHello\n\n<@&forum-role>', allowedMentions: { parse: [], roles: ['forum-role'] },
  });
  const clubPost = announcementPost({ ...message, team: null }, server);
  assert.match(clubPost.content, /<@&club-role>$/);
  assert.deepEqual(clubPost.allowedMentions, { parse: [], roles: ['club-role'] });
});

test('announcement previews fit Discord at the modal input limits', () => {
  const server = { roles: { member: '1'.repeat(20) }, channels: { announcements: '2'.repeat(20) },
    teams: { 'Princeton Intelligence': { roleId: '3'.repeat(20), channelId: '4'.repeat(20) } } };
  const message = { subject: 'S'.repeat(100), body: 'B'.repeat(1800) };
  for (const team of ['Princeton Intelligence', null]) {
    const preview = announcementPreview({ ...message, team }, server, 49);
    assert.ok(preview.length <= 2000, `Preview has ${preview.length} characters`);
    assert.match(preview, /49 BCC emails/);
    assert.match(preview, /<#[24]{20}>/);
  }
});

test('member cards use a unique site headshot and show only allowed onboarding commands', () => {
  const person = { name: 'Member A', year: '2028', team: 'TigerOps', role: 'SWE', email: 'a@princeton.edu', phone: '555-0100', github: 'https://github.com/member-a' };
  const photos = [{ name: "Member A '28", headshot: '/_astro/member-a.abc.webp' }];
  const photo = memberHeadshot(person, photos);
  assert.equal(photo, 'https://tigerapps.org/_astro/member-a.abc.webp');
  assert.equal(memberHeadshot(person, [{ ...photos[0], headshot: '/_astro/filler.abc.webp' }]), 'https://tigerapps.org/_astro/filler.abc.webp');
  assert.equal(memberHeadshot(person, [...photos, ...photos]), null);
  assert.equal(memberHeadshot(person, [{ ...photos[0], headshot: 'https://other.example/photo.webp' }]), null);
  const embed = memberInfoCard(person, photo).toJSON();
  assert.equal(embed.thumbnail.url, photo);
  assert.equal(embed.fields.find(field => field.name === 'Phone').value, '555-0100');
  assert.match(embed.fields.find(field => field.name === 'GitHub').value, /github.com\/member-a/);
  const server = { roles: { board: 'board', teamLead: 'lead', member: 'member' }, teams: { TigerOps: { leadIds: ['lead-user'] } } };
  const dm = (member, ordinaryAssigned = false) => assistedOnboardingDm(member, 'board-user', server, ordinaryAssigned).embeds[0].toJSON();
  assert.match(dm({ id: 'ordinary', roles: { cache: new Set() } }, true).description, /verified.*\/info/s);
  assert.doesNotMatch(dm({ id: 'ordinary', roles: { cache: new Set() } }, true).description, /\/remove/);
  assert.match(dm({ id: 'lead-user', roles: { cache: new Set(['lead']) } }).description, /\/announce/);
  assert.doesNotMatch(dm({ id: 'unmapped-lead', roles: { cache: new Set(['lead']) } }).description, /\/announce/);
  assert.match(dm({ id: 'board-user', roles: { cache: new Set(['board']) } }).description, /\/remove/);
  const owner = dm({ id: 'owner', roles: { cache: new Set() } });
  assert.equal(owner.title, 'Your TigerApps account is linked');
  assert.doesNotMatch(owner.description, /\/info|\/announce|\/github-invite|\/remove/);
  const ownerMember = dm({ id: 'owner', roles: { cache: new Set(['member']) } });
  assert.match(ownerMember.description, /\/info/);
  assert.doesNotMatch(ownerMember.description, /\/remove/);
});

test('mail hides recipients and rejects header injection', () => {
  const discordUrl = 'https://discord.com/channels/1275140369457348638/1275141595322257428/1553907021882069002';
  const raw = Buffer.from(mailMessage({ subject: 'All hands', body: 'Hello <team>&', to: 'lead@princeton.edu',
    cc: 'it.admin@princetonusg.com', bcc: ['a@princeton.edu', 'b@princeton.edu'], discordUrl }), 'base64url').toString();
  assert.match(raw, /Cc: it\.admin@princetonusg\.com/);
  assert.match(raw, /Bcc: a@princeton\.edu,\r\n b@princeton\.edu/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  const html = Buffer.from(raw.match(/Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--tigerapps-/)[1].replace(/\s/g, ''), 'base64').toString();
  assert.match(html, /Hello &lt;team&gt;&amp;/);
  assert.match(html, new RegExp(`href="${discordUrl}"`));
  assert.match(html, /Open in Discord/);
  const many = Buffer.from(mailMessage({ subject: 'All hands', body: 'Hello', to: 'lead@princeton.edu',
    bcc: Array.from({ length: 60 }, (_, i) => `member${i}@princeton.edu`), discordUrl }), 'base64url').toString();
  assert.ok(many.split('\r\n\r\n')[0].split('\r\n').every(line => Buffer.byteLength(line) <= 998));
  for (const subject of ['A'.repeat(100), '📣'.repeat(25)]) {
    const message = Buffer.from(mailMessage({ subject, body: 'Hello', to: 'lead@princeton.edu',
      bcc: ['a@princeton.edu'], discordUrl }), 'base64url').toString();
    const lines = message.split('\r\n');
    const start = lines.findIndex(line => line.startsWith('Subject: '));
    const folded = [lines[start]];
    for (let i = start + 1; lines[i]?.startsWith(' '); i++) folded.push(lines[i]);
    assert.ok(folded.length > 1 && folded.every(line => line.length <= 76));
    assert.equal([...folded.join(' ').matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
      .map(match => Buffer.from(match[1], 'base64').toString()).join(''), subject);
  }
  assert.throws(() => mailMessage({ subject: 'News', body: 'x', to: 'bad@example.com\r\nBcc: attacker@example.com', bcc: ['a@princeton.edu'], discordUrl }), /Invalid email/);
  assert.throws(() => mailMessage({ subject: 'News', body: 'x', to: 'lead@princeton.edu', bcc: ['a@princeton.edu'], discordUrl: 'https://example.com' }), /Invalid Discord/);
  const test = Buffer.from(mailMessage({ subject: '[Test] News', body: 'Hello', to: 'lead@princeton.edu' }), 'base64url').toString();
  assert.doesNotMatch(test, /Bcc:/);
  assert.doesNotMatch(test, /Open in Discord/);
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

test('command previews, audit logs, and cancellation guards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tigerapps-interaction-'));
  const state = new State(join(dir, 'state.json'));
  const rows = [{ name: 'Member A', email: 'a@princeton.edu', github: 'https://github.com/Member-A', team: 'TigerOps', role: 'SWE', year: '2028' }];
  const { client } = createBot({ baseUrl: 'http://localhost:3000', server: {
    guildId: '1275140369457348638', roles: { board: 'board', teamLead: 'lead', member: 'member' },
    channels: { startHere: 'channel' }, teams: { TigerOps: { roleId: 'team', channelId: 'channel', leadIds: [] } }, functions: {}, years: {},
  } }, state, { all: async () => rows, byEmail: async email => rows.find(row => row.email === email) }, {}, {});
  const logs = [];
  client.channels.fetch = async () => ({ send: async message => { logs.push(message.embeds[0].toJSON().description); } });
  const display = message => message.content || message.embeds?.[0]?.toJSON().description || message.embeds?.[0]?.toJSON().title;
  const base = { guildId: '1275140369457348638', user: { id: 'user' },
    isModalSubmit: () => false, isStringSelectMenu: () => false };
  const emit = interaction => new Promise(resolve => client.emit('interactionCreate', {
    ...base, isChatInputCommand: () => false, isButton: () => false,
    reply: resolve, update: resolve, showModal: resolve, editReply: resolve, deferReply: async () => {}, ...interaction,
  }));
  try {
    state.update(data => { data.actions.claimed = { actorId: 'user', status: 'executing', expiresAt: Date.now() + 60_000 }; });
    const denied = await emit({ isButton: () => true, customId: 'cancel:claimed' });
    assert.match(display(denied), /check its result/);
    assert.equal(state.get().actions.claimed.status, 'executing');
    const selfOnboard = await emit({ isChatInputCommand: () => true, commandName: 'onboard',
      options: { getUser: () => null, getString: () => null } });
    assert.match(display(selfOnboard), /Were you accepted/);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ name: "Member A '28", headshot: '/_astro/member-a.abc.webp' }] });
    try {
      const info = await emit({ isChatInputCommand: () => true, commandName: 'info',
        inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['member']) } },
        options: { getUser: () => null, getString: () => 'a@princeton.edu' } });
      assert.equal(info.embeds[0].toJSON().thumbnail.url, 'https://tigerapps.org/_astro/member-a.abc.webp');
      state.link('google-member-a', 'a@princeton.edu', 'target');
      globalThis.fetch = async () => ({ ok: false });
      client.users.fetch = async () => ({ displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/target/photo.webp' });
      const fallback = await emit({ isChatInputCommand: () => true, commandName: 'info',
        inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['member']) } },
        options: { getUser: () => null, getString: () => 'a@princeton.edu' } });
      assert.equal(fallback.embeds[0].toJSON().thumbnail.url, 'https://cdn.discordapp.com/avatars/target/photo.webp');
      const originalError = console.error;
      try {
        console.error = () => {};
        const guest = await emit({ isChatInputCommand: () => true, commandName: 'info',
          inCachedGuild: () => true, member: { id: 'guest', roles: { cache: new Set(['guest']) } },
          options: { getUser: () => null, getString: () => 'a@princeton.edu' } });
        assert.match(display(guest), /Only TigerApps members/);
      } finally { console.error = originalError; }
    } finally { globalThis.fetch = originalFetch; }
    const boardOnboard = await emit({ isChatInputCommand: () => true, commandName: 'onboard',
      inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['board']) } }, guild: { ownerId: 'owner' },
      options: { getUser: () => ({ id: 'target', bot: false }), getString: () => 'a@princeton.edu',
        getMember: () => ({ id: 'target', roles: { cache: new Set() } }) } });
    assert.equal(boardOnboard.embeds[0].toJSON().title, 'Onboard Member A');
    assert.equal(boardOnboard.embeds[0].toJSON().fields.find(field => field.name === 'Team').value, 'TigerOps');
    assert.ok(Object.values(state.get().actions).some(action => action.type === 'onboard-member' && action.targetId === 'target'));
    const modal = await emit({ isChatInputCommand: () => true, commandName: 'announce',
      inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['board']) } },
      options: { getString: () => null }, });
    assert.equal(modal.toJSON().title, 'TigerApps announcement');
    await emit({ isChatInputCommand: () => true, commandName: 'announce',
      inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['board']) } },
      options: { getString: () => 'TigerOps' } });
    assert.ok(Object.values(state.get().actions).some(action => action.type === 'announce' && action.team === 'TigerOps'));
    const invite = await emit({ isChatInputCommand: () => true, commandName: 'github-invite',
      inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['board']) } },
      options: { getString: name => name === 'username' ? 'member-a' : null } });
    assert.match(invite.embeds[0].toJSON().title, /Invite Member A/);
    assert.ok(Object.values(state.get().actions).some(action => action.type === 'github-invite' && action.email === 'a@princeton.edu'));
    const emailInvite = await emit({ isChatInputCommand: () => true, commandName: 'github-invite',
      inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['board']) } },
      options: { getString: name => name === 'email' ? 'a@princeton.edu' : null } });
    assert.match(emailInvite.embeds[0].toJSON().title, /Invite Member A/);
    rows.push({ name: 'Member B', email: 'b@princeton.edu', github: 'Member-A' });
    const originalError = console.error;
    try {
      console.error = () => {};
      const ambiguous = await emit({ isChatInputCommand: () => true, commandName: 'github-invite',
        inCachedGuild: () => true, member: { id: 'user', roles: { cache: new Set(['board']) } },
        options: { getString: name => name === 'username' ? 'member-a' : null } });
      assert.match(display(ambiguous), /must match one roster member/);
    } finally { console.error = originalError; }
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(logs.some(message => message.includes('invoked /onboard')));
    assert.ok(logs.some(message => message.includes('invoked /announce')));
    assert.ok(logs.some(message => message.includes('invoked /github-invite')));
  } finally { client.destroy(); rmSync(dir, { recursive: true, force: true }); }
});

test('announcement test sends reach only the sender and list the real recipients', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tigerapps-test-send-'));
  const state = new State(join(dir, 'state.json'));
  const rows = [{ name: 'Member A', email: 'a@princeton.edu', team: 'TigerOps' }, { name: 'Member B', email: 'b@princeton.edu', team: 'The Forum' }];
  const sent = [];
  const { client } = createBot({ baseUrl: 'http://localhost:3000', server: { guildId: 'guild', roles: {}, channels: {}, teams: {} } }, state,
    { all: async () => rows }, {}, { send: async message => { sent.push(message); } });
  client.channels.fetch = async () => ({ send: async () => {} });
  state.link('google-lead', 'lead@princeton.edu', 'lead');
  state.update(data => { data.actions.ann = { type: 'announce', actorId: 'lead', team: 'TigerOps', subject: 'Meeting', body: 'Hello',
    status: 'ready', expiresAt: Date.now() + 60_000 }; });
  const emit = () => new Promise(resolve => client.emit('interactionCreate', { guildId: 'guild', user: { id: 'lead' }, customId: 'test:ann',
    isChatInputCommand: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false, isButton: () => true,
    deferReply: async () => {}, deferred: true, editReply: resolve, followUp: resolve, reply: resolve }));
  try {
    const reply = await emit();
    assert.equal(reply.embeds[0].toJSON().title, 'Test sent');
    assert.deepEqual({ to: sent[0].to, subject: sent[0].subject, bcc: sent[0].bcc, cc: sent[0].cc }, { to: 'lead@princeton.edu', subject: '[Test] Meeting', bcc: undefined, cc: undefined });
    assert.match(sent[0].body, /Real recipients \(1\):\nMember A <a@princeton\.edu>$/);
    assert.equal(state.get().actions.ann.status, 'ready');
  } finally { client.destroy(); rmSync(dir, { recursive: true, force: true }); }
});

test('unexpected failures explain themselves and report details to Board', async () => {
  assert.match(failureMessage(new Error('Roster request failed (400): Unable to parse range')), /roster sheet/);
  assert.match(failureMessage(new Error('Gmail send outcome needs review (401)')), /send email/);
  assert.match(failureMessage(Object.assign(new Error('Missing Permissions'), { code: 50013 })), /Discord permission/);
  const dir = mkdtempSync(join(tmpdir(), 'tigerapps-failure-'));
  const state = new State(join(dir, 'state.json'));
  const { client } = createBot({ baseUrl: 'http://localhost:3000', server: { guildId: 'guild', roles: { board: 'board', teamLead: 'lead' }, channels: {}, teams: {} } }, state,
    { all: async () => { throw new Error('Roster request failed (400): Unable to parse range'); } }, {}, {});
  const logs = [];
  client.channels.fetch = async () => ({ send: async message => { logs.push(message.embeds[0].toJSON().description); } });
  const originalError = console.error;
  console.error = () => {};
  try {
    const reply = await new Promise(resolve => client.emit('interactionCreate', { guildId: 'guild', user: { id: 'user' },
      isChatInputCommand: () => true, commandName: 'github-invite', inCachedGuild: () => true,
      member: { id: 'user', roles: { cache: new Set(['board']) } }, options: { getString: name => name === 'username' ? 'member-a' : null },
      deferReply: async function () { this.deferred = true; }, editReply: resolve, isModalSubmit: () => false }));
    assert.match(reply.embeds[0].toJSON().description, /couldn't read the roster sheet/);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(logs.some(message => message.includes('/github-invite failed for <@user>: Roster request failed (400): Unable to parse range')));
  } finally { console.error = originalError; client.destroy(); rmSync(dir, { recursive: true, force: true }); }
});

test('Board-assisted onboarding assigns roles before sending its member DM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tigerapps-board-onboard-'));
  const state = new State(join(dir, 'state.json'));
  const person = { name: 'Member A', email: 'a@princeton.edu', team: 'TigerOps', role: 'SWE', year: '2028' };
  const server = { guildId: 'guild', roles: { guest: 'guest', member: 'member', alumni: 'alumni', teamLead: 'lead', board: 'board' },
    channels: { startHere: 'start', publicChat: 'public', announcements: 'announcements', boardLog: 'log' },
    teams: { TigerOps: { roleId: 'team', channelId: 'team-channel', leadIds: [] } }, functions: {}, years: {} };
  const { client } = createBot({ baseUrl: 'http://localhost:3000', server }, state,
    { all: async () => [person], byEmail: async () => person }, {}, {});
  const logs = [];
  let assigned, dm, reply;
  const channel = { isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    send: async message => { if (message.embeds) logs.push(message.embeds[0].toJSON().description); return { id: 'panel' }; } };
  const role = { comparePositionTo: () => 1 };
  const guild = { id: 'guild', ownerId: 'owner', roles: { cache: new Map([
    ['board', role], ...['guest', 'member', 'alumni', 'lead', 'team'].map(id => [id, {}])]), fetch: async () => {} },
  channels: { cache: new Map(Object.values(server.channels).concat('team-channel').map(id => [id, channel])), fetch: async () => {} },
  commands: { set: async () => {} } };
  const target = { id: 'target', guild, user: { bot: false, send: async message => { dm = message; } }, roles: {
    cache: new Map([['guild', {}], ['guest', {}]]), set: async ids => { assigned = ids; },
  } };
  const actor = { id: 'actor', guild, roles: { cache: new Map([['board', {}]]) } };
  guild.members = { fetchMe: async () => ({ permissions: { has: () => true }, roles: { highest: role } }),
    fetch: async ({ user }) => user === 'target' ? target : actor };
  client.guilds.fetch = async () => guild;
  client.channels.fetch = async () => channel;
  try {
    client.emit('clientReady');
    for (let i = 0; i < 20 && !state.get().panelId; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.get().panelId, 'panel');
    state.update(data => { data.actions.board = { type: 'onboard-member', actorId: 'actor', targetId: 'target',
      email: person.email, roster: [person.team, person.role, person.year], boardTarget: false,
      status: 'ready', expiresAt: Date.now() + 60_000 }; });
    client.emit('interactionCreate', { guildId: 'guild', user: { id: 'actor' }, customId: 'confirm:board',
      isChatInputCommand: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false,
      isButton: () => true, deferUpdate: async () => {}, editReply: async message => { reply = message; } });
    for (let i = 0; i < 20 && !reply; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(new Set(assigned), new Set(['member', 'team']));
    assert.equal(state.linkedByDiscord('target').email, person.email);
    assert.match(dm.embeds[0].toJSON().description, /<@actor>.*\/info/s);
    assert.match(reply.embeds[0].toJSON().description, /DM sent/);
    assert.ok(logs.some(message => message.includes('onboarded <@target>')));
  } finally { client.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
