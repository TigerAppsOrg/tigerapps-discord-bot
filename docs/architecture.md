# TigerApps Discord bot architecture

The bot runs as one Node.js service on the `TigerApps-Combined` EC2 instance. Cloudflare serves `api.tigerapps.org` over HTTPS and forwards member sign-in callbacks through the `tigerapps-discord-bot` tunnel to port 3100 on that instance. The Discord connection uses Gateway, so the host does not need a public Discord interaction endpoint.

## Hosting and services

| Part | Location | Purpose |
| --- | --- | --- |
| Discord application and guild | Discord | Gateway events, slash commands, roles, channels |
| `api.tigerapps.org` | Cloudflare DNS and edge | Public HTTPS origin for member OAuth |
| `tigerapps-discord-bot` tunnel | Cloudflare plus `cloudflared` on EC2 | Forward HTTPS to `http://localhost:3100` |
| Node.js bot and OAuth listener | `TigerApps-Combined` EC2, loopback port 3100 | Discord Gateway connection, callbacks, command handling |
| Bot code | `/opt/tigerapps-discord-bot` symlink to `/opt/tigerapps-discord-releases/` on EC2 | Versioned application and dependencies |
| `.env`, `server.json`, `data/state.json` | Encrypted EBS volume at `/var/lib/tigerapps-discord-bot` | Credentials, Discord ID map, account links and action state |
| Deployment archives | Private, encrypted `tigerapps-discord-bot-deploy-104733724423-us-east-1` S3 bucket | Commit-specific code archives for host updates |
| Deployment workflow | GitHub Actions, AWS OIDC, and Systems Manager | Test and deploy each update to `main` without static AWS keys |
| Clean roster workbook | Google Sheets | Member allowlist and `Status Review` flag |
| Google OAuth clients | Google Auth Platform | Princeton member sign-in and TigerApps mailbox authorization |
| TigerApps mailbox | Gmail | `/announce` email delivery |
| TigerApps calendar | Google Calendar | `/event` events and roster-based calendar sharing |
| GitHub App | TigerAppsOrg | Organization invitations and removals |

## Component view

```mermaid
flowchart LR
  Member[Discord member] --> Guild[TigerApps Discord server]
  Member -->|Browser sign-in| Edge[Cloudflare api.tigerapps.org]
  subgraph EC2["TigerApps-Combined EC2"]
    Tunnel[cloudflared connector]
    Bot[Node.js bot on loopback port 3100]
    State[(Encrypted EBS state and credentials)]
    Tunnel -->|HTTP localhost:3100| Bot
    Bot --> State
  end
  Guild <-->|Gateway events and interactions| Bot
  Edge --> Tunnel
  Bot -->|Discord identity OAuth| DiscordOAuth[Discord OAuth2]
  Bot -->|Princeton identity OAuth| GoogleOAuth[Google Auth Platform]
  Bot -->|Read roster and flag Status Review| Sheets[Clean Google Sheet]
  Bot -->|Send confirmed announcements| Gmail[TigerApps Gmail API]
  Bot -->|Invite or remove org members| GitHub[TigerAppsOrg GitHub App API]
  Archive[(Private S3 deploy archive)] -.->|Install code| Bot
```

Discord interactions arrive through the Gateway connection, so there is no Discord Interactions Endpoint URL. The GitHub App makes outbound API calls on commands and does not subscribe to webhooks, so its webhook can be inactive. The HTTP listener exposes only `/auth/*` callbacks and `/health`; `/health` returns 200 only when the Discord client is ready.

Two systemd units keep the bot and tunnel running after reboot: [`tigerapps-discord-bot.service`](../deploy/tigerapps-discord-bot.service) and [`tigerapps-discord-tunnel.service`](../deploy/tigerapps-discord-tunnel.service). The bot unit has a 512 MB memory limit and one CPU of quota to constrain its impact on other applications on `TigerApps-Combined`. The tunnel token and bot credentials are stored on encrypted EBS; neither is placed in a unit file or repository.

## Deployment

```mermaid
sequenceDiagram
  participant GitHub as GitHub Actions
  participant AWS as AWS OIDC and S3
  participant SSM as Systems Manager
  participant Host as TigerApps-Combined
  participant Bot as Bot systemd unit
  GitHub->>GitHub: Test update to main
  GitHub->>AWS: Assume bot-only role and upload commit archive
  GitHub->>SSM: Invoke fixed bot deployment document
  SSM->>Host: Download archive and verify SHA-256
  Host->>Host: Install dependencies and run tests in new release
  Host->>Bot: Switch code symlink and restart bot only
  Host->>Bot: Check localhost health and restore prior release on failure
  SSM-->>GitHub: Deployment result
  GitHub->>GitHub: Check public health endpoint
```

