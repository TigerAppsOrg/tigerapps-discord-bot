import { createHash, randomBytes } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits,
  GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel,
  LabelBuilder, MessageFlags, ModalBuilder, PermissionsBitField, RadioGroupBuilder, RadioGroupOptionBuilder, SlashCommandBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { managedRoleIds } from './config.js';
import { announcementRecipients, calendarEvent, easternInstant, githubHandle, mailSender, parseWhen, semesterEnd } from './integrations.js';
import { createOAuth } from './oauth.js';
import { rosterFunctions, rosterTeams } from './roster.js';

const ephemeral = MessageFlags.Ephemeral;
const accent = 0x3ee0bf;
const nonce = () => randomBytes(16).toString('hex');
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, label, style = ButtonStyle.Primary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const digest = emails => createHash('sha256').update(emails.join('\n')).digest('hex');
const card = (title, description, color = accent) => ({ content: null,
  embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)] });
const field = (name, value, missing = 'Not listed') => ({ name, value: String(value || missing).slice(0, 1024), inline: true });

// shown to users verbatim while other errors go to Board
export class UserError extends Error {}

export function failureMessage(error) {
  if (error.message.startsWith('Roster ')) return "I couldn't read the roster sheet. Board has been notified.";
  if (error.message.startsWith('Gmail ')) return "I couldn't send email from the TigerApps account. Board has been notified.";
  if ([50001, 50013].includes(error.code)) return "I'm missing a Discord permission for that. Board has been notified.";
  return 'Something went wrong on my end. Board has been notified; try again later.';
}

function rolesCard(title, description, chosen) {
  return new EmbedBuilder().setColor(accent).setTitle(title.slice(0, 256)).setDescription(description).addFields(
    field('Team', chosen.teams.join(', '), 'None'),
    field('Role', chosen.functions.join(', '), 'None'),
    field('Class year', chosen.year, 'None'),
  );
}

function select(id, label, names, selected, multiple = true) {
  const options = [['none', `No ${label.toLowerCase()} yet`], ...names.map(name => [name, name])];
  const menu = new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(label)
    .setMinValues(1).setMaxValues(multiple ? options.length : 1);
  menu.addOptions(options.map(([value, text]) => new StringSelectMenuOptionBuilder()
    .setLabel(text).setValue(value).setDefault(selected.length ? selected.includes(value) : value === 'none')));
  return row(menu);
}

function choiceMessage(config, chosen) {
  const teams = Object.keys(config.server.teams);
  const functions = Object.keys(config.server.functions);
  const years = Object.keys(config.server.years);
  return {
    content: null, embeds: [rolesCard('Confirm your roles', 'Your choices set your channel access.', chosen)],
    components: [
      select('onboard:teams', 'Team', teams, chosen.teams),
      select('onboard:functions', 'Role', functions, chosen.functions),
      select('onboard:year', 'Class year', years, chosen.year ? [chosen.year] : [], false),
      row(button('onboard:confirm', 'Confirm')),
    ],
  };
}

export function announcementPost(action, server) {
  const roleId = action.team ? server.teams[action.team].roleId : server.roles.member;
  return { content: `**${action.subject}**\n\n${action.body}\n\n<@&${roleId}>`,
    allowedMentions: { parse: [], roles: [roleId] } };
}

export function announcementPreview(action, server, recipients) {
  const channelId = action.team ? server.teams[action.team].channelId : server.channels.announcements;
  return `Preview · <#${channelId}> · ${recipients} BCC emails\n\n${announcementPost(action, server).content}`;
}

