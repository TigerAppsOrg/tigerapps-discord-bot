import { createHash, randomBytes } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits,
  MessageFlags, ModalBuilder, PermissionsBitField, SlashCommandBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { managedRoleIds } from './config.js';
import { announcementRecipients, githubHandle, mailSender } from './integrations.js';
import { createOAuth } from './oauth.js';
import { rosterFunctions, rosterTeams } from './roster.js';

const ephemeral = MessageFlags.Ephemeral;
const nonce = () => randomBytes(16).toString('hex');
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, label, style = ButtonStyle.Primary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const digest = emails => createHash('sha256').update(emails.join('\n')).digest('hex');

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
    content: `Confirm your roles.\nTeam: ${chosen.teams.join(', ') || 'None'}\nRole: ${chosen.functions.join(', ') || 'None'}\nYear: ${chosen.year || 'None'}\nYour choices determine ordinary channel access.`,
    components: [
      select('onboard:teams', 'Team', teams, chosen.teams),
      select('onboard:functions', 'Role', functions, chosen.functions),
      select('onboard:year', 'Class year', years, chosen.year ? [chosen.year] : [], false),
      row(button('onboard:confirm', 'Confirm')),
    ],
  };
}

export function announcementPost(action, server) {
  const roleId = server.teams[action.team || 'TigerOps'].roleId;
  return { content: `**${action.subject}**\n${action.body}\n\n<@&${roleId}>`,
    allowedMentions: { parse: [], roles: [roleId] } };
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
    new SlashCommandBuilder().setName('info').setDescription('Look up a roster member privately')
      .addUserOption(option => option.setName('member').setDescription('Linked Discord member'))
      .addStringOption(option => option.setName('email').setDescription('Exact Princeton roster email')),
    new SlashCommandBuilder().setName('github-invite').setDescription('Invite a roster member to the GitHub organization')
      .addStringOption(option => option.setName('username').setDescription('GitHub username on the Clean roster'))
      .addStringOption(option => option.setName('email').setDescription('Exact Princeton roster email')),
  ].map(command => command.toJSON());
}

export async function roleChange(member, desired, revoke) {
  const roles = [...new Set([...member.roles.cache.keys()]
    .filter(id => id !== member.guild.id && !revoke.includes(id)).concat(desired))];
  await member.roles.set(roles);
}

