# Knicks Ticket Monitor

Get a Telegram notification when **New York Knicks home-game tickets at Madison Square Garden go on public sale** according to Ticketmaster's official event API.

The monitor checks approximately every 15 minutes in GitHub's cloud. Your computer does not need to stay on. It does not reserve tickets, add tickets to a cart, or make purchases.

## What you need

Before installing, collect these three private values:

1. A **Ticketmaster consumer key** from the [Ticketmaster Developer Portal](https://developer.ticketmaster.com/).
2. A **Telegram bot token** from Telegram's verified `@BotFather` bot.
3. Your numeric **Telegram chat ID**.

You will also need:

- A GitHub account
- [Git](https://git-scm.com/downloads)
- [Node.js 20 or newer](https://nodejs.org/)
- [GitHub CLI](https://cli.github.com/)

The Ticketmaster consumer secret is not used.

## 1. Create your copy

Click **Use this template** near the top of this repository, then select **Create a new repository**. A private repository is recommended.

Clone your new repository and enter its directory:

```sh
git clone https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
cd YOUR-REPOSITORY
```

If GitHub CLI is not authenticated yet, run:

```sh
gh auth login
```

Choose GitHub.com, HTTPS, and browser authentication when prompted.

## 2. Get a Ticketmaster key

1. Sign in to the [Ticketmaster Developer Portal](https://developer.ticketmaster.com/).
2. Create an application.
3. Copy its **Consumer Key**.

Keep the key private. You do not need the Consumer Secret.

## 3. Create a Telegram bot

1. Open Telegram and start a chat with the verified `@BotFather` account.
2. Send `/newbot`.
3. Choose a display name.
4. Choose an available username ending in `bot`.
5. Save the bot token BotFather provides.
6. Open the new bot and send it `/start`, followed by a message such as `hello`.

### Find your Telegram chat ID

Open this address in a web browser—not in the Telegram chat—replacing `<BOT_TOKEN>` with your token:

```text
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

Find the latest `message`, then its `chat`, then `id`:

```json
"chat": {
  "id": 123456789
}
```

Save that number as your chat ID. If the response contains `"result":[]`, send the bot another message and refresh the browser page.

Never post or screenshot the bot token. If it is exposed, use `/revoke` in BotFather and replace it immediately.

## 4. Run the installer

From the repository directory:

```sh
./setup.sh
```

The installer asks privately for:

- Ticketmaster consumer key
- Telegram bot token
- Telegram numeric chat ID

Input is hidden while you type. The installer sends each value directly to encrypted GitHub Actions secrets; it does not save credentials in a file or commit them to Git.

It then runs the automated tests and starts a manual verification workflow. Follow the link printed at the end. A successful setup sends this message to Telegram:

```text
✅ Knicks ticket monitor test succeeded.
```

## How monitoring works

GitHub Actions wakes the monitor every five minutes. The configured interval gate performs a Ticketmaster API request approximately every 15 minutes, at `:07`, `:22`, `:37`, and `:52` each hour.

The monitor accepts an event only when Ticketmaster identifies both:

- The New York Knicks as an attraction
- Madison Square Garden in New York as the venue

An event appearing on the schedule is not enough to trigger an alert. The monitor waits until Ticketmaster reports the event as `onsale`, the public-sale date is not marked TBD, and any published public-sale start time has arrived. It then sends the event date, matchup, and Ticketmaster link to Telegram.

The latest sale state for each event is saved in `state.json`. An event is announced when it transitions from unavailable to publicly on sale. If it later goes off sale and returns, it can be announced again. If Telegram delivery fails, the transition remains eligible for retry.

GitHub scheduled jobs can occasionally begin a few minutes late.

## Change the interval

Edit `config.json`:

```json
{
  "checkIntervalMinutes": 15
}
```

Supported values are `5`, `10`, `15`, `20`, `30`, and `60`. Commit and push the change. Smaller values make more Ticketmaster API requests.

## Run tests locally

The tests do not contact Ticketmaster or Telegram and do not require credentials:

```sh
npm test
```

## Update a secret

Open your repository on GitHub, then go to:

**Settings → Secrets and variables → Actions**

Update any of these repository secrets:

- `TICKETMASTER_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

You can also rerun `./setup.sh` to replace all three.

## Troubleshooting

### The test says `Telegram returned 401`

`TELEGRAM_BOT_TOKEN` is invalid or was revoked. Copy the current token from BotFather and update the GitHub secret.

### The test says `Telegram returned 400`

Check `TELEGRAM_CHAT_ID`. Make sure you sent the bot a message before obtaining the ID.

### Ticketmaster returns `401` or `403`

Confirm that `TICKETMASTER_API_KEY` contains the Consumer Key, without quotes or spaces. The Consumer Secret will not work in its place.

### The workflow does not appear

Open the repository's **Actions** tab and enable workflows. Then select **Check Knicks home tickets** and click **Run workflow**.

### The workflow cannot commit `state.json`

Open **Settings → Actions → General → Workflow permissions**, select **Read and write permissions**, and save. Then run the workflow again.

## Security

- Credentials belong only in GitHub Actions secrets.
- Never put credentials in `config.json`, `state.json`, source code, issues, screenshots, or chat messages.
- The workflow requests write access only so it can persist `state.json`.
- Ticketmaster and Telegram credentials do not transfer when another person creates a repository from this template.

## Limitations

- Ticketmaster controls which events appear in the Discovery API and when they appear.
- GitHub Actions schedules are approximate and may be delayed.
- This project detects Ticketmaster's public on-sale status; it cannot guarantee that seats remain available by the time a link is opened.
- This is an independent fan project and is not affiliated with the New York Knicks, Madison Square Garden, Ticketmaster, Telegram, or GitHub.