export function eventSummary({ location, date, start, end, repeat }) {
  const unix = time => Math.floor(easternInstant(date, time).getTime() / 1000);
  const until = new Date(`${semesterEnd(date)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return [`<t:${unix(start)}:F> – <t:${unix(end)}:t>`, repeat ? `${repeat === 1 ? 'Weekly' : 'Every 2 weeks'} until ${until}` : null, location]
    .filter(Boolean).join('\n');
}

export function discordEvent({ title, location, date, start, end }) {
  return {
    name: title, scheduledStartTime: easternInstant(date, start), scheduledEndTime: easternInstant(date, end), entityMetadata: { location },
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, entityType: GuildScheduledEventEntityType.External,
  };
}

export function nextOccurrence(date, repeat) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 7 * repeat);
  return next.toISOString().slice(0, 10);
}

function eventForm(id, values = {}) {
  const text = (customId, label, placeholder, max) => {
    const input = new TextInputBuilder().setCustomId(customId).setStyle(TextInputStyle.Short)
      .setPlaceholder(placeholder).setMaxLength(max).setRequired(true);
    if (values[customId]) input.setValue(values[customId]);
    return new LabelBuilder().setLabel(label).setTextInputComponent(input);
  };
  const repeat = new RadioGroupBuilder().setCustomId('repeat').setRequired(true).addOptions(
    [['Once', '0'], ['Weekly', '1'], ['Every 2 weeks', '2']].map(([label, value]) =>
      new RadioGroupOptionBuilder().setLabel(label).setValue(value).setDefault(value === (values.repeat || '0'))));
  return new ModalBuilder().setCustomId(`event:${id}`).setTitle('New event').addLabelComponents(
    text('title', 'Title', 'Board office hours', 100), text('date', 'Date', 'Thu Oct 8', 30),
    text('time', 'Time', '6:45-7:15pm', 30), text('location', 'Location', 'Lewis 122', 100),
    new LabelBuilder().setLabel('Repeats').setRadioGroupComponent(repeat));
}

export function memberHeadshot(person, members) {
  if (!person.name || !person.year) return null;
  const name = `${person.name.trim()} '${person.year.slice(-2)}`.toLowerCase();
  const matches = Array.isArray(members) ? members.filter(member => member.name?.toLowerCase() === name &&
    /^\/_astro\/[\w.-]+\.webp$/.test(member.headshot)) : [];
  return matches.length === 1 ? `https://tigerapps.org${matches[0].headshot}` : null;
}

export function memberInfoCard(person, photo) {
  const github = githubHandle(person.github);
  const embed = new EmbedBuilder().setColor(accent).setTitle((person.name || person.email).slice(0, 256)).addFields(
    field('Team', person.team),
    field('Role', person.role),
    field('Class year', person.year),
    field('GitHub', github ? `[${github}](https://github.com/${github})` : person.github),
    field('Email', person.email),
    field('Phone', person.phone),
  );
  if (photo) embed.setThumbnail(photo);
  return embed;
}

export function assistedOnboardingDm(member, actorId, server, ordinaryAssigned = false) {
  const lead = member.roles.cache.has(server.roles.teamLead);
  const teams = Object.values(server.teams).filter(team => team.leadIds.includes(member.id));
  let title = 'Your TigerApps account is linked';
  let help = 'Ask Board to check your Discord roles if you need member access.';
  if (member.roles.cache.has(server.roles.board)) {
    title = 'Your TigerApps access is ready';
    help = 'As a Board member, you can use `/info` for member details, `/announce` for team or club updates, `/event` for the club calendar, `/github-invite` for organization invites, `/onboard member email` to set up others, and `/remove` to revoke access.';
  } else if (lead) {
    title = 'Your TigerApps access is ready';
    help = `As a Team Lead, you can use \`/info\`, \`/event\`, and \`/github-invite\`${teams.length ? ', plus `/announce` for your team.' : '.'}`;
  } else if (ordinaryAssigned || member.roles.cache.has(server.roles.member)) {
    title = 'Your TigerApps access is ready';
    help = 'Your TigerApps channels are ready. Use `/info` to look up members.';
  }
  return { embeds: [new EmbedBuilder().setColor(accent).setTitle(title)
    .setDescription(`<@${actorId}> verified your membership.\n\n${help}`)], allowedMentions: { parse: [] } };
}

function commands(config) {
  const teamChoices = Object.keys(config.server.teams).map(name => ({ name, value: name }));
  return [
    new SlashCommandBuilder().setName('onboard').setDescription('Set up TigerApps access')
      .addUserOption(option => option.setName('member').setDescription('Board: Discord member to onboard'))
      .addStringOption(option => option.setName('email').setDescription('Board: exact Princeton roster email')),
    new SlashCommandBuilder().setName('resign').setDescription('Move your TigerApps access to Alumni'),
    new SlashCommandBuilder().setName('remove').setDescription('Board: remove a member’s access')
      .addUserOption(option => option.setName('member').setDescription('Discord member').setRequired(true))
      .addStringOption(option => option.setName('reason').setDescription('Reason for removal').setRequired(true).setMaxLength(300)),
    new SlashCommandBuilder().setName('announce').setDescription('Announce to TigerApps or a team')
      .addStringOption(option => option.setName('team').setDescription('Team; Board may omit for club-wide').addChoices(...teamChoices)),
    new SlashCommandBuilder().setName('event').setDescription('Add an event to the TigerApps calendar'),
    new SlashCommandBuilder().setName('info').setDescription('Look up a roster member privately')
      .addUserOption(option => option.setName('member').setDescription('Linked Discord member'))
      .addStringOption(option => option.setName('email').setDescription('Exact Princeton roster email')),
    new SlashCommandBuilder().setName('github-invite').setDescription('Invite a roster member to the GitHub organization')
      .addStringOption(option => option.setName('username').setDescription('GitHub username on the roster'))
      .addStringOption(option => option.setName('email').setDescription('Exact Princeton roster email')),
  ].map(command => command.toJSON());
}

export async function roleChange(member, desired, revoke) {
  const roles = [...new Set([...member.roles.cache.keys()]
    .filter(id => id !== member.guild.id && !revoke.includes(id)).concat(desired))];
  await member.roles.set(roles);
}

export function createBot(config, state, roster, github, mailer, calendar) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const oauth = createOAuth(config, state, roster, client, boardNotice);
  const { server } = config;
  let guild;

  async function boardNotice(message) {
    try {
      const channel = await client.channels.fetch(server.channels.boardLog);
      await channel.send({ ...card('Bot activity', message.slice(0, 1900), 0x2b3e50), allowedMentions: { parse: [] } });
      return true;
    } catch {
      console.error('Board notice delivery failed.');
      return false;
    }
  }

  async function currentMember(id) { return guild.members.fetch({ user: id, force: true }); }
  const isBoard = member => member.roles.cache.has(server.roles.board);
  const isLead = member => member.roles.cache.has(server.roles.teamLead);
  const leadsFor = member => Object.entries(server.teams).filter(([, team]) => team.leadIds.includes(member.id)).map(([name]) => name);
  const canAnnounce = (member, team) => isBoard(member) || (isLead(member) && leadsFor(member).includes(team));

  const rosterChoices = person => ({
    teams: rosterTeams(person, Object.keys(server.teams)),
    functions: rosterFunctions(person, Object.keys(server.functions)),
    year: server.years[person.year] ? person.year : '',
  });

  function setOrdinaryRoles(member, chosen) {
    const desired = [server.roles.member,
      ...chosen.teams.map(name => server.teams[name].roleId),
      ...chosen.functions.map(name => server.functions[name]),
      ...(chosen.year ? [server.years[chosen.year]] : [])];
    return roleChange(member, desired, [server.roles.guest, server.roles.alumni, server.roles.member,
      ...Object.values(server.teams).map(team => team.roleId), ...Object.values(server.functions),
      ...Object.values(server.years), ...(server.revokeRoleIds || [])]);
  }

  async function guest(member) {
    if (!state.get().rolloutStartedAt || member.joinedTimestamp < state.get().rolloutStartedAt ||
        member.pending || member.roles.cache.has(server.roles.member) || member.roles.cache.has(server.roles.guest)) return;
    try {
      await member.roles.add(server.roles.guest);
      void boardNotice(`<@${member.id}> joined and received Guest access.`);
    }
    catch { await boardNotice(`Could not assign Guest to <@${member.id}>.`); }
  }

  async function startHere(interaction) {
    const link = state.linkedByDiscord(interaction.user.id);
    if (!link) {
      await interaction.reply({ flags: ephemeral, ...card('Welcome to TigerApps', 'Were you accepted into TigerApps, or are you visiting as a guest?'),
        components: [row(button('onboard:accepted', 'Accepted'), button('onboard:guest', 'Guest', ButtonStyle.Secondary))] });
      return;
    }
    await interaction.deferReply({ flags: ephemeral });
    const person = await roster.byEmail(link.email);
    if (!person) {
      await interaction.editReply(card('Roster match needed', `Your Princeton email is not on the current roster. Ask a lead in <#${server.channels.publicChat}>.`, 0xe19a35));
      return;
    }
    const member = interaction.inCachedGuild() ? interaction.member : await currentMember(interaction.user.id);
    if (!member.joinedTimestamp || member.joinedTimestamp < state.get().rolloutStartedAt) {
      await interaction.editReply(card('Your account is linked', "You've been verified in the TigerApps discord! You should have access to the correct roles and permissions; feel free to contact leadership if anything is off :)"));
      return;
    }
    const chosen = { ...rosterChoices(person), status: 'ready', expiresAt: Date.now() + 15 * 60_000 };
    state.update(data => { data.onboarding[interaction.user.id] = chosen; });
    await interaction.editReply(choiceMessage(config, chosen));
  }

  async function selection(interaction) {
    const chosen = state.get().onboarding[interaction.user.id];
    if (!chosen || chosen.status !== 'ready' || chosen.expiresAt < Date.now()) {
      await interaction.reply({ flags: ephemeral, ...card('Setup expired', 'Run `/onboard` again.', 0xe19a35) }); return;
    }
    const type = interaction.customId.slice('onboard:'.length);
    const selected = interaction.values.filter(value => value !== 'none');
    const allowed = type === 'teams' ? Object.keys(server.teams) : type === 'functions' ? Object.keys(server.functions) : Object.keys(server.years);
    if (!selected.every(value => allowed.includes(value))) throw new UserError('Invalid role selection.');
    state.update(data => {
      data.onboarding[interaction.user.id][type === 'year' ? 'year' : type] = type === 'year' ? selected[0] || '' : selected;
    });
    await interaction.update(choiceMessage(config, state.get().onboarding[interaction.user.id]));
  }

  async function confirmOnboarding(interaction) {
    const chosen = state.get().onboarding[interaction.user.id];
    const link = state.linkedByDiscord(interaction.user.id);
    if (!chosen || chosen.status !== 'ready' || chosen.expiresAt < Date.now() || !link) {
      await interaction.update({ ...card('Setup expired', 'Run `/onboard` again.', 0xe19a35), components: [] }); return;
    }
    const claimed = state.update(data => {
      if (data.onboarding[interaction.user.id]?.status !== 'ready') return false;
      data.onboarding[interaction.user.id].status = 'executing';
      return true;
    });
    if (!claimed) { await interaction.reply({ flags: ephemeral, ...card('Setup in progress', 'This setup is already running.') }); return; }
    await interaction.deferUpdate();
    const person = await roster.byEmail(link.email);
    if (!person) { await interaction.editReply({ ...card('Roster match needed', 'You are no longer on the roster. Ask a lead for help.', 0xe19a35), components: [] }); return; }
    const member = await currentMember(interaction.user.id);
    if (isBoard(member) || member.id === guild.ownerId) {
      await interaction.editReply({ ...card('Account linked', 'The server owner manages Board roles.'), components: [] }); return;
    }
    try {
      await setOrdinaryRoles(member, chosen);
    } catch {
      await boardNotice(`Could not finish ordinary role assignment for <@${member.id}>. Check the current role mapping and hierarchy.`);
      await interaction.editReply({ ...card('Role setup needs help', 'Please ask Board in the public chat.', 0xe19a35), components: [] });
      return;
    }
    state.update(data => { delete data.onboarding[interaction.user.id]; });
    const originalTeams = rosterTeams(person, Object.keys(server.teams));
    const unmapped = person.team.split(',').map(value => value.trim()).filter(value =>
      value && !server.teams[value] && !['Board', 'Club-wide', 'Courses Ecosystem', 'TBA', 'Ungrouped'].includes(value));
    if (unmapped.length || (person.year && !server.years[person.year])) {
      await boardNotice(`Roster mapping needs review for <@${member.id}>: ${unmapped.join(', ') || 'team mapped'}, year ${person.year || 'missing'}.`);
    }
    for (const name of chosen.teams.filter(team => !originalTeams.includes(team))) {
      const team = server.teams[name];
      if (!team.leadIds.length) await boardNotice(`No team lead is configured for ${name}; review <@${member.id}>'s selected team.`);
      try {
        const mentions = [member.id, ...team.leadIds];
        await (await client.channels.fetch(team.channelId)).send({
          ...card('Team assignment to review', `${name} was selected during onboarding, but the roster lists a different team.`, 0xe19a35),
          content: mentions.map(id => `<@${id}>`).join(' '),
          allowedMentions: { users: mentions },
        });
      } catch { await boardNotice(`Could not post the team-selection notice for <@${member.id}> in ${name}.`); }
    }
    await interaction.editReply({ content: null, embeds: [rolesCard(`Welcome, ${person.name}`, `You're set. See <#${server.channels.announcements}> and your selected team channels.`, chosen)], components: [] });
    void boardNotice(`<@${member.id}> completed onboarding as ${link.email}.`);
  }

  function saveAction(actorId, action) {
    const id = nonce();
    state.update(data => { data.actions[id] = { ...action, actorId, status: action.status || 'ready', expiresAt: Date.now() + 10 * 60_000 }; });
    return id;
  }

  function confirmButtons(id, extra) {
    return [row(button(`confirm:${id}`, 'Confirm'), ...(extra ? [extra] : []),
      button(`cancel:${id}`, 'Cancel', ButtonStyle.Secondary))];
  }

  async function command(interaction) {
    if (interaction.commandName === 'onboard') {
      const target = interaction.options.getUser('member');
      const email = interaction.options.getString('email')?.trim().toLowerCase();
      if (!target && !email) return startHere(interaction);
      if (!target || !email) throw new UserError('Provide both a Discord member and roster email.');
      if (!interaction.inCachedGuild() || !isBoard(interaction.member)) throw new UserError('Only Board can onboard another member.');
      if (target.bot) throw new UserError('/onboard is for people, not apps.');
      await interaction.deferReply({ flags: ephemeral });
      const member = interaction.options.getMember('member') || await currentMember(target.id);
      const person = await roster.byEmail(email);
      if (!person) throw new UserError('That email is not on the roster.');
      const linked = state.linkedByDiscord(target.id);
      if (linked && linked.email !== email) throw new UserError('That Discord member is linked to another roster email.');
      if (Object.values(state.get().links).some(link => link.email === email && link.discordId !== target.id)) {
        throw new UserError('That roster email is linked to another Discord member.');
      }
      const chosen = rosterChoices(person);
      const boardTarget = isBoard(member) || member.id === interaction.guild.ownerId;
      const id = saveAction(interaction.user.id, { type: 'onboard-member', targetId: target.id, email,
        roster: [person.team, person.role, person.year], boardTarget });
      await interaction.editReply({ content: null, embeds: [rolesCard(`Onboard ${person.name}`,
        `<@${target.id}> · ${email}\n${boardTarget ? 'Discord roles stay unchanged.' : 'Assign these roles?'}`, chosen)],
      allowedMentions: { parse: [] }, components: confirmButtons(id) });
      return;
    }
    if (!interaction.inCachedGuild()) throw new UserError('Server member data unavailable. Try again.');
    const actor = interaction.member;
    if (interaction.commandName === 'info') {
      if (!isBoard(actor) && !isLead(actor) && !actor.roles.cache.has(server.roles.member)) {
        throw new UserError('Only TigerApps members can use /info.');
      }
      const selectedUser = interaction.options.getUser('member');
      const suppliedEmail = interaction.options.getString('email')?.trim().toLowerCase();
      if (Boolean(selectedUser) === Boolean(suppliedEmail)) throw new UserError('Provide either a Discord member or one exact roster email.');
      const email = selectedUser ? state.linkedByDiscord(selectedUser.id)?.email : suppliedEmail;
      await interaction.deferReply({ flags: ephemeral });
      const person = email ? await roster.byEmail(email) : null;
      if (!person) throw new UserError('No linked roster member found.');
      let photo = null;
      try {
        const response = await fetch('https://tigerapps.org/members.json', { signal: AbortSignal.timeout(2500) });
        if (response.ok) photo = memberHeadshot(person, await response.json());
      } catch { /* Site photos are optional. */ }
      if (!photo) {
        const discordId = selectedUser?.id || Object.values(state.get().links).find(link => link.email === email)?.discordId;
        const user = selectedUser || (discordId ? await client.users.fetch(discordId).catch(() => null) : null);
        photo = user?.displayAvatarURL?.({ size: 256 });
      }
      await interaction.editReply({ allowedMentions: { parse: [] }, embeds: [memberInfoCard(person, photo)] });
      return;
    }
    if (interaction.commandName === 'resign') {
      if (isBoard(actor) || actor.id === guild.ownerId) throw new UserError('The server owner must handle Board resignations.');
      if (!state.linkedByDiscord(actor.id)) throw new UserError('Run /onboard and verify your Princeton account first.');
      const id = saveAction(actor.id, { type: 'resign' });
      await interaction.reply({ flags: ephemeral, ...card('Move to Alumni?', 'Your current TigerApps roles will be removed and Board will be notified. GitHub membership stays unchanged.'), components: confirmButtons(id) });
      return;
    }
    if (interaction.commandName === 'remove') {
      if (!isBoard(actor)) throw new UserError('Only Board can use /remove.');
      const target = interaction.options.getUser('member');
      if (target.bot) throw new UserError('/remove is for people, not apps.');
      await interaction.deferReply({ flags: ephemeral });
      const member = await currentMember(target.id);
      if (isBoard(member) || member.id === guild.ownerId) throw new UserError('The server owner must handle Board removals.');
      const reason = interaction.options.getString('reason').trim();
      const link = state.linkedByDiscord(target.id);
      let person = null;
      if (link) { try { person = await roster.byEmail(link.email); } catch { /* Preview can still show the Discord target. */ } }
      const id = saveAction(actor.id, { type: 'remove', targetId: target.id, reason, githubTarget: githubHandle(person?.github) });
      await interaction.editReply({ ...card(`Remove ${target.username}?`, `Discord club roles and GitHub organization membership will be removed.\nGitHub: ${githubHandle(person?.github) || 'Board follow-up needed'}\nReason: ${reason}\nPrivate fork access also ends.`), components: confirmButtons(id) });
      return;
    }
    if (interaction.commandName === 'github-invite') {
      if (!isBoard(actor) && !isLead(actor)) throw new UserError('Only Board and Team Leads can invite members.');
      const email = interaction.options.getString('email')?.trim().toLowerCase();
      const input = interaction.options.getString('username')?.trim();
      if (Boolean(email) === Boolean(input)) throw new UserError('Provide either an email or GitHub username.');
      const username = input && githubHandle(input);
      if (input && !username) throw new UserError('Invalid GitHub username.');
      await interaction.deferReply({ flags: ephemeral });
      const matches = username ? (await roster.all()).filter(row => githubHandle(row.github)?.toLowerCase() === username.toLowerCase())
        : [await roster.byEmail(email)].filter(Boolean);
      if (matches.length !== 1) throw new UserError(username ? 'GitHub username must match one roster member.' : 'That email is not on the roster.');
      const person = matches[0];
      const id = saveAction(actor.id, { type: 'github-invite', email: person.email, githubTarget: githubHandle(person.github) });
      await interaction.editReply({ ...card(`Invite ${person.name}?`, `GitHub: ${githubHandle(person.github) || person.email}\nAccess begins after they accept. Organization base access is write.`), components: confirmButtons(id) });
      return;
    }
    if (interaction.commandName === 'event') {
      if (!isBoard(actor) && !isLead(actor)) throw new UserError('Only Board and Team Leads can add events.');
      await interaction.showModal(eventForm(saveAction(actor.id, { type: 'event', status: 'input' })));
      return;
    }
    if (interaction.commandName === 'announce') {
      const requested = interaction.options.getString('team');
      let team = null;
      if (isBoard(actor)) {
        team = requested || null;
      } else if (isLead(actor)) {
        const allowed = leadsFor(actor);
        if (!allowed.length) throw new UserError('Your Team Lead role is not mapped to a team yet.');
        team = requested || (allowed.length === 1 ? allowed[0] : null);
        if (!team || !allowed.includes(team)) throw new UserError(`Choose one of your teams: ${allowed.join(', ')}.`);
        if (!state.linkedByDiscord(actor.id)) throw new UserError('Verify your Princeton account with /onboard before sending team email.');
      } else throw new UserError('Only Board and Team Leads can announce.');
      const id = saveAction(actor.id, { type: 'announce', team, status: 'input' });
      const modal = new ModalBuilder().setCustomId(`announce:${id}`).setTitle('TigerApps announcement');
      modal.addComponents(
        row(new TextInputBuilder().setCustomId('subject').setLabel('Subject').setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(100).setRequired(true)),
        row(new TextInputBuilder().setCustomId('body').setLabel('Message').setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(1800).setRequired(true)),
      );
      await interaction.showModal(modal);
    }
  }

  async function announcementModal(interaction) {
    const id = interaction.customId.slice('announce:'.length);
    const action = state.get().actions[id];
    if (!action || action.actorId !== interaction.user.id || action.status !== 'input' || action.expiresAt < Date.now()) {
      await interaction.reply({ flags: ephemeral, ...card('Announcement expired', 'Run `/announce` again.', 0xe19a35) }); return;
    }
    await interaction.deferReply({ flags: ephemeral });
    const actor = await currentMember(interaction.user.id);
    if (!canAnnounce(actor, action.team)) throw new UserError('Announcement access changed.');
    const subject = interaction.fields.getTextInputValue('subject').trim();
    const body = interaction.fields.getTextInputValue('body').trim();
    if (!subject || !body) throw new UserError('Announcement needs a subject and message.');
    const rows = await roster.all();
    if (action.team && !rows.some(row => row.email === state.linkedByDiscord(actor.id)?.email)) {
      throw new UserError('Verify your Princeton account with /onboard before sending team email.');
    }
    const recipients = announcementRecipients(rows, action.team);
    if (!recipients.length) throw new UserError('No roster email recipients found for this announcement.');
    const to = action.team ? state.linkedByDiscord(actor.id)?.email : mailSender;
    if (!to) throw new UserError('Verify your Princeton account with /onboard first.');
    state.update(data => {
      Object.assign(data.actions[id], {
        status: 'ready', subject, body, recipientCount: recipients.length,
        recipientDigest: digest(recipients), to, cc: action.team ? mailSender : null,
      });
    });
    await interaction.editReply({ ...card('Review announcement', announcementPreview({ subject, body, team: action.team }, server, recipients.length)),
      allowedMentions: { parse: [] }, components: confirmButtons(id, button(`test:${id}`, 'Send test', ButtonStyle.Secondary)) });
  }

  async function eventModal(interaction) {
    const id = interaction.customId.slice('event:'.length);
    const action = state.get().actions[id];
    const respond = message => interaction.isFromMessage() ? interaction.update(message) : interaction.reply({ flags: ephemeral, ...message });
    if (!action || action.actorId !== interaction.user.id || action.status !== 'input' || action.expiresAt < Date.now()) {
      await respond({ ...card('Event expired', 'Run `/event` again.', 0xe19a35), components: [] }); return;
    }
    const input = Object.fromEntries(['title', 'date', 'time', 'location'].map(name => [name, interaction.fields.getTextInputValue(name).trim()]));
    input.repeat = interaction.fields.getRadioGroup('repeat') || '0';
    let details;
    try {
      if (!input.title || !input.location) throw new Error('The event needs a title and location.');
      details = { title: input.title, location: input.location, repeat: Number(input.repeat), ...parseWhen(input.date, input.time) };
    } catch (error) {
      state.update(data => { data.actions[id].input = input; });
      await respond({ ...card('Check the event', error.message, 0xe19a35), components: [row(button(`edit:${id}`, 'Edit'))] });
      return;
    }
    state.update(data => { Object.assign(data.actions[id], { ...details, input, status: 'ready' }); });
    await respond({ ...card(details.title, eventSummary(details)), components: confirmButtons(id, button(`edit:${id}`, 'Edit', ButtonStyle.Secondary)) });
  }

  async function editEvent(interaction) {
    const id = interaction.customId.slice('edit:'.length);
    const action = state.get().actions[id];
    if (!action || action.actorId !== interaction.user.id || !['input', 'ready'].includes(action.status) || action.expiresAt < Date.now()) {
      await interaction.reply({ flags: ephemeral, ...card('Event expired', 'Run `/event` again.', 0xe19a35) }); return;
    }
    state.update(data => { Object.assign(data.actions[id], { status: 'input', expiresAt: Date.now() + 10 * 60_000 }); });
    await interaction.showModal(eventForm(id, action.input));
  }

  async function testAnnouncement(interaction) {
    const action = state.get().actions[interaction.customId.slice('test:'.length)];
    if (!action || action.actorId !== interaction.user.id || action.status !== 'ready' || action.expiresAt < Date.now()) {
      await interaction.reply({ flags: ephemeral, ...card('Announcement expired', 'Run `/announce` again.', 0xe19a35) }); return;
    }
    await interaction.deferReply({ flags: ephemeral });
    const actor = await currentMember(interaction.user.id);
    if (!canAnnounce(actor, action.team)) throw new UserError('Your command access changed.');
    const rows = await roster.all();
    if (action.team && !rows.some(row => row.email === state.linkedByDiscord(actor.id)?.email)) {
      throw new UserError('Your Princeton roster access changed.');
    }
    const recipients = new Set(announcementRecipients(rows, action.team));
    const people = rows.filter(row => recipients.has(row.email)).map(row => `${row.name} <${row.email}>`);
    const to = state.linkedByDiscord(interaction.user.id)?.email || mailSender;
    await mailer.send({ subject: `[Test] ${action.subject}`, to,
      body: `${action.body}\n\n---\nTest only. Real recipients (${people.length}):\n${people.join('\n')}` });
    await interaction.editReply(card('Test sent', `Check ${to}, then confirm when it looks right.`));
  }

  async function resign(actorId) {
    const member = await currentMember(actorId);
    if (isBoard(member) || member.id === guild.ownerId) throw new Error('Board roles require server-owner action.');
    const link = state.linkedByDiscord(actorId);
    if (!link) throw new Error('Princeton account is no longer linked.');
    let roles = 'Discord roles changed';
    try {
      await roleChange(member, [server.roles.alumni], managedRoleIds(server).filter(id => id !== server.roles.board));
    } catch { roles = 'Discord role change failed'; }
    let flagged = 'Status Review checked';
    try {
      const person = await roster.byEmail(link.email);
      if (person) await roster.flag(person);
      else flagged = 'No roster row; Board must review';
    } catch { flagged = 'Roster flag failed; Board must review'; }
    const notice = await boardNotice(`<@${actorId}> resigned. ${roles}; ${flagged}. GitHub membership was not changed. Board should update the roster.`);
    return `${roles}. ${flagged}. ${notice ? 'Board notified.' : 'Board notice failed; please contact Board.'}`;
  }

  async function onboardMember(action) {
    const person = await roster.byEmail(action.email);
    if (!person || JSON.stringify([person.team, person.role, person.year]) !== JSON.stringify(action.roster)) {
      return 'The roster changed since preview. Run /onboard again.';
    }
    const member = await currentMember(action.targetId);
    if (member.user.bot) return 'Apps cannot be onboarded.';
    const boardTarget = isBoard(member) || member.id === guild.ownerId;
    if (boardTarget !== action.boardTarget) return 'Discord roles changed since preview. Run /onboard again.';
    const linked = state.linkedByDiscord(member.id);
    if (linked && linked.email !== person.email) return 'That Discord member is linked to another roster email.';
    if (!linked) {
      try { state.link(`board:${person.email}`, person.email, member.id); }
      catch { return 'Account link failed; check for another Discord account linked to this roster email.'; }
    }
    let roles = 'Discord roles unchanged';
    let ready = true;
    if (!boardTarget) {
      try { await setOrdinaryRoles(member, rosterChoices(person)); roles = 'Ordinary roles assigned'; }
      catch { roles = 'Discord role change failed; Board must review'; ready = false; }
    }
    const notice = await boardNotice(`<@${action.actorId}> onboarded <@${member.id}> as ${person.email}. ${roles}.`);
    let dm = 'DM not sent while roles need review.';
    if (ready) {
      try { await member.user.send(assistedOnboardingDm(member, action.actorId, server, !boardTarget)); dm = 'DM sent.'; }
      catch { dm = 'DM unavailable; tell the member directly.'; await boardNotice(`Could not DM <@${member.id}> after Board onboarding.`); }
    }
    return `Linked ${person.name} to ${person.email}. ${roles}. ${dm} ${notice ? 'Board log updated.' : 'Board log failed; notify Board.'}`;
  }

  async function remove(action) {
    const member = await currentMember(action.targetId);
    if (isBoard(member) || member.id === guild.ownerId) throw new Error('Board roles require server-owner action.');
    const link = state.linkedByDiscord(member.id);
    let person = null;
    let lookup = '';
    if (link) { try { person = await roster.byEmail(link.email); } catch { lookup = 'Roster lookup failed'; } }
    let roles = 'Discord roles changed';
    try { await roleChange(member, [server.roles.guest], managedRoleIds(server).filter(id => id !== server.roles.board)); }
    catch { roles = 'Discord role change failed'; }
    let flagged = person ? 'Status Review checked' : lookup || 'No linked roster row';
    if (person) { try { await roster.flag(person); } catch { flagged = 'Roster flag failed'; } }
    let githubResult = 'GitHub account not identified; Board must check manually';
    if (person && githubHandle(person.github) !== action.githubTarget) githubResult = 'GitHub target changed since preview; Board must check manually';
    else if (person) { try { githubResult = await github.remove(person); } catch { githubResult = 'GitHub removal failed; Board must check manually'; } }
    const notice = await boardNotice(`Removal requested by <@${action.actorId}> for <@${member.id}>. Reason: ${action.reason}. ${roles}; ${flagged}; ${githubResult}. Update the roster to prevent re-onboarding or re-invitation.`);
    return `${roles}. ${flagged}. ${githubResult}. ${notice ? 'Board notified.' : 'Board notice failed; notify Board manually.'}`;
  }

  async function invite(action) {
    const person = await roster.byEmail(action.email);
    if (!person) return 'This person is no longer on the roster; no invitation was sent.';
    if (githubHandle(person.github) !== action.githubTarget) return 'The roster GitHub target changed since preview. Run /github-invite again.';
    const result = await github.invite(person);
    await boardNotice(`<@${action.actorId}> used /github-invite for ${person.email}: ${result}`);
    return result;
  }

  async function announce(id, action) {
    const recipients = announcementRecipients(await roster.all(), action.team);
    if (digest(recipients) !== action.recipientDigest) return { status: 'done', message: 'The roster changed since preview. Run /announce again.' };
    const channelId = action.team ? server.teams[action.team].channelId : server.channels.announcements;
    const channel = await client.channels.fetch(channelId);
    const sent = await channel.send(announcementPost(action, server));
    state.update(data => { data.actions[id].messageId = sent.id; data.actions[id].status = 'sending'; });
    try {
      const gmailId = await mailer.send({ subject: action.subject, body: action.body, to: action.to, cc: action.cc,
        bcc: recipients, discordUrl: `https://discord.com/channels/${server.guildId}/${channelId}/${sent.id}` });
      state.update(data => { data.actions[id].gmailId = gmailId; });
      await boardNotice(`<@${action.actorId}> announced to ${action.team || 'club-wide'}: Discord and ${recipients.length} BCC email recipients sent.`);
      return { status: 'done', message: `Posted in <#${channelId}> and emailed ${recipients.length} roster members.` };
    } catch {
      await boardNotice(`Announcement by <@${action.actorId}> posted in <#${channelId}>, but Gmail's outcome is uncertain. Check the TigerApps Sent mailbox before any retry.`);
      return { status: 'uncertain', message: `Posted in <#${channelId}>. Email outcome is uncertain; check the TigerApps Sent mailbox before retrying.` };
    }
  }

  async function addEvent(action) {
    if (easternInstant(action.date, action.start) <= new Date()) {
      return { status: 'ready', message: 'That start time has passed. Edit the event to pick a new time.', components: [row(button(`edit:${action.id}`, 'Edit'))] };
    }
    const created = await calendar.create(calendarEvent(action));
    let discord = 'It is also in the server events.';
    let failure = '';
    try {
      const scheduled = await guild.scheduledEvents.create(discordEvent(action));
      if (action.repeat) state.update(data => { (data.discordSeries ??= {})[scheduled.id] = discordSeries(action); });
    }
    catch (error) { discord = 'The Discord event could not be created; Board has been notified.'; failure = ` Discord event failed: ${error.message}`; }
    await boardNotice(`<@${action.actorId}> added "${action.title}" to the TigerApps calendar.${failure}`);
    return { status: 'done', message: `Added to the TigerApps calendar. ${discord}`,
      components: [row(new ButtonBuilder().setLabel('Open in Google Calendar').setStyle(ButtonStyle.Link).setURL(created.htmlLink))] };
  }

  async function actionButton(interaction) {
    const [verb, id] = interaction.customId.split(':');
    const action = state.get().actions[id];
    if (!action || action.actorId !== interaction.user.id || action.expiresAt < Date.now()) {
      await interaction.reply({ flags: ephemeral, ...card('Confirmation expired', 'Run the command again.', 0xe19a35) }); return;
    }
    if (action.status !== 'ready') {
      await interaction.reply({ flags: ephemeral, ...card('Already started', 'Ask Board to check its result before retrying.', 0xe19a35) }); return;
    }
    if (verb === 'cancel') {
      state.update(data => { delete data.actions[id]; });
      await interaction.update({ ...card('Cancelled', 'No changes were made.'), components: [] }); return;
    }
    await interaction.deferUpdate();
    const actor = await currentMember(interaction.user.id);
    if ((['remove', 'onboard-member'].includes(action.type) && !isBoard(actor)) ||
        (['github-invite', 'event'].includes(action.type) && !isBoard(actor) && !isLead(actor)) ||
        (action.type === 'announce' && !canAnnounce(actor, action.team))) {
      throw new UserError('Your command access changed.');
    }
    if (action.type === 'announce' && action.team && !(await roster.byEmail(state.linkedByDiscord(actor.id)?.email || ''))) {
      throw new UserError('Your Princeton roster access changed.');
    }
    const claimed = state.update(data => {
      if (data.actions[id]?.status !== 'ready') return false;
      data.actions[id].status = 'executing';
      return true;
    });
    if (!claimed) {
      await interaction.followUp({ flags: ephemeral, ...card('Already handled', 'This action was cancelled or already started. Run the command again if needed.', 0xe19a35) }); return;
    }
    try {
      let result;
      if (action.type === 'resign') result = { status: 'done', message: await resign(interaction.user.id) };
      if (action.type === 'onboard-member') result = { status: 'done', message: await onboardMember(action) };
      if (action.type === 'remove') result = { status: 'done', message: await remove(action) };
      if (action.type === 'github-invite') result = { status: 'done', message: await invite(action) };
      if (action.type === 'announce') result = await announce(id, action);
      if (action.type === 'event') result = await addEvent({ ...action, id });
      state.update(data => { data.actions[id].status = result.status; });
      await interaction.editReply({ ...card(result.status === 'uncertain' ? 'Needs review' : 'Update', result.message,
        result.status === 'uncertain' ? 0xe19a35 : accent), components: result.components || [] });
    } catch (error) {
      state.update(data => { data.actions[id].status = 'uncertain'; });
      await boardNotice(`Action ${action.type} requested by <@${action.actorId}> had an uncertain result (${error.message}). Check Discord, roster, GitHub, or Gmail before repeating it.`);
      const response = card('Needs review', 'Board has been notified. Check the outcome before retrying.', 0xe19a35);
      if (interaction.deferred) await interaction.editReply({ ...response, components: [] });
      else await interaction.reply({ flags: ephemeral, ...response });
    }
  }

  async function onInteraction(interaction) {
    if (interaction.guildId !== server.guildId) return;
    try {
      if (interaction.isChatInputCommand()) {
        try { await command(interaction); }
        finally { void boardNotice(`<@${interaction.user.id}> invoked /${interaction.commandName}.`); }
      }
      else if (interaction.isModalSubmit() && interaction.customId.startsWith('announce:')) await announcementModal(interaction);
      else if (interaction.isModalSubmit() && interaction.customId.startsWith('event:')) await eventModal(interaction);
      else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('onboard:')) await selection(interaction);
      else if (interaction.isButton()) {
        if (interaction.customId === 'onboard:start') await startHere(interaction);
        else if (interaction.customId === 'onboard:guest') {
          await interaction.deferUpdate();
          await guest(await currentMember(interaction.user.id));
          await interaction.editReply({ ...card('Welcome to TigerApps', `Use <#${server.channels.publicChat}> to chat or ask for roster help.`), components: [] });
          void boardNotice(`<@${interaction.user.id}> chose Guest access.`);
        } else if (interaction.customId === 'onboard:accepted') {
          const url = oauth.start(interaction.user.id);
          await interaction.update({ ...card('Verify your account', 'Sign in with Discord and Princeton to continue.'),
            components: [row(new ButtonBuilder().setLabel('Verify').setStyle(ButtonStyle.Link).setURL(url))] });
        } else if (interaction.customId === 'onboard:confirm') await confirmOnboarding(interaction);
        else if (interaction.customId.startsWith('test:')) await testAnnouncement(interaction);
        else if (interaction.customId.startsWith('edit:')) await editEvent(interaction);
        else if (interaction.customId.startsWith('confirm:') || interaction.customId.startsWith('cancel:')) await actionButton(interaction);
      }
    } catch (error) {
      if (!(error instanceof UserError)) {
        console.error(`Interaction failed: ${error.message}`);
        const source = interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.customId.split(':')[0];
        void boardNotice(`${source} failed for <@${interaction.user.id}>: ${error.message}`);
      }
      const safe = error instanceof UserError ? error.message : failureMessage(error);
      try {
        const response = card('Could not complete', safe, 0xe19a35);
        if (interaction.deferred && (interaction.isModalSubmit() || interaction.isChatInputCommand() || ['onboard:start', 'onboard:guest'].includes(interaction.customId) || interaction.customId.startsWith('test:'))) await interaction.editReply({ ...response, components: [] });
        else if (interaction.deferred || interaction.replied) await interaction.followUp({ flags: ephemeral, ...response });
        else await interaction.reply({ flags: ephemeral, ...response });
      } catch { console.error('Could not report an interaction error to Discord.'); }
    }
  }

  async function checkMissingRoster() {
    const current = new Set((await roster.all()).map(person => person.email));
    const missing = [...new Set(Object.values(state.get().links).map(link => link.email).filter(email => !current.has(email)))].sort();
    const newMissing = missing.filter(email => !state.get().missingRoster.includes(email));
    if (newMissing.length && !(await boardNotice(`Linked Princeton emails missing from the roster: ${newMissing.join(', ')}. Review their Discord access manually.`))) return;
    state.update(data => { data.missingRoster = missing; });
  }

  async function shareCalendar() {
    const members = announcementRecipients(await roster.all(), null);
    const writers = [...new Set((await guild.members.fetch()).filter(member => isBoard(member) || isLead(member))
      .map(member => state.linkedByDiscord(member.id)?.email).filter(email => members.includes(email)))];
    const readers = members.filter(email => !writers.includes(email));
    const { added, changed, removed } = await calendar.share(readers, writers);
    if (added + changed + removed) await boardNotice(`Calendar sharing updated: ${added} added, ${changed} changed, ${removed} removed.`);
  }

  const discordSeries = ({ title, location, date, start, end, repeat }) => ({ title, location, date, start, end, repeat, until: semesterEnd(date) });

  // Discord repeats in UTC and cannot end a series so each occurrence is posted once the previous one is over
  async function postNextOccurrences() {
    for (const [id, series] of Object.entries(state.get().discordSeries || {})) {
      if (easternInstant(series.date, series.end) > new Date()) continue;
      let date = nextOccurrence(series.date, series.repeat);
      // skips occurrences missed while the bot was offline
      while (easternInstant(date, series.start) <= new Date()) date = nextOccurrence(date, series.repeat);
      const next = date <= series.until ? await guild.scheduledEvents.create(discordEvent({ ...series, date })) : null;
      state.update(data => {
        delete data.discordSeries[id];
        if (next) data.discordSeries[next.id] = { ...series, date };
      });
    }
  }

  async function ready() {
    guild = await client.guilds.fetch(server.guildId);
    await guild.roles.fetch();
    await guild.channels.fetch();
    const ids = [server.roles.board, ...managedRoleIds(server)];
    for (const id of ids) if (!guild.roles.cache.has(id)) throw new Error(`Configured Discord role ${id} is missing.`);
    for (const id of [
      ...Object.values(server.channels), ...Object.values(server.teams).map(team => team.channelId),
    ]) if (!guild.channels.cache.has(id)) throw new Error(`Configured Discord channel ${id} is missing.`);
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles) ||
        managedRoleIds(server).some(id => me.roles.highest.comparePositionTo(guild.roles.cache.get(id)) <= 0) ||
        guild.roles.cache.get(server.roles.board).comparePositionTo(me.roles.highest) <= 0) {
      throw new Error('Place the bot above every managed role and below Board with Manage Roles.');
    }
    for (const id of [server.channels.startHere, server.channels.announcements, server.channels.boardLog,
      ...Object.values(server.teams).map(team => team.channelId)]) {
      const channel = guild.channels.cache.get(id);
      if (!channel?.isTextBased() || !channel.send || !channel.permissionsFor(me)?.has([
        PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.EmbedLinks,
      ])) throw new Error(`Bot needs text-channel access in ${id}.`);
    }
    if (!state.get().rolloutStartedAt) state.update(data => { data.rolloutStartedAt = Date.now(); });
    await guild.commands.set(commands(config));
    const channel = guild.channels.cache.get(server.channels.startHere);
    const welcome = { content: 'Welcome to TigerApps! Complete your onboarding here :)',
      components: [row(button('onboard:start', 'Get started'))] };
    let panel = null;
    if (state.get().panelId) {
      try { panel = await channel.messages.fetch(state.get().panelId); } catch { /* Post one replacement. */ }
    }
    if (!panel) {
      panel = await channel.send(welcome);
      state.update(data => { data.panelId = panel.id; });
    } else if (panel.content !== welcome.content) await panel.edit(welcome);
    state.cleanExpired();
    for (const [id, action] of Object.entries(state.get().actions)) {
      if (['executing', 'sending', 'uncertain'].includes(action.status) && !action.recoveryNotifiedAt) {
        if (await boardNotice(`Bot restart found an unfinished ${action.type} action (${id}) by <@${action.actorId}>. Check its external results before retrying.`)) {
          state.update(data => { data.actions[id].recoveryNotifiedAt = Date.now(); });
        }
      }
    }
    try { await checkMissingRoster(); } catch { console.error('Initial roster review failed.'); }
    const calendarUpkeep = () => {
      shareCalendar().catch(error => boardNotice(`Calendar sharing failed: ${error.message}`));
      postNextOccurrences().catch(error => boardNotice(`Posting the next Discord event failed: ${error.message}`));
    };
    calendarUpkeep();
    setInterval(() => { state.cleanExpired(); checkMissingRoster().catch(() => console.error('Roster review failed.')); calendarUpkeep(); }, 24 * 60 * 60_000).unref();
    console.log('TigerApps bot ready.');
  }

  client.once(Events.ClientReady, () => ready().catch(error => { console.error(`Startup failed: ${error.message}`); client.destroy(); process.exit(1); }));
  client.on(Events.GuildMemberAdd, member => { if (member.guild.id === server.guildId) guest(member).catch(() => console.error('Guest assignment failed.')); });
  client.on(Events.GuildMemberUpdate, (before, after) => {
    if (after.guild.id === server.guildId && before.pending && !after.pending) guest(after).catch(() => console.error('Guest assignment failed.'));
  });
  client.on(Events.InteractionCreate, onInteraction);
  client.on('error', error => console.error(`Discord connection error: ${error.message}`));
  return { client, oauth };
}
