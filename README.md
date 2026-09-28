# TigerApps Discord bot

Onboards new TigerApps Discord members from the Clean roster and provides Board and Team Lead commands. The bot runs as one Node.js process with a small OAuth callback server. Server roles, channels, and permissions are configured in Discord; this code references their IDs and never edits the layout. See [architecture and hosting](docs/architecture.md) for the deployment and data flows.

## What it does

- Gives new arrivals `Guest` after Discord's server rules, then offers a persistent **Get started** button and `/onboard`.
- Verifies the same Discord account and a Princeton Google account, checks the verified email against the live Clean roster, and lets new members confirm or change ordinary team, function, and year roles. Existing members can link their account without changing roles during the first rollout.
- Supports `/resign`, Board-only `/remove`, Team Lead and Board `/announce` and `/github-invite`, and private `/info` cards for TigerApps members and leadership. The card includes roster contact fields and uses a matching public Homepage headshot when available. Board can use `/onboard member email` to link an existing Discord member and assign their roster roles after confirmation; the member receives a role-aware DM. Announcements require a preview and confirmation; the email links back to its Discord post.
- Logs command use, onboarding, and roster or delivery exceptions as compact cards in a private Board channel. `Status Review` is only a flag; Board must update the Clean roster after a removal to prevent later re-onboarding or GitHub re-invitation.

## Requirements

Node.js 20+ and persistent private storage. Cloudflare routes `https://api.tigerapps.org` through the dedicated tunnel to the bot's local port. Set `PUBLIC_BASE_URL=https://api.tigerapps.org`; the separate one-time mailbox authorization script uses localhost. Run one bot process: account links, OAuth attempts, and announcement confirmations are stored in `data/state.json`.

1. **Discord:** Use the existing TigerApps application. Enable **Server Members Intent**. Install it with `bot` and `applications.commands`, Manage Roles, View Channels, Send Messages, and Read Message History. Put its highest role below `Board` and above every role it will assign or remove, including `Team Lead`. Administrator is unnecessary. Register the Discord OAuth redirect `${PUBLIC_BASE_URL}/auth/discord`.
2. **Google:** Use a web OAuth client for Princeton member sign-in with `${PUBLIC_BASE_URL}/auth/google` as its redirect URI. Its audience must allow Princeton accounts; it requests only `openid email`. Enable the Sheets API and share the roster workbook with a dedicated service account as **Editor**. Use a separate OAuth client for the TigerApps mailbox with `http://localhost:3741/callback` as its redirect URI and enable the Gmail API. Authorize `it.admin@princetonusg.com` once for `gmail.send` using `npm run authorize-mail`; this writes `data/gmail-refresh-token` with private file permissions. A mailbox client left in Google's external Testing mode can have a seven-day refresh token, so publish/verify it or use an eligible internal Workspace project before relying on scheduled mail. Do not paste tokens into chat.
3. **GitHub:** Install a GitHub App in `TigerAppsOrg` with organization **Members: write** permission. Store its app ID, installation ID, and private key as host secrets. The bot sends direct-member invitations, never owner invitations. GitHub access remains pending until the recipient accepts.
4. **Discord mapping:** Create a local `server.json` (ignored by Git) after the server cleanup. Use Discord Developer Mode → Copy ID. Its shape is:

   | Key | Value |
   | --- | --- |
   | `guildId` | TigerApps server ID |
   | `roles` | IDs for `guest`, `member`, `alumni`, `teamLead`, `board` |
   | `channels` | IDs for `startHere`, `publicChat`, `announcements`, `boardLog` |
   | `teams` | Team name to `{ "roleId": ID, "channelId": ID, "leadIds": [Discord user IDs] }` |
   | `functions` | Ordinary function name to role ID, such as Engineering or Design |
   | `years` | Class year to role ID |
   | `revokeRoleIds` | Optional IDs for other existing roles that must be stripped on `/resign` and `/remove` |

   Keep privileged roles out of `teams`, `functions`, and `years`. The bot validates that every configured role/channel exists and that its hierarchy is correct before registering commands or posting the panel. Names can be changed in Discord without changing IDs; deleted and recreated roles/channels need new IDs in this file.

## Configuration

Set these through the host's private environment file. The Google service-account JSON and GitHub App PEM can be supplied as inline values or by private file paths. On EC2, the environment file, credential files, Discord map, and state live on encrypted EBS. For local development, Node 20 can read an ignored `.env` with `node --env-file=.env src/index.js`.

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_CLIENT_SECRET` | Bot and Discord OAuth credentials |
| `PUBLIC_BASE_URL`, `PORT` | HTTPS callback origin and local listener port |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Princeton member sign-in OAuth client |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | Separate TigerApps mailbox OAuth client |
| `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`, `ROSTER_SPREADSHEET_ID` | Live Clean roster access |
| `GMAIL_REFRESH_TOKEN` or `GMAIL_REFRESH_TOKEN_FILE` | Send from `it.admin@princetonusg.com` |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_FILE` | GitHub organization invitations and removals |
| `SERVER_CONFIG_FILE`, `DATA_FILE` | Optional paths; default to `server.json` and `data/state.json` |

Run `npm ci` and `npm test` before installing the bot. The [systemd units](deploy/) run the bot and Cloudflare Tunnel on EC2. `/health` returns 200 when the Discord client is connected. Start the bot only after the intended roles, channels, and permissions have been tested. The bot registers its six guild commands and posts one onboarding panel on first startup.

Updates merged into `main` run tests and deploy automatically through [GitHub Actions](.github/workflows/ci.yml). The workflow uploads a commit archive to private S3 and invokes a fixed Systems Manager document on the EC2 host. The host installs and tests a new release, switches the bot code symlink, and restarts only the bot service. It restores the prior release if the bot does not become healthy. Credentials and state remain on encrypted EBS; see the [architecture](docs/architecture.md).

For local mailbox authorization, set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`, run `npm run authorize-mail`, open the printed Google URL yourself, and sign in as `it.admin@princetonusg.com`. Keep the resulting ignored file private.

## Access boundaries

The bot does not grant `Board` or `Team Lead` through onboarding. A verified member may choose any configured ordinary team role, so those team channels must be appropriate for that policy. `/remove` changes Discord roles, flags the roster, and tries GitHub organization removal; if GitHub cannot identify the account or rejects the request, Board gets a partial-failure notice. `/resign` leaves GitHub membership for Board review. Removing GitHub organization membership can end access to private forks.

Do not commit `.env`, `server.json`, `data/`, roster exports, or local `.agents/` and `.impeccable/` notes. No bot token, Google key, GitHub key, or mailbox refresh token belongs in Git.