export function createBot(config, state, roster, github, mailer) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const oauth = createOAuth(config, state, roster, client, boardNotice);
  const { server } = config;
  let guild;

  async function boardNotice(message) {
    try {
      const channel = await client.channels.fetch(server.channels.boardLog);
      await channel.send({ content: message.slice(0, 1900), allowedMentions: { parse: [] } });
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
      await interaction.reply({ flags: ephemeral, content: 'Were you accepted into TigerApps, or are you visiting as a guest?',
        components: [row(button('onboard:accepted', 'Accepted'), button('onboard:guest', 'Guest', ButtonStyle.Secondary))] });
      return;
    }
    await interaction.deferReply({ flags: ephemeral });
    const person = await roster.byEmail(link.email);
    if (!person) {
      await interaction.editReply({ content: `Your Princeton email is not on the current roster. Ask a lead in <#${server.channels.publicChat}>.` });
      return;
    }
    const member = interaction.inCachedGuild() ? interaction.member : await currentMember(interaction.user.id);
    if (!member.joinedTimestamp || member.joinedTimestamp < state.get().rolloutStartedAt) {
      await interaction.editReply({ content: 'Your Princeton account is linked.' });
      return;
    }
    const chosen = { ...rosterChoices(person), status: 'ready', expiresAt: Date.now() + 15 * 60_000 };
    state.update(data => { data.onboarding[interaction.user.id] = chosen; });
    await interaction.editReply(choiceMessage(config, chosen));
  }

  async function selection(interaction) {
    const chosen = state.get().onboarding[interaction.user.id];
    if (!chosen || chosen.status !== 'ready' || chosen.expiresAt < Date.now()) {
      await interaction.reply({ flags: ephemeral, content: 'This setup expired. Run /onboard again.' }); return;
    }
    const type = interaction.customId.slice('onboard:'.length);
    const selected = interaction.values.filter(value => value !== 'none');
    const allowed = type === 'teams' ? Object.keys(server.teams) : type === 'functions' ? Object.keys(server.functions) : Object.keys(server.years);
    if (!selected.every(value => allowed.includes(value))) throw new Error('Invalid role selection.');
    state.update(data => {
      data.onboarding[interaction.user.id][type === 'year' ? 'year' : type] = type === 'year' ? selected[0] || '' : selected;
    });
    await interaction.update(choiceMessage(config, state.get().onboarding[interaction.user.id]));
  }

  async function confirmOnboarding(interaction) {
    const chosen = state.get().onboarding[interaction.user.id];
    const link = state.linkedByDiscord(interaction.user.id);
    if (!chosen || chosen.status !== 'ready' || chosen.expiresAt < Date.now() || !link) {
      await interaction.update({ content: 'This setup expired. Run /onboard again.', components: [] }); return;
    }
    const claimed = state.update(data => {
      if (data.onboarding[interaction.user.id]?.status !== 'ready') return false;
      data.onboarding[interaction.user.id].status = 'executing';
      return true;
    });
    if (!claimed) { await interaction.reply({ flags: ephemeral, content: 'This setup is already running.' }); return; }
    await interaction.deferUpdate();
    const person = await roster.byEmail(link.email);
    if (!person) { await interaction.editReply({ content: 'You are no longer on the Clean roster. Ask a lead for help.', components: [] }); return; }
    const member = await currentMember(interaction.user.id);
    if (isBoard(member) || member.id === guild.ownerId) {
      await interaction.editReply({ content: 'Your Princeton account is linked. The server owner manages Board roles.', components: [] }); return;
    }
    try {
      await setOrdinaryRoles(member, chosen);
    } catch {
      await boardNotice(`Could not finish ordinary role assignment for <@${member.id}>. Check the current role mapping and hierarchy.`);
      await interaction.editReply({ content: 'Your role setup needs Board help. Please ask in the public chat.', components: [] });
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
          content: `<@${member.id}> selected ${name}, which differs from the Clean roster. ${team.leadIds.map(id => `<@${id}>`).join(' ')} Please review the assignment.`,
          allowedMentions: { users: mentions },
        });
      } catch { await boardNotice(`Could not post the team-selection notice for <@${member.id}> in ${name}.`); }
    }
    await interaction.editReply({ content: `You're set. See <#${server.channels.announcements}> and your selected team channels.`, components: [] });
    void boardNotice(`<@${member.id}> completed onboarding as ${link.email}.`);
  }

  function saveAction(actorId, action) {
    const id = nonce();
    state.update(data => { data.actions[id] = { ...action, actorId, status: action.status || 'ready', expiresAt: Date.now() + 10 * 60_000 }; });
    return id;
  }

  function confirmButtons(id) {
    return [row(button(`confirm:${id}`, 'Confirm'), button(`cancel:${id}`, 'Cancel', ButtonStyle.Secondary))];
  }

  async function command(interaction) {
    if (interaction.commandName === 'onboard') {
      const target = interaction.options.getUser('member');
      const email = interaction.options.getString('email')?.trim().toLowerCase();
      if (!target && !email) return startHere(interaction);
      if (!target || !email) throw new Error('Provide both a Discord member and roster email.');
      if (!interaction.inCachedGuild() || !isBoard(interaction.member)) throw new Error('Only Board can onboard another member.');
      if (target.bot) throw new Error('/onboard is for people, not apps.');
      await interaction.deferReply({ flags: ephemeral });
      const member = interaction.options.getMember('member') || await currentMember(target.id);
      const person = await roster.byEmail(email);
      if (!person) throw new Error('That email is not on the Clean roster.');
      const linked = state.linkedByDiscord(target.id);
      if (linked && linked.email !== email) throw new Error('That Discord member is linked to another roster email.');
      if (Object.values(state.get().links).some(link => link.email === email && link.discordId !== target.id)) {
        throw new Error('That roster email is linked to another Discord member.');
      }
      const chosen = rosterChoices(person);
      const boardTarget = isBoard(member) || member.id === interaction.guild.ownerId;
      const roles = ['TigerApps', ...chosen.teams, ...chosen.functions, ...(chosen.year ? [chosen.year] : [])].join(', ');
      const id = saveAction(interaction.user.id, { type: 'onboard-member', targetId: target.id, email,
        roster: [person.team, person.role, person.year], boardTarget });
      await interaction.editReply({ content: `Onboard <@${target.id}> as ${person.name} (${email})?\n${boardTarget ? 'Existing Board roles stay unchanged.' : `Assign roles: ${roles}`}`,
        allowedMentions: { parse: [] }, components: confirmButtons(id) });
      return;
    }
    if (!interaction.inCachedGuild()) throw new Error('Server member data unavailable. Try again.');
    const actor = interaction.member;
    if (interaction.commandName === 'info') {
      if (!isBoard(actor) && !isLead(actor)) throw new Error('Only Board and Team Leads can use /info.');
      const selectedUser = interaction.options.getUser('member');
      const suppliedEmail = interaction.options.getString('email')?.trim().toLowerCase();
      if (Boolean(selectedUser) === Boolean(suppliedEmail)) throw new Error('Provide either a Discord member or one exact roster email.');
      const email = selectedUser ? state.linkedByDiscord(selectedUser.id)?.email : suppliedEmail;
      await interaction.deferReply({ flags: ephemeral });
      const person = email ? await roster.byEmail(email) : null;
      if (!person) throw new Error('No linked Clean-roster member found.');
      await interaction.editReply({ allowedMentions: { parse: [] }, content: [
        `Name: ${person.name}`, `Team: ${person.team}`, `Role: ${person.role}`, `Year: ${person.year}`,
        `GitHub: ${person.github || 'Not listed'}`, `Email: ${person.email}`, `Phone: ${person.phone || 'Not listed'}`,
      ].join('\n') });
      return;
    }
    if (interaction.commandName === 'resign') {
      if (isBoard(actor) || actor.id === guild.ownerId) throw new Error('The server owner must handle Board resignations.');
      if (!state.linkedByDiscord(actor.id)) throw new Error('Run /onboard and verify your Princeton account first.');
      const id = saveAction(actor.id, { type: 'resign' });
      await interaction.reply({ flags: ephemeral, content: 'Move your current TigerApps roles to Alumni? Board will be notified. GitHub membership stays unchanged.', components: confirmButtons(id) });
      return;
    }
    if (interaction.commandName === 'remove') {
      if (!isBoard(actor)) throw new Error('Only Board can use /remove.');
      const target = interaction.options.getUser('member');
      if (target.bot) throw new Error('/remove is for people, not apps.');
      await interaction.deferReply({ flags: ephemeral });
      const member = await currentMember(target.id);
      if (isBoard(member) || member.id === guild.ownerId) throw new Error('The server owner must handle Board removals.');
      const reason = interaction.options.getString('reason').trim();
      const link = state.linkedByDiscord(target.id);
      let person = null;
      if (link) { try { person = await roster.byEmail(link.email); } catch { /* Preview can still show the Discord target. */ } }
      const id = saveAction(actor.id, { type: 'remove', targetId: target.id, reason, githubTarget: githubHandle(person?.github) });
      await interaction.editReply({ content: `Remove ${target.username} from Discord club roles and attempt GitHub organization removal?\nGitHub target: ${githubHandle(person?.github) || 'not identified; Board follow-up may be needed'}\nReason: ${reason}\nRemoving GitHub membership also ends access to private forks.`, components: confirmButtons(id) });
      return;
    }
    if (interaction.commandName === 'github-invite') {
      if (!isBoard(actor) && !isLead(actor)) throw new Error('Only Board and Team Leads can invite members.');
      const email = interaction.options.getString('email')?.trim().toLowerCase();
      const input = interaction.options.getString('username')?.trim();
      if (Boolean(email) === Boolean(input)) throw new Error('Provide either an email or GitHub username.');
      const username = input && githubHandle(input);
      if (input && !username) throw new Error('Invalid GitHub username.');
      await interaction.deferReply({ flags: ephemeral });
      const matches = username ? (await roster.all()).filter(row => githubHandle(row.github)?.toLowerCase() === username.toLowerCase())
        : [await roster.byEmail(email)].filter(Boolean);
      if (matches.length !== 1) throw new Error(username ? 'GitHub username must match one Clean-roster member.' : 'That email is not on the Clean roster.');
      const person = matches[0];
      const id = saveAction(actor.id, { type: 'github-invite', email: person.email, githubTarget: githubHandle(person.github) });
      await interaction.editReply({ content: `Invite ${person.name} to TigerAppsOrg as a member?\nGitHub target: ${githubHandle(person.github) || person.email}\nThe invitation is pending until accepted. Current organization base access is write.`, components: confirmButtons(id) });
      return;
    }
    if (interaction.commandName === 'announce') {
      const requested = interaction.options.getString('team');
      let team = null;
      if (isBoard(actor)) {
        team = requested || null;
      } else if (isLead(actor)) {
        const allowed = leadsFor(actor);
        if (!allowed.length) throw new Error('Your Team Lead role is not mapped to a team yet.');
        team = requested || (allowed.length === 1 ? allowed[0] : null);
        if (!team || !allowed.includes(team)) throw new Error(`Choose one of your teams: ${allowed.join(', ')}.`);
        if (!state.linkedByDiscord(actor.id)) throw new Error('Verify your Princeton account with /onboard before sending team email.');
      } else throw new Error('Only Board and Team Leads can announce.');
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
      await interaction.reply({ flags: ephemeral, content: 'That announcement expired. Run /announce again.' }); return;
    }
    await interaction.deferReply({ flags: ephemeral });
    const actor = await currentMember(interaction.user.id);
    if (!isBoard(actor) && (!isLead(actor) || !leadsFor(actor).includes(action.team))) throw new Error('Announcement access changed.');
    const subject = interaction.fields.getTextInputValue('subject').trim();
    const body = interaction.fields.getTextInputValue('body').trim();
    if (!subject || !body) throw new Error('Announcement needs a subject and message.');
    const rows = await roster.all();
    if (action.team && !rows.some(row => row.email === state.linkedByDiscord(actor.id)?.email)) {
      throw new Error('Verify your Princeton account with /onboard before sending team email.');
    }
    const recipients = announcementRecipients(rows, action.team);
    if (!recipients.length) throw new Error('No roster email recipients found for this announcement.');
    const to = action.team ? state.linkedByDiscord(actor.id)?.email : mailSender;
    if (!to) throw new Error('Verify your Princeton account with /onboard first.');
    state.update(data => {
      Object.assign(data.actions[id], {
        status: 'ready', subject, body, recipientCount: recipients.length,
        recipientDigest: digest(recipients), to, cc: action.team ? mailSender : null,
      });
    });
    const destination = action.team ? `${action.team} team channel` : 'club announcements';
    await interaction.editReply({ content: `Preview for ${destination} and ${recipients.length} hidden email recipients:\n\n${announcementPost({ subject, body, team: action.team }, server).content}`,
      allowedMentions: { parse: [] }, components: confirmButtons(id) });
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
      else flagged = 'No Clean-roster row; Board must review';
    } catch { flagged = 'Roster flag failed; Board must review'; }
    const notice = await boardNotice(`<@${actorId}> resigned. ${roles}; ${flagged}. GitHub membership was not changed. Board should update the Clean roster.`);
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
    let roles = 'Existing Board roles unchanged';
    if (!boardTarget) {
      try { await setOrdinaryRoles(member, rosterChoices(person)); roles = 'Ordinary roles assigned'; }
      catch { roles = 'Discord role change failed; Board must review'; }
    }
    const notice = await boardNotice(`<@${action.actorId}> onboarded <@${member.id}> as ${person.email}. ${roles}.`);
    return `Linked ${person.name} to ${person.email}. ${roles}. ${notice ? 'Board log updated.' : 'Board log failed; notify Board.'}`;
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
    let flagged = person ? 'Status Review checked' : lookup || 'No linked Clean-roster row';
    if (person) { try { await roster.flag(person); } catch { flagged = 'Roster flag failed'; } }
    let githubResult = 'GitHub account not identified; Board must check manually';
    if (person && githubHandle(person.github) !== action.githubTarget) githubResult = 'GitHub target changed since preview; Board must check manually';
    else if (person) { try { githubResult = await github.remove(person); } catch { githubResult = 'GitHub removal failed; Board must check manually'; } }
    const notice = await boardNotice(`Removal requested by <@${action.actorId}> for <@${member.id}>. Reason: ${action.reason}. ${roles}; ${flagged}; ${githubResult}. Update the Clean roster to prevent re-onboarding or re-invitation.`);
    return `${roles}. ${flagged}. ${githubResult}. ${notice ? 'Board notified.' : 'Board notice failed; notify Board manually.'}`;
  }

  async function invite(action) {
    const person = await roster.byEmail(action.email);
    if (!person) return 'This person is no longer on the Clean roster; no invitation was sent.';
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
      const gmailId = await mailer.send({ subject: action.subject, body: action.body, to: action.to, cc: action.cc, bcc: recipients });
      state.update(data => { data.actions[id].gmailId = gmailId; });
      await boardNotice(`<@${action.actorId}> announced to ${action.team || 'club-wide'}: Discord and ${recipients.length} BCC email recipients sent.`);
      return { status: 'done', message: `Posted in <#${channelId}> and emailed ${recipients.length} roster members.` };
    } catch {
      await boardNotice(`Announcement by <@${action.actorId}> posted in <#${channelId}>, but Gmail's outcome is uncertain. Check the TigerApps Sent mailbox before any retry.`);
      return { status: 'uncertain', message: `Posted in <#${channelId}>. Email outcome is uncertain; check the TigerApps Sent mailbox before retrying.` };
    }
  }

  async function actionButton(interaction) {
    const [verb, id] = interaction.customId.split(':');
    const action = state.get().actions[id];
    if (!action || action.actorId !== interaction.user.id || action.expiresAt < Date.now()) {
      await interaction.reply({ flags: ephemeral, content: 'This confirmation expired. Run the command again.' }); return;
    }
    if (action.status !== 'ready') {
      await interaction.reply({ flags: ephemeral, content: 'This action has already started. Ask Board to check its result before retrying.' }); return;
    }
    if (verb === 'cancel') {
      state.update(data => { delete data.actions[id]; });
      await interaction.update({ content: 'Cancelled.', components: [] }); return;
    }
    await interaction.deferUpdate();
    const actor = await currentMember(interaction.user.id);
    if ((['remove', 'onboard-member'].includes(action.type) && !isBoard(actor)) ||
        (action.type === 'github-invite' && !isBoard(actor) && !isLead(actor)) ||
        (action.type === 'announce' && !isBoard(actor) && (!isLead(actor) || !leadsFor(actor).includes(action.team)))) {
      throw new Error('Your command access changed.');
    }
    if (action.type === 'announce' && action.team && !(await roster.byEmail(state.linkedByDiscord(actor.id)?.email || ''))) {
      throw new Error('Your Princeton roster access changed.');
    }
    const claimed = state.update(data => {
      if (data.actions[id]?.status !== 'ready') return false;
      data.actions[id].status = 'executing';
      return true;
    });
    if (!claimed) {
      await interaction.followUp({ flags: ephemeral, content: 'This action was cancelled or already started. Run the command again if needed.' }); return;
    }
    try {
      let result;
      if (action.type === 'resign') result = { status: 'done', message: await resign(interaction.user.id) };
      if (action.type === 'onboard-member') result = { status: 'done', message: await onboardMember(action) };
      if (action.type === 'remove') result = { status: 'done', message: await remove(action) };
      if (action.type === 'github-invite') result = { status: 'done', message: await invite(action) };
      if (action.type === 'announce') result = await announce(id, action);
      state.update(data => { data.actions[id].status = result.status; });
      await interaction.editReply({ content: result.message, components: [] });
    } catch {
      state.update(data => { data.actions[id].status = 'uncertain'; });
      await boardNotice(`Action ${action.type} requested by <@${action.actorId}> had an uncertain result. Check Discord, roster, GitHub, or Gmail before repeating it.`);
      if (interaction.deferred) await interaction.editReply({ content: 'The action needs review. Board has been notified; do not retry until its outcome is checked.', components: [] });
      else await interaction.reply({ flags: ephemeral, content: 'The action needs review. Board has been notified; do not retry until its outcome is checked.' });
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
      else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('onboard:')) await selection(interaction);
      else if (interaction.isButton()) {
        if (interaction.customId === 'onboard:start') await startHere(interaction);
        else if (interaction.customId === 'onboard:guest') {
          await guest(await currentMember(interaction.user.id));
          await interaction.update({ content: `Welcome! Use <#${server.channels.publicChat}> to chat or ask for roster help.`, components: [] });
          void boardNotice(`<@${interaction.user.id}> chose Guest access.`);
        } else if (interaction.customId === 'onboard:accepted') {
          const url = oauth.start(interaction.user.id);
          await interaction.update({ content: 'Verify your Discord and Princeton accounts to continue.',
            components: [row(new ButtonBuilder().setLabel('Verify').setStyle(ButtonStyle.Link).setURL(url))] });
        } else if (interaction.customId === 'onboard:confirm') await confirmOnboarding(interaction);
        else if (interaction.customId.startsWith('confirm:') || interaction.customId.startsWith('cancel:')) await actionButton(interaction);
      }
    } catch (error) {
      console.error(`Interaction failed: ${error.message}`);
      const safe = [
        'Only Board and Team Leads can use /info.', 'Provide either a Discord member or one exact roster email.',
        'Provide both a Discord member and roster email.', 'Only Board can onboard another member.',
        '/onboard is for people, not apps.', 'That Discord member is linked to another roster email.',
        'That roster email is linked to another Discord member.',
        'No linked Clean-roster member found.', 'The server owner must handle Board resignations.',
        'The server owner must handle Board removals.', 'Only Board can use /remove.',
        '/remove is for people, not apps.',
        'Only Board and Team Leads can invite members.', 'That email is not on the Clean roster.',
        'Provide either an email or GitHub username.', 'Invalid GitHub username.', 'GitHub username must match one Clean-roster member.',
        'Your Team Lead role is not mapped to a team yet.',
        'Verify your Princeton account with /onboard before sending team email.',
        'Only Board and Team Leads can announce.', 'No roster email recipients found for this announcement.',
        'Verify your Princeton account with /onboard first.', 'Run /onboard and verify your Princeton account first.',
        'Your command access changed.', 'Announcement access changed.', 'Invalid role selection.',
      ].includes(error.message) || error.message.startsWith('Choose one of your teams:') ? error.message : 'That did not work. Please try again or ask Board for help.';
      try {
        if (interaction.deferred && (interaction.isModalSubmit() || interaction.isChatInputCommand() || interaction.customId === 'onboard:start')) await interaction.editReply({ content: safe, components: [] });
        else if (interaction.deferred || interaction.replied) await interaction.followUp({ flags: ephemeral, content: safe });
        else await interaction.reply({ flags: ephemeral, content: safe });
      } catch { console.error('Could not report an interaction error to Discord.'); }
    }
  }

  async function checkMissingRoster() {
    const current = new Set((await roster.all()).map(person => person.email));
    const missing = [...new Set(Object.values(state.get().links).map(link => link.email).filter(email => !current.has(email)))].sort();
    const newMissing = missing.filter(email => !state.get().missingRoster.includes(email));
    if (newMissing.length && !(await boardNotice(`Linked Princeton emails missing from the Clean roster: ${newMissing.join(', ')}. Review their Discord access manually.`))) return;
    state.update(data => { data.missingRoster = missing; });
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
      ])) throw new Error(`Bot needs text-channel access in ${id}.`);
    }
    if (!state.get().rolloutStartedAt) state.update(data => { data.rolloutStartedAt = Date.now(); });
    await guild.commands.set(commands(config));
    const channel = guild.channels.cache.get(server.channels.startHere);
    const welcome = { content: "Welcome to TigerApps. Let's get you set up.",
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
    setInterval(() => { state.cleanExpired(); checkMissingRoster().catch(() => console.error('Roster review failed.')); }, 24 * 60 * 60_000).unref();
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