The [main-branch workflow](../.github/workflows/ci.yml) deploys after tests pass. Its OIDC role is restricted to this repository's `main` branch, the bot archive prefix, the [`TigerAppsDiscordBotDeploy` document](../deploy/ssm-deploy.json), and the `TigerApps-Combined` instance. The [host script](../deploy/deploy-on-host.sh) changes only the bot code symlink and `tigerapps-discord-bot.service`; the tunnel, other services, and encrypted runtime volume stay in place. A failed health check restores the previous release. This is a single bot process, so a restart can briefly interrupt command handling.

## Member onboarding

```mermaid
sequenceDiagram
  actor Member
  participant Discord as Discord guild
  participant Bot as Bot host
  participant Edge as Cloudflare HTTPS tunnel
  participant DO as Discord OAuth2
  participant GO as Google OAuth2
  participant Sheet as Clean roster
  Member->>Discord: Join and complete server screening
  Discord->>Bot: Guild member event
  Bot->>Discord: Assign Guest
  Member->>Discord: Get started or /onboard
  Discord->>Bot: Accepted member choice
  Bot-->>Member: Verification link
  Member->>Edge: Open verification link
  Edge->>Bot: Forward /auth/start
  Bot->>DO: Request identify consent
  DO->>Bot: Discord account identity
  Bot->>GO: Request Princeton openid and email
  GO->>Bot: Verified Princeton identity
  Bot->>Sheet: Exact email lookup
  alt Email is on Clean roster
    Bot->>Bot: Link one Princeton identity to one Discord account
    Bot-->>Member: Return to Discord
    Member->>Discord: Confirm or change ordinary role selections
    Discord->>Bot: Selected team, function, and year
    Bot->>Discord: Assign member and selected ordinary roles
    opt Selected team differs from roster
      Bot->>Discord: Notify member and selected team's leads there
    end
  else No exact roster match
    Bot-->>Member: Ask a lead in public chat
  end
```

The rollout cutoff is saved at first successful startup. Existing server members may link their Princeton account, but onboarding does not change their roles until the existing-member audit. New arrivals receive Guest after screening and can use the public onboarding and help channels. The Clean roster controls whether the person is a member; the chosen ordinary team, function, and year roles determine channel access. Onboarding never grants Board or Team Lead.

Board can onboard an existing Discord member with `/onboard member email`. The bot previews an exact Clean-roster match, then links that Discord account and applies roster-based ordinary roles after Board confirms. This Board-attested link does not require the member's Google sign-in; the private Board log records who made it. On success, the member receives a DM naming the Board member and the commands available to their Discord role. If DMs are closed or role assignment fails, Board sees that outcome instead of a false success notice. Existing Board roles are left alone. If the member later verifies with Google, that identity replaces the Board-attested link for the same Discord account and email.

## Commands and data access

| Command | Actor | Effect |
| --- | --- | --- |
| `/onboard` | Any member; Board with `member` and `email` | Self-service sign-in, or Board-confirmed roster linking and ordinary role assignment for another Discord member |
| `/info` | TigerApps member, Board, or Team Lead | Private card with one Clean-roster person's name, team, role, year, GitHub, email, phone, and an available headshot |
| `/announce` | Board club-wide or for any team; leads for mapped teams | Preview with an optional test email to the author, then post to Discord and send roster email through Gmail with hidden recipients |
| `/event` | Board or Team Lead | Preview, then add a one-time, weekly, or every-other-week event to the TigerApps calendar and the server's Discord events; repeats end at the semester's close |
| `/github-invite` | Board or Team Lead | Invite an exact Clean-roster member by GitHub username or Princeton email; acceptance remains pending |
| `/resign` | Linked non-Board member | Move controllable Discord roles to Alumni, flag Status Review, notify Board; GitHub remains unchanged |
| `/remove` | Board | Move target to Guest, flag Status Review, attempt GitHub org removal, notify Board of any partial failure |

The private `#bot-log` channel records every slash-command invocation and completed onboarding, including Board-assisted links and new Guest access. It also records operation failures, with the underlying error, and partial outcomes in compact embeds. Members see a plain explanation instead of the technical detail. `/info` results, announcement text, and roster phone numbers are not copied into the log. Guests cannot use `/info`; anyone with the TigerApps member role can see roster contact fields, including phone numbers.

