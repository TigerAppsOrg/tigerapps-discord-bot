import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown } from 'discord.js';

const origin = 'https://tasks.tigerapps.org';

export const taskCommand = new SlashCommandBuilder().setName('task').setDescription('Work with TigerTasks tickets')
  .addSubcommand(sub => sub.setName('show').setDescription('Show a ticket in this channel')
    .addStringOption(option => option.setName('ticket').setDescription('Ticket number, for example TIG-212').setRequired(true)))
  .addSubcommand(sub => sub.setName('create').setDescription('Create a ticket and share it in this channel')
    .addStringOption(option => option.setName('title').setDescription('Ticket title').setRequired(true).setMaxLength(200))
    .addStringOption(option => option.setName('project').setDescription('Project name if the channel has no single project').setMaxLength(200)));

export function memberChannel(channel, server, botId) {
  if (channel?.type !== ChannelType.GuildText || channel.guildId !== server.guildId) return false;
  const { ViewChannel } = PermissionFlagsBits;
  const members = new Set([server.roles.member, server.roles.teamLead, server.roles.board,
    ...Object.values(server.teams).map(team => team.roleId), ...Object.values(server.functions), ...Object.values(server.years), botId]);
  // A guest, an unlinked role, or an individual override can expose a public ticket card
  if (!channel.permissionOverwrites.cache.get(server.guildId)?.deny.has(ViewChannel, false)) return false;
  if ([server.guildId, server.roles.guest, server.roles.alumni].some(id => channel.permissionsFor(id)?.has(ViewChannel) !== false)) return false;
  return channel.permissionOverwrites.cache.every(entry => !entry.allow.has(ViewChannel, false) || members.has(entry.id) ||
    channel.guild.roles.cache.get(entry.id)?.tags?.botId === botId);
}

function ticketCard(ticket) {
  const summary = new EmbedBuilder().setColor(0x3ee0bf).setTitle(`TIG-${ticket.number} · ${ticket.title}`)
    .setURL(`${origin}/?task=TIG-${ticket.number}`)
    .addFields({ name: 'Status', value: ticket.archived ? `${ticket.status} · Archived` : ticket.status, inline: true },
      { name: 'Assignees', value: ticket.assignees.map(name => escapeMarkdown(name)).join(', ').slice(0, 1024) || 'Unassigned', inline: true });
  if (ticket.project) summary.addFields({ name: 'Project', value: escapeMarkdown(ticket.project).slice(0, 1024), inline: true });
  if (ticket.blockers.length) summary.addFields({ name: 'Blocked by', value: ticket.blockers.slice(0, 5)
    .map(item => `[TIG-${item.number}](${origin}/?task=TIG-${item.number})`).join(', ') +
    (ticket.blockers.length > 5 ? ` and ${ticket.blockers.length - 5} more` : '') });
  return { embeds: [summary], allowedMentions: { parse: [] } };
}

export async function handleTask(interaction, server, link, request) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { member, channel, client, options } = interaction;
  const roles = member.roles.cache;
  if (!link || ![server.roles.member, server.roles.teamLead, server.roles.board].some(id => roles.has(id))) {
    return interaction.editReply('Verify your Princeton account with /onboard first.');
  }
  const canShare = () => memberChannel(channel, server, client.user.id) &&
    channel.permissionsFor(client.user.id)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  if (!canShare()) return interaction.editReply('Use a private member channel where the bot can post ticket cards.');

  const action = options.getSubcommand();
  const team = Object.entries(server.teams).find(([, entry]) => entry.channelId === channel.id)?.[0];
  const input = action === 'show' ? { action, ticket: options.getString('ticket', true) } :
    { action, interactionId: interaction.id, title: options.getString('title', true), project: options.getString('project') ?? undefined, team };
  const result = await request(link.email, input);
  if (result.error) return interaction.editReply({ content: result.error, allowedMentions: { parse: [] } });
  const ticket = result.ticket;
  try {
    if (!canShare()) throw new Error('Channel access changed');
    await channel.send(ticketCard(ticket));
  } catch {
    const label = action === 'create' ? 'Created' : 'Found';
    return interaction.editReply(`${label} TIG-${ticket.number}, but the card could not be posted here. <${origin}/?task=TIG-${ticket.number}>`);
  }
  // The public card has already been delivered
  await interaction.deleteReply().catch(() => console.warn('Could not clear the private ticket acknowledgement.'));
}

export async function requestTask(secret, email, input) {
  try {
    const response = await fetch(`${origin}/api/discord/tasks`, {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, email }), redirect: 'error', signal: AbortSignal.timeout(12000),
    });
    if (response.ok) return await response.json();
    if ([400, 403, 404, 409].includes(response.status)) {
      const body = await response.json();
      if (typeof body.error === 'string') return { error: body.error.slice(0, 1900) };
    }
    if ([401, 503].includes(response.status)) return { error: 'The TigerTasks connection needs attention from Board.' };
  } catch {
    // A create request can commit before its response arrives
  }
  return { error: input.action === 'create' ? 'Check TigerTasks for your ticket before creating it again.' : 'TigerTasks is unavailable. Try again later.' };
}
