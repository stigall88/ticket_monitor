#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(ROOT, 'config.json');
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state.json');
const API_ROOT = 'https://app.ticketmaster.com/discovery/v2';
const SCHEDULE_OFFSET_MINUTE = 7;
const ALLOWED_INTERVALS = new Set([5, 10, 15, 20, 30, 60]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

function readConfig() {
  const config = readJson(CONFIG_FILE);
  if (!ALLOWED_INTERVALS.has(config.checkIntervalMinutes)) {
    throw new Error('config.json checkIntervalMinutes must be 5, 10, 15, 20, 30, or 60');
  }
  if (!Array.isArray(config.teams) || config.teams.length === 0) {
    throw new Error('config.json must include a non-empty "teams" array');
  }
  for (const team of config.teams) {
    if (!team.name || !team.venue || !team.venueCity || !team.venueState) {
      throw new Error(
        'Each entry in config.json "teams" needs name, venue, venueCity, and venueState',
      );
    }
  }
  return config;
}

function isScheduledCheckTime(date, intervalMinutes) {
  const minute = date.getUTCMinutes();
  return (minute - SCHEDULE_OFFSET_MINUTE + 60) % intervalMinutes === 0;
}

function readState() {
  return readJson(STATE_FILE, { teams: {} });
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

const API_CALL_SPACING_MS = 400;
let lastApiCallAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiGet(resource, params) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) throw new Error('TICKETMASTER_API_KEY is required');

  const wait = lastApiCallAt + API_CALL_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastApiCallAt = Date.now();

  const url = new URL(`${API_ROOT}/${resource}.json`);
  for (const [key, value] of Object.entries({ ...params, apikey: apiKey })) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 429) {
    await sleep(1500);
    lastApiCallAt = Date.now();
    const retry = await fetch(url, { headers: { accept: 'application/json' } });
    if (!retry.ok) {
      const detail = (await retry.text()).slice(0, 300);
      throw new Error(`Ticketmaster API returned ${retry.status}: ${detail}`);
    }
    return retry.json();
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Ticketmaster API returned ${response.status}: ${detail}`);
  }
  return response.json();
}

function embedded(data, type) {
  return data?._embedded?.[type] || [];
}

async function resolveAttractionId(teamName) {
  const data = await apiGet('attractions', {
    keyword: teamName,
    countryCode: 'US',
    size: '20',
  });
  const match = embedded(data, 'attractions').find(
    item => item.name?.toLowerCase() === teamName.toLowerCase(),
  );
  if (!match) throw new Error(`Could not resolve the ${teamName} attraction`);
  return match.id;
}

async function resolveVenueId(venueName, venueCity, venueState) {
  const data = await apiGet('venues', {
    keyword: venueName,
    countryCode: 'US',
    stateCode: venueState,
    size: '20',
  });
  const match = embedded(data, 'venues').find(item =>
    item.name?.toLowerCase() === venueName.toLowerCase()
    && item.city?.name?.toLowerCase() === venueCity.toLowerCase(),
  );
  if (!match) throw new Error(`Could not resolve ${venueName} in ${venueCity}, ${venueState}`);
  return match.id;
}

function isHomeGame(event, attractionId, venueId) {
  const attractionIds = embedded(event, 'attractions').map(item => item.id);
  const venueIds = embedded(event, 'venues').map(item => item.id);
  return attractionIds.includes(attractionId) && venueIds.includes(venueId);
}

function isPubliclyOnSale(event, now = new Date()) {
  if (event.dates?.status?.code !== 'onsale') return false;

  const publicSale = event.sales?.public;
  if (publicSale?.startTBD === true) return false;

  const startTime = Date.parse(publicSale?.startDateTime || '');
  if (Number.isFinite(startTime) && startTime > now.getTime()) return false;

  return true;
}

function saleObservation(event, now = new Date()) {
  return {
    onSale: isPubliclyOnSale(event, now),
    statusCode: event.dates?.status?.code || 'unknown',
    publicSaleStart: event.sales?.public?.startDateTime || null,
    publicSaleStartTBD: event.sales?.public?.startTBD === true,
  };
}

async function fetchHomeGames(attractionId, venueId) {
  const data = await apiGet('events', {
    attractionId,
    venueId,
    countryCode: 'US',
    segmentName: 'Sports',
    size: '100',
    sort: 'date,asc',
  });
  return embedded(data, 'events').filter(event => isHomeGame(event, attractionId, venueId));
}

function eventLine(event) {
  const date = event.dates?.start?.localDate || 'date TBA';
  const time = event.dates?.start?.localTime?.slice(0, 5);
  return `• ${date}${time ? ` ${time}` : ''} — ${event.name}\n${event.url || ''}`.trim();
}

async function sendTelegramText(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Telegram returned ${response.status}: ${detail}`);
  }
}

async function sendEventAlert(teamName, events) {
  const shown = events.slice(0, 10);
  const remaining = events.length - shown.length;
  const text = [
    `🏀 Tickets are now on sale for ${events.length} ${teamName} home game${events.length === 1 ? '' : 's'}:`,
    '',
    ...shown.map(eventLine),
    remaining > 0 ? `\n…and ${remaining} more.` : '',
  ].filter(Boolean).join('\n');
  await sendTelegramText(text);
}

async function checkTeam(team, state) {
  const saved = state.teams[team.name] || {};
  const attractionId = saved.attractionId || await resolveAttractionId(team.name);
  const venueId = saved.venueId
    || await resolveVenueId(team.venue, team.venueCity, team.venueState);

  const events = await fetchHomeGames(attractionId, venueId);
  const previousSaleStates = saved.eventSaleStates || {};
  const currentSaleStates = Object.fromEntries(
    events.map(event => [event.id, saleObservation(event)]),
  );
  const onSaleEvents = events.filter(event => currentSaleStates[event.id].onSale);
  const newlyOnSaleEvents = onSaleEvents.filter(
    event => previousSaleStates[event.id]?.onSale !== true,
  );

  state.teams[team.name] = {
    attractionId,
    venueId,
    eventSaleStates: { ...previousSaleStates, ...currentSaleStates },
  };

  return { team, events, onSaleEvents, newlyOnSaleEvents };
}

async function main() {
  const config = readConfig();
  if (process.argv.includes('--scheduled')
      && !isScheduledCheckTime(new Date(), config.checkIntervalMinutes)) {
    console.log(`Not a configured ${config.checkIntervalMinutes}-minute check; exiting.`);
    return;
  }

  const state = readState();
  if (!state.teams) state.teams = {};

  const results = [];
  for (const team of config.teams) {
    results.push(await checkTeam(team, state));
  }

  for (const result of results) {
    console.log(
      `${result.team.name}: found ${result.events.length} home game(s); `
      + `${result.onSaleEvents.length} on sale; ${result.newlyOnSaleEvents.length} newly on sale.`,
    );
  }

  if (process.argv.includes('--test-alert')) {
    const summary = results
      .map(r => `${r.team.name}: ${r.onSaleEvents.length}/${r.events.length} on sale`)
      .join('; ');
    await sendTelegramText(
      `✅ Ticket monitor test succeeded. ${summary}. Scheduled monitoring is active.`,
    );
    console.log('Telegram test alert sent. Test mode does not change notification state.');
    return;
  }

  for (const result of results) {
    if (result.newlyOnSaleEvents.length > 0) {
      await sendEventAlert(result.team.name, result.newlyOnSaleEvents);
    }
  }

  writeState(state);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  isHomeGame,
  isPubliclyOnSale,
  isScheduledCheckTime,
  readConfig,
  saleObservation,
};
