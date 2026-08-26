#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(ROOT, 'config.json');
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state.json');
const API_ROOT = 'https://app.ticketmaster.com/discovery/v2';
const KNICKS_NAME = 'New York Knicks';
const VENUE_NAME = 'Madison Square Garden';
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
  return config;
}

function isScheduledCheckTime(date, intervalMinutes) {
  const minute = date.getUTCMinutes();
  return (minute - SCHEDULE_OFFSET_MINUTE + 60) % intervalMinutes === 0;
}

function readState() {
  return readJson(STATE_FILE, { knownEventIds: [] });
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function apiGet(resource, params) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) throw new Error('TICKETMASTER_API_KEY is required');

  const url = new URL(`${API_ROOT}/${resource}.json`);
  for (const [key, value] of Object.entries({ ...params, apikey: apiKey })) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Ticketmaster API returned ${response.status}: ${detail}`);
  }
  return response.json();
}

function embedded(data, type) {
  return data?._embedded?.[type] || [];
}

async function resolveAttractionId() {
  const data = await apiGet('attractions', {
    keyword: KNICKS_NAME,
    countryCode: 'US',
    size: '20',
  });
  const match = embedded(data, 'attractions').find(
    item => item.name?.toLowerCase() === KNICKS_NAME.toLowerCase(),
  );
  if (!match) throw new Error(`Could not resolve the ${KNICKS_NAME} attraction`);
  return match.id;
}

async function resolveVenueId() {
  const data = await apiGet('venues', {
    keyword: VENUE_NAME,
    countryCode: 'US',
    stateCode: 'NY',
    size: '20',
  });
  const match = embedded(data, 'venues').find(item =>
    item.name?.toLowerCase() === VENUE_NAME.toLowerCase()
    && item.city?.name?.toLowerCase() === 'new york',
  );
  if (!match) throw new Error(`Could not resolve ${VENUE_NAME}`);
  return match.id;
}

function isKnicksHomeGame(event, attractionId, venueId) {
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
  return embedded(data, 'events').filter(event =>
    isKnicksHomeGame(event, attractionId, venueId),
  );
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

async function sendEventAlert(events) {
  const shown = events.slice(0, 10);
  const remaining = events.length - shown.length;
  const text = [
    `🏀 Tickets are now on sale for ${events.length} Knicks home game${events.length === 1 ? '' : 's'}:`,
    '',
    ...shown.map(eventLine),
    remaining > 0 ? `\n…and ${remaining} more.` : '',
  ].filter(Boolean).join('\n');
  await sendTelegramText(text);
}

async function main() {
  const config = readConfig();
  if (process.argv.includes('--scheduled')
      && !isScheduledCheckTime(new Date(), config.checkIntervalMinutes)) {
    console.log(`Not a configured ${config.checkIntervalMinutes}-minute check; exiting.`);
    return;
  }

  const state = readState();
  const attractionId = state.attractionId || await resolveAttractionId();
  const venueId = state.venueId || await resolveVenueId();
  const events = await fetchHomeGames(attractionId, venueId);
  const previousSaleStates = state.eventSaleStates || {};
  const currentSaleStates = Object.fromEntries(
    events.map(event => [event.id, saleObservation(event)]),
  );
  const onSaleEvents = events.filter(event => currentSaleStates[event.id].onSale);
  const newlyOnSaleEvents = onSaleEvents.filter(
    event => previousSaleStates[event.id]?.onSale !== true,
  );

  console.log(
    `Found ${events.length} Knicks home game(s); ${onSaleEvents.length} on sale; `
    + `${newlyOnSaleEvents.length} newly on sale.`,
  );
  if (process.argv.includes('--test-alert')) {
    await sendTelegramText(
      `✅ Knicks ticket monitor test succeeded. Ticketmaster returned ${events.length} current home game${events.length === 1 ? '' : 's'} at Madison Square Garden; ${onSaleEvents.length} ${onSaleEvents.length === 1 ? 'is' : 'are'} currently marked publicly on sale. Scheduled monitoring is active.`,
    );
    console.log('Telegram test alert sent. Test mode does not change notification state.');
    return;
  }

  if (newlyOnSaleEvents.length > 0) await sendEventAlert(newlyOnSaleEvents);
  writeState({
    attractionId,
    venueId,
    eventSaleStates: { ...previousSaleStates, ...currentSaleStates },
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  isKnicksHomeGame,
  isPubliclyOnSale,
  isScheduledCheckTime,
  readConfig,
  saleObservation,
};
