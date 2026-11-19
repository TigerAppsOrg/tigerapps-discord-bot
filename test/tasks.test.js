import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, Collection, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { handleTask, memberChannel, taskCommand } from '../src/tasks.js';

const server = { guildId: 'guild', roles: { member: 'member', guest: 'guest', alumni: 'alumni', board: 'board', teamLead: 'lead' },
  teams: { TigerOps: { roleId: 'ops', channelId: 'ops-room' } }, functions: {}, years: {} };
const view = PermissionFlagsBits.ViewChannel;
const permissions = (...bits) => new PermissionsBitField(bits);
function room() {
  return { guildId: 'guild', guild: { roles: { cache: new Map([['bot-role', { tags: { botId: 'bot' } }]]) } }, id: 'ops-room', type: ChannelType.GuildText,
    permissionsFor: id => permissions(...(id === 'ops' ? [view] : [])),
    permissionOverwrites: { cache: new Collection([
      ['guild', { id: 'guild', deny: permissions(view), allow: permissions() }],
      ['ops', { id: 'ops', deny: permissions(), allow: permissions(view) }],
      ['bot-role', { id: 'bot-role', deny: permissions(), allow: permissions(view) }],
    ]) } };
}

test('task commands expose show and create', () => {
  const command = taskCommand.toJSON();
  assert.equal(command.name, 'task');
  assert.deepEqual(command.options.map(sub => sub.name), ['show', 'create']);
});

test('ticket cards can appear in member rooms, but not guest rooms or unreviewed visibility overrides', () => {
  assert.equal(memberChannel(room(), server, 'bot'), true);
  for (const mutate of [
    channel => { channel.type = ChannelType.PublicThread; },
    channel => { channel.guildId = 'other'; },
    channel => { channel.permissionOverwrites.cache.delete('guild'); },
    channel => { channel.permissionsFor = id => permissions(...(id === 'guest' ? [view] : [])); },
    channel => { channel.permissionOverwrites.cache.set('visitor', { id: 'visitor', allow: permissions(view) }); },
  ]) {
    const channel = room();
    mutate(channel);
    assert.equal(memberChannel(channel, server, 'bot'), false);
  }
});

test('show and create publish one channel card under the linked identity', async () => {
  for (const action of ['show', 'create']) {
    const channel = room(), sent = [], calls = [];
    channel.permissionsFor = id => permissions(...(id === 'bot' ? [view, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] : []));
    channel.send = async payload => sent.push(payload);
    const interaction = { id: '123456789012345678', member: { roles: { cache: new Set(['member']) } }, channel, client: { user: { id: 'bot' } },
      options: { getSubcommand: () => action, getString: name => ({ title: 'Fix import', ticket: 'TIG-42' })[name] },
      deferReply: async data => calls.push(['defer', data.flags]), editReply: async () => assert.fail('unexpected error'),
      deleteReply: async () => calls.push(['delete']) };
    await handleTask(interaction, server, { email: 'member@example.com' }, async (email, input) => {
      assert.equal(email, 'member@example.com');
      assert.deepEqual(input, action === 'show' ? { action, ticket: 'TIG-42' } : { action, interactionId: interaction.id, title: 'Fix import', team: 'TigerOps', project: undefined });
      return { ticket: { number: 42, title: 'Fix import', status: 'Backlog', project: 'TigerOps', assignees: [], blockers: [{ number: 5 }] } };
    });
    assert.deepEqual(calls, [['defer', 64], ['delete']]);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].allowedMentions.parse, []);
    const embed = sent[0].embeds[0].toJSON();
    assert.equal(embed.url, 'https://tasks.tigerapps.org/?task=TIG-42');
    assert.match(embed.fields.find(f => f.name === 'Blocked by').value, /TIG-5/);
  }
});

test('task errors stay private and posting failures preserve the created ticket number', async () => {
  const edits = [], channel = room();
  channel.permissionsFor = id => permissions(...(id === 'bot' ? [view, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] : []));
  const interaction = { id: '123456789012345678', member: { roles: { cache: new Set(['member']) } }, channel, client: { user: { id: 'bot' } },
    options: { getSubcommand: () => 'create', getString: () => 'Ticket' }, deferReply: async () => {},
    editReply: async message => edits.push(message), deleteReply: async () => assert.fail() };
  await handleTask(interaction, server, null, () => assert.fail());
  assert.match(edits.pop(), /onboard/);
  const canPost = channel.permissionsFor;
  channel.permissionsFor = id => permissions(...(id === 'bot' ? [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] : []));
  await handleTask(interaction, server, { email: 'member@example.com' }, () => assert.fail('no ticket without ViewChannel'));
  assert.match(edits.pop(), /private member channel/);
  channel.permissionsFor = canPost;
  channel.send = async () => assert.fail('an API error must stay private');
  await handleTask(interaction, server, { email: 'member@example.com' }, async () => ({ error: 'Choose a project.' }));
  assert.equal(edits.pop().content, 'Choose a project.');
  channel.send = async () => { throw new Error('missing permission'); };
  await handleTask(interaction, server, { email: 'member@example.com' }, async () => ({
    ticket: { number: 42, title: 'Ticket', status: 'Backlog', assignees: [], blockers: [] },
  }));
  assert.match(edits.pop(), /Created TIG-42.*task=TIG-42/);
});

test('the bot sends the verified email to the connector and handles an uncertain create privately', async t => {
  const { requestTask } = await import('../src/tasks.js');
  const send = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://tasks.tigerapps.org/api/discord/tasks');
    assert.equal(init.headers.Authorization, 'Bearer test-connector');
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).email, 'member@example.com');
    return Response.json({ error: 'Choose a project.' }, { status: 400 });
  });
  assert.deepEqual(await requestTask('test-connector', 'member@example.com', { action: 'show' }), { error: 'Choose a project.' });
  send.mock.mockImplementation(async () => { throw new Error('timeout'); });
  assert.match((await requestTask('test-connector', 'member@example.com', { action: 'create' })).error, /before creating it again/);
});
