# GD Mana Orbs Bot

Geometry Dash themed Discord economy bot.

## Commands
- `/balance [user]`, `/leaderboard`
- `/work` (5m), `/build` (10m), `/fish` (3m), `/mine` (15m): earn orbs, with rare bonus rolls
- `/quiz` (3m): answer a Geometry Dash trivia question within 10s. Base 200-500 orbs, scaled by question difficulty (0.5x to 3x). Up to 3 skips reroll the question. Always a challenge; wrong answers count as fails
- `/pay user amount`: 10% tax (rounded up) goes back to the vault; transfers must be at least 2 orbs
- `/daily`: claim once per UTC day; consecutive days raise the reward (max bonus at day 10)
- `/upgrade tool`: Diamond Pickaxe and Good Fishing Rod go up to level 5, raising the random payout bonus and costing more each level
- `/changelog`: shows the latest commit on GitHub (the repo is private, so set `GITHUB_TOKEN` to a token with read access; `CHANGELOG_REPO` overrides the repo)
- `/achievements [user]`: 15 one-time achievements (earn counts, quiz streaks, drops, daily streak) that pay a scaled orb reward. `/level` shows your badge count
- `/clan create|invite|join|leave|kick|deposit|upgrade|info|top`: clans of up to 20. Founding costs 25,000 (scales like shop prices). Deposits go into an upgrade fund that can never be withdrawn; the owner spends it on clan levels (up to 5), and each level gives every member +1% on earn payouts. If the owner leaves, the longest-standing member takes over
- `/raid status|start`: a raid boss spawns in the event channel (`EVENT_CHANNEL_ID`, or `DROP_CHANNEL_ID` if unset) an hour after startup, then 72h after each raid ends. HP is 300 per server member (min 3,000). Earn commands, `/daily` and drop wins hit it (10% crit chance). Defeat it within 48h and a 50,000 pool (scales with payouts) is split by damage. Manage Server can start one in the current channel with `/raid start`
- `/coins [user]`: 15 Secret Coins, three per earn command (named after the first five official levels). Each paid earn has a 3% chance to find one you are missing. Completing a set pays 5,000 (scales with payouts); finding all 15 unlocks the Completionist achievement
- `/level`, `/prestige`: earn XP from your payouts. Reach level 50 to prestige, which resets XP for +2% payouts per prestige (max 10)
- `/shop`, `/buy item`: Image Permissions (1,000), Admin Permissions (1 trillion), Salary Raise (20,000, +5% salary), Good Resumé (500,000, +25% salary), Diamond Pickaxe (5,000, +2-10% mining), Good Fishing Rod (4,000, +2-15% fishing)
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

## Orb drops
Set `DROP_CHANNEL_ID` to a channel and the bot posts an orb drop every 20-40 minutes. The first person to click "Grab it!" wins. Golden Orbs (about 1 in 7) pay 5x. After winning, you must sit out the next 5 drops before you can win again. Unclaimed drops expire after 10 minutes. The bot needs View Channel and Send Messages in that channel. Live drops are closed out on restart.

## Tweaking
Edit `SHOP` and `ACTIONS` at the top of `index.js` for prices, cooldowns, payouts and flavor text. Shop prices rise 4% per doubling of the supply cap (`PRICE_SCALE`), so they grow much more slowly than payouts.

