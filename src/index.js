import { loadConfig } from './config.js';
import { Github, Mailer } from './integrations.js';
import { Roster } from './roster.js';
import { State } from './state.js';
import { createBot } from './bot.js';

const config = loadConfig();
const state = new State(config.dataFile);
const { client, oauth } = createBot(config, state, new Roster(config), new Github(config), new Mailer(config));
const server = oauth.listen();
try { await client.login(config.discordToken); }
catch (error) { server.close(); throw error; }
