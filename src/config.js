import { readFileSync } from 'node:fs';

const id = value => typeof value === 'string' && /^\d{17,20}$/.test(value);

export function validateServerConfig(config) {
  if (!config || !id(config.guildId)) throw new Error('server.json needs a Discord guildId');
  for (const key of ['guest', 'member', 'alumni', 'teamLead', 'board']) {
    if (!id(config.roles?.[key])) throw new Error(`server.json needs roles.${key}`);
  }
  for (const key of ['startHere', 'publicChat', 'announcements', 'boardLog']) {
    if (!id(config.channels?.[key])) throw new Error(`server.json needs channels.${key}`);
  }
  if (new Set(Object.values(config.channels)).size !== Object.values(config.channels).length) {
    throw new Error('server.json reuses a channel ID');
  }
  for (const [name, team] of Object.entries(config.teams || {})) {
    if (!id(team.roleId) || !id(team.channelId) || !Array.isArray(team.leadIds) || !team.leadIds.every(id)) {
      throw new Error(`server.json has an invalid team: ${name}`);
    }
  }
  for (const [name, roleId] of Object.entries(config.functions || {})) {
    if (!id(roleId)) throw new Error(`server.json has an invalid function role: ${name}`);
  }
  for (const [year, roleId] of Object.entries(config.years || {})) {
    if (!/^20\d{2}$/.test(year) || !id(roleId)) throw new Error(`server.json has an invalid year role: ${year}`);
  }
  if (![config.teams, config.functions, config.years].every(value => value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('server.json needs teams, functions, and years objects');
  }
  if (!Array.isArray(config.revokeRoleIds || []) || !(config.revokeRoleIds || []).every(id)) {
    throw new Error('server.json has invalid revokeRoleIds');
  }
  if (Object.keys(config.teams).length > 24 || Object.keys(config.functions).length > 24 || Object.keys(config.years).length > 24) {
    throw new Error('Discord select menus support at most 24 configured options');
  }
  const roleIds = [
    ...Object.values(config.roles),
    ...Object.values(config.teams || {}).map(team => team.roleId),
    ...Object.values(config.functions || {}),
    ...Object.values(config.years || {}), ...(config.revokeRoleIds || []),
  ];
  if (roleIds.includes(config.guildId)) throw new Error('server.json cannot manage @everyone');
  if (new Set(roleIds).size !== roleIds.length) throw new Error('server.json reuses a role ID');
  return config;
}

export function loadConfig() {
  const required = [
    'DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_CLIENT_SECRET', 'PUBLIC_BASE_URL',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GOOGLE_SERVICE_ACCOUNT_JSON',
    'ROSTER_SPREADSHEET_ID', 'GITHUB_APP_ID',
    'GITHUB_INSTALLATION_ID', 'GITHUB_PRIVATE_KEY',
  ];
  for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
  const gmailRefreshToken = process.env.GMAIL_REFRESH_TOKEN ||
    (process.env.GMAIL_REFRESH_TOKEN_FILE ? readFileSync(process.env.GMAIL_REFRESH_TOKEN_FILE, 'utf8').trim() : '');
  if (!gmailRefreshToken) throw new Error('Missing GMAIL_REFRESH_TOKEN or GMAIL_REFRESH_TOKEN_FILE');
  const baseUrl = new URL(process.env.PUBLIC_BASE_URL);
  if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
    throw new Error('PUBLIC_BASE_URL must use HTTPS outside localhost');
  }
  const server = validateServerConfig(JSON.parse(readFileSync(process.env.SERVER_CONFIG_FILE || 'server.json', 'utf8')));
  let googleServiceAccount;
  try { googleServiceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  return {
    server,
    baseUrl: baseUrl.origin,
    port: Number(process.env.PORT || 3000),
    dataFile: process.env.DATA_FILE || 'data/state.json',
    discordToken: process.env.DISCORD_TOKEN,
    discordAppId: process.env.DISCORD_APP_ID,
    discordSecret: process.env.DISCORD_CLIENT_SECRET,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    gmailClientId: process.env.GMAIL_CLIENT_ID,
    gmailClientSecret: process.env.GMAIL_CLIENT_SECRET,
    googleServiceAccount,
    rosterSpreadsheetId: process.env.ROSTER_SPREADSHEET_ID,
    gmailRefreshToken,
    githubAppId: process.env.GITHUB_APP_ID,
    githubInstallationId: process.env.GITHUB_INSTALLATION_ID,
    githubPrivateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

export function managedRoleIds(server) {
  return [server.roles.guest, server.roles.member, server.roles.alumni, server.roles.teamLead,
    ...Object.values(server.teams).map(team => team.roleId),
    ...Object.values(server.functions), ...Object.values(server.years), ...(server.revokeRoleIds || [])];
}