`/info` reads the public current-member photo feed at `https://tigerapps.org/members.json`. The Homepage builds that feed from portraits already shown on the site, including its placeholder image. The bot uses a portrait only for a unique exact roster name and class-year match; when no site portrait is available, a linked Discord account can supply its avatar. The card still works if the Homepage is unavailable.

```mermaid
sequenceDiagram
  actor Lead as Team Lead or Board
  participant Bot
  participant Sheet as Clean roster
  participant Discord as Discord channel
  participant Gmail as Gmail API
  Lead->>Bot: /announce team or club-wide
  Bot->>Sheet: Read current recipient emails
  Bot-->>Lead: Private preview and recipient count
  Lead->>Bot: Confirm
  Bot->>Sheet: Recheck recipient set
  Bot->>Discord: Post announcement
  Bot->>Gmail: Send BCC announcement
  alt Gmail outcome uncertain
    Bot->>Discord: Report to private Board log
  end
```

`/announce` posts its role mention beneath the Discord message: the selected team's role for team announcements and the general TigerApps member role for club-wide announcements. The private preview does not ping. After the Discord post succeeds, the bot sends a styled HTML email with a plain-text alternative and a link to that post. Mail sends from `it.admin@princetonusg.com`. Team mail uses the sender's linked Princeton address as To and Reply-To and CCs the TigerApps mailbox; recipients are BCC. Club-wide Board mail uses the TigerApps mailbox as To and Reply-To. A confirmed announcement can have a partial outcome: if the Discord post succeeded but Gmail's response is uncertain, check the Sent mailbox before retrying.

## Permissions and configuration

`server.json` maps existing Discord IDs. It does not create channels or edit channel permissions. It contains the guild ID; Guest, TigerApps member, Alumni, Team Lead, and Board role IDs; onboarding, public chat, announcements, and private Board log channel IDs; team role/channel/lead mappings; ordinary function and class-year roles; and optional additional roles to revoke on resignation or removal. Team names in this map should match the Clean roster values used for preselection. Renaming a Discord role or channel preserves its ID; recreating it requires a map update.

The bot needs **Server Members Intent** and Discord permissions **Manage Roles, View Channels, Send Messages, Read Message History, Embed Links, Create Events**. Its highest role must be below Board and above every role it manages, including Team Lead. It must be able to send embeds in the onboarding, announcements, Board log, and mapped team channels. The announcement roles must be mentionable for the intended ping to work. It does not need Administrator, Manage Channels, Message Content Intent, or Presence Intent. Discord channel overrides must still be reviewed separately: a server-level permission alone does not guarantee access to a private channel.

The roster service account receives Editor sharing on the specific workbook so it can read Clean roster columns and check `Status Review`. The member OAuth client requests only `openid email`; the separate mailbox client requests `gmail.send` and `calendar`. Once a day, and at startup, the bot shares the TigerApps calendar with every roster email as a viewer and with linked Board members and Team Leads as editors. It removes Princeton addresses that are no longer on the roster and leaves other sharing untouched. The GitHub App needs organization **Members: read and write**, with no repository permissions beyond GitHub's implicit metadata access. A GitHub organization invitation does not become active until accepted. The current organization base repository permission is write.

## Persistence and recovery

The bot uses one process and an atomically replaced local `data/state.json` for account links, pending OAuth attempts, action confirmations, the onboarding panel ID, and the rollout cutoff. Running multiple replicas against this file is unsupported. The state and credentials live on a dedicated encrypted EBS volume. Back up and transfer the state file before moving hosts; losing it breaks existing account links and changes how the first-rollout cutoff is interpreted. Keep `.env`, `server.json`, the state file, service-account JSON, Gmail refresh token, GitHub private key, and Cloudflare connector credentials out of Git and out of this document.

Startup validates mapped Discord roles, channels, hierarchy, and send permissions before registering commands or posting the onboarding panel. A failed validation should be fixed at the source mapping or Discord permission, then the process restarted. `/remove` and `/resign` flag the roster but leave Board to update membership rows; a person still on the Clean roster can otherwise regain access by onboarding or invitation.

## Endpoints and health

Register `https://api.tigerapps.org/auth/discord` in Discord and `https://api.tigerapps.org/auth/google` in Google. The separate TigerApps mailbox authorization script uses `http://localhost:3741/callback` on the operator's computer. The bot's `/health` endpoint returns 200 when the Discord client is connected and 503 while it is starting.
