# Metadata-remover-bot Telegram Bot

Try the bot [@MetadataRemoverByJon_bot](https://t.me/MetadataRemoverByJon_bot)

A Telegram bot that:

- accepts **photos**, **image documents**, and **PDFs** only
- rejects other file types
- processes accepted files and sends them back as **documents**
- requires users to join a specified Telegram channel before use
- stores users in JSON for the admin `/users` command
- rate-limits each user to a configurable number of removals per hour

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your settings:

```bash
BOT_TOKEN=your_bot_token_here
CHANNEL_USERNAME=@your_channel_username
# Optional if you use a private invite link or want a custom button target.
CHANNEL_JOIN_URL=https://t.me/your_channel_or_invite_link
ADMIN_ID=123456789
MAX_REMOVALS_PER_HOUR=10
DAILY_RESET_TZ=Asia/Kolkata
```

3. Build and run:

```bash
npm run build
npm start
```

## Notes

- The bot stores user records in `data/users.json`.
- The hourly rate-limit state is stored in `data/limits.json`.
- `/users` is available only to the admin Telegram ID in `ADMIN_ID`.
- Each user's channel membership is re-checked only once per day when they interact with the bot.
