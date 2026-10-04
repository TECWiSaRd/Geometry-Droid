# GD Mana Orbs Bot

Geometry Dash themed Discord economy bot.

## Commands
- `/balance [user]`, `/leaderboard`
- `/work` (5m), `/build` (10m), `/fish` (3m), `/mine` (15m): earn orbs, with rare bonus rolls
- `/pay user amount`
- `/shop`, `/buy item`: Image Permissions (1,000), Admin Permissions (1 trillion)
- `/salary set|remove|list` (Manage Server): automatic role payments

## Discord setup
1. discord.com/developers → New Application → Bot → copy the **token**.
2. Bot tab → enable **Server Members Intent**.
3. Invite with scopes `bot` + `applications.commands` and permission **Manage Roles**.
4. In your server, create two roles: **Image Perms** and **Admin** (give Admin the Administrator permission).
   - For Image Perms: deny *Attach Files* and *Embed Links* for @everyone, allow them for the Image Perms role.
5. Drag the bot's role **above** both of those roles (Server Settings → Roles).
6. Enable Developer Mode, right-click each role → Copy Role ID.

## Railway deploy
1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. Add a **Volume** to the service, mount path `/data` (keeps balances across deploys).
4. Variables:

```
DISCORD_TOKEN=your-bot-token
GUILD_ID=your-server-id
IMAGE_ROLE_ID=role-id
ADMIN_ROLE_ID=role-id
DB_PATH=/data/orbs.db
SALARY_INTERVAL_MINUTES=60
# ADMIN_PRICE=1000000000000   (optional override)
```

Railway runs `npm start` automatically.

## Supply
Circulation is capped at 500,000,000 orbs on launch day, and the cap grows linearly by about 11.1 billion per day, reaching 2 trillion after 180 days (it keeps growing at that rate after). Earn commands and salaries can only mint orbs while circulation is under the cap; orbs spent in the shop go back into the vault. Earn payouts scale up with the cap so the economy keeps pace. `/supply` shows the numbers. Settings are at the top of `index.js`.

## Anti-bot checks
`/work`, `/build`, `/fish` and `/mine` sometimes (20% of the time, and always after 10 in a row) show a button challenge: math, GD trivia, or "click the orb". Orbs are paid only if you answer correctly within 30s. 3 fails locks you out of earning for 1 hour. Tune `CHALLENGE_CHANCE`, `FORCE_AFTER`, `CHALLENGE_SECONDS`, `MAX_FAILS` and `LOCK_SECONDS` at the top of `index.js`.

## Salaries
Example: `/salary set @Owner 50000`, `/salary set @Admin 20000`, `/salary set @Mod 5000`. Everyone with the role is paid every `SALARY_INTERVAL_MINUTES`. If someone has several paid roles they get the highest one only.

## Tweaking
Edit `SHOP` and `ACTIONS` at the top of `index.js` for prices, cooldowns, payouts and flavor text.

