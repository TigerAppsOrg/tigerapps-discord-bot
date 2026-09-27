import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { OAuth2Client } from 'google-auth-library';

const lifetime = 15 * 60 * 1000;
const random = () => randomBytes(24).toString('base64url');

function cookie(request) {
  return request.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('ta_oauth='))?.slice(9) || '';
}

function matches(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function verifiedPrincetonEmail(identity) {
  if (!identity?.sub || identity.email_verified !== true || identity.hd !== 'princeton.edu' ||
      !/^[^\s@]+@princeton\.edu$/i.test(identity.email || '')) {
    throw new Error('Use a verified Princeton Google account.');
  }
  return identity.email.toLowerCase();
}

function page(response, status, message, link, clear = false) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    ...(clear ? { 'Set-Cookie': 'ta_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0' } : {}),
  });
  response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TigerApps access</title><style>body{font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}a{color:#4654c5}</style><h1>TigerApps access</h1><p>${message}</p>${link ? `<p><a href="${link}">Return to Discord</a></p>` : ''}</html>`);
}

export function createOAuth(config, state, roster, client) {
  const google = new OAuth2Client(config.googleClientId, config.googleClientSecret, `${config.baseUrl}/auth/google`);
  const discordRedirect = `${config.baseUrl}/auth/discord`;
  const discordLink = `https://discord.com/channels/${config.server.guildId}/${config.server.channels.startHere}`;

  function start(discordId) {
    const token = random();
    state.update(data => { data.oauth[token] = { discordId, phase: 'start', expiresAt: Date.now() + lifetime }; });
    return `${config.baseUrl}/auth/start?state=${token}`;
  }

  async function handle(request, response) {
    const url = new URL(request.url, config.baseUrl);
    if (request.method !== 'GET' || !url.pathname.startsWith('/auth/')) return false;
    const token = url.searchParams.get('state') || '';
    const attempt = state.get().oauth[token];
    if (!attempt || attempt.expiresAt < Date.now()) {
      page(response, 400, 'This link expired. Return to Discord and start again.', discordLink);
      return true;
    }
    try {
      if (url.pathname === '/auth/start' && attempt.phase === 'start') {
        const browser = random();
        state.update(data => { data.oauth[token].browser = browser; data.oauth[token].phase = 'discord'; });
        response.writeHead(302, {
          'Cache-Control': 'no-store',
          'Set-Cookie': `ta_oauth=${browser}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=900${config.baseUrl.startsWith('https:') ? '; Secure' : ''}`,
          Location: `https://discord.com/oauth2/authorize?${new URLSearchParams({
            client_id: config.discordAppId, redirect_uri: discordRedirect,
            response_type: 'code', scope: 'identify', state: token,
          })}`,
        });
        response.end();
      } else if (url.pathname === '/auth/discord' && attempt.phase === 'discord' && matches(cookie(request), attempt.browser)) {
        const result = await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.discordAppId, client_secret: config.discordSecret,
            grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: discordRedirect,
          }),
        });
        if (!result.ok) throw new Error('Discord sign-in failed.');
        const { access_token } = await result.json();
        const identity = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
        if (!identity.ok || (await identity.json()).id !== attempt.discordId) throw new Error('Sign in with the same Discord account that started setup.');
        state.update(data => { data.oauth[token].phase = 'google'; });
        response.writeHead(302, { 'Cache-Control': 'no-store', Location: google.generateAuthUrl({
          scope: ['openid', 'email'], state: token, hd: 'princeton.edu', prompt: 'select_account',
        }) });
        response.end();
      } else if (url.pathname === '/auth/google' && attempt.phase === 'google' && matches(cookie(request), attempt.browser)) {
        const { tokens } = await google.getToken(url.searchParams.get('code') || '');
        if (!tokens.id_token) throw new Error('Princeton sign-in did not return an identity.');
        const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
        const identity = ticket.getPayload();
        const email = verifiedPrincetonEmail(identity);
        if (!(await roster.byEmail(email))) throw new Error('This email is not on the current TigerApps roster. Ask a lead in the public chat.');
        state.link(identity.sub, email, attempt.discordId);
        state.update(data => { delete data.oauth[token]; });
        let next = 'Verified. Return to Discord and select Set up access to confirm your roles.';
        try {
          const guild = await client.guilds.fetch(config.server.guildId);
          const member = await guild.members.fetch(attempt.discordId);
          if (member.joinedTimestamp < state.get().rolloutStartedAt) next = "You're verified.";
        } catch { /* The member can use /onboard for the next step. */ }
        page(response, 200, next, discordLink, true);
        try { await (await client.users.fetch(attempt.discordId)).send(`${next} ${discordLink}`); } catch { /* DMs may be closed. */ }
      } else {
        page(response, 400, 'This sign-in step is no longer valid. Start again in Discord.', discordLink);
      }
    } catch (error) {
      state.update(data => { delete data.oauth[token]; });
      const message = [
        'Discord sign-in failed.', 'Sign in with the same Discord account that started setup.',
        'Use a verified Princeton Google account.',
        'This email is not on the current TigerApps roster. Ask a lead in the public chat.',
        'This Princeton account is already linked to another Discord account.',
        'This Princeton email is already linked to another Discord account.',
        'This Discord account is already linked to another Princeton account.',
      ].includes(error.message) ? error.message : 'Verification failed. Please try again in Discord.';
      page(response, 400, message, discordLink, true);
    }
    return true;
  }

  function listen() {
    const server = createServer(async (request, response) => {
      if (request.url === '/health') {
        response.writeHead(client.isReady() ? 200 : 503, { 'Content-Type': 'text/plain' });
        response.end(client.isReady() ? 'ok' : 'starting'); return;
      }
      try { if (!(await handle(request, response))) { response.writeHead(404); response.end(); } }
      catch { if (!response.headersSent) response.writeHead(500); response.end(); }
    });
    server.listen(config.port, '127.0.0.1');
    return server;
  }

  return { start, listen };
}
