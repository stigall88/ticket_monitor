const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isHomeGame,
  isPubliclyOnSale,
  isScheduledCheckTime,
  readConfig,
} = require('../monitor');

test('loads the configured teams and interval', () => {
  const config = readConfig();
  assert.equal(config.checkIntervalMinutes, 15);
  assert.ok(Array.isArray(config.teams) && config.teams.length > 0);
  for (const team of config.teams) {
    assert.ok(team.name && team.venue && team.venueCity && team.venueState);
  }
});

test('requires a current, non-TBD public sale before alerting', () => {
  const now = new Date('2026-08-21T21:00:00Z');
  const event = {
    dates: { status: { code: 'onsale' } },
    sales: { public: { startTBD: false, startDateTime: '2026-08-21T20:00:00Z' } },
  };

  assert.equal(isPubliclyOnSale(event, now), true);
  assert.equal(isPubliclyOnSale({ ...event, dates: { status: { code: 'offsale' } } }, now), false);
  assert.equal(isPubliclyOnSale({ ...event, sales: { public: { startTBD: true } } }, now), false);
  assert.equal(
    isPubliclyOnSale({
      ...event,
      sales: { public: { startTBD: false, startDateTime: '2026-08-22T20:00:00Z' } },
    }, now),
    false,
  );
});

test('15-minute checks run at 7, 22, 37, and 52 minutes past the hour', () => {
  for (const minute of [7, 22, 37, 52]) {
    assert.equal(
      isScheduledCheckTime(
        new Date(`2026-08-16T12:${String(minute).padStart(2, '0')}:00Z`),
        15,
      ),
      true,
    );
  }
  for (const minute of [0, 5, 12, 30, 57]) {
    assert.equal(
      isScheduledCheckTime(new Date(`2026-08-16T12:${String(minute).padStart(2, '0')}:00Z`), 15),
      false,
    );
  }
});

test('supported intervals remain aligned to the seven-minute offset', () => {
  assert.equal(isScheduledCheckTime(new Date('2026-08-16T12:07:00Z'), 5), true);
  assert.equal(isScheduledCheckTime(new Date('2026-08-16T12:17:00Z'), 10), true);
  assert.equal(isScheduledCheckTime(new Date('2026-08-16T12:27:00Z'), 20), true);
  assert.equal(isScheduledCheckTime(new Date('2026-08-16T12:37:00Z'), 30), true);
  assert.equal(isScheduledCheckTime(new Date('2026-08-16T12:07:00Z'), 60), true);
});

test('accepts an event only when it contains both the team and venue IDs', () => {
  const event = {
    _embedded: {
      attractions: [{ id: 'team' }, { id: 'opponent' }],
      venues: [{ id: 'venue' }],
    },
  };
  assert.equal(isHomeGame(event, 'team', 'venue'), true);
  assert.equal(isHomeGame(event, 'team', 'away-arena'), false);
  assert.equal(isHomeGame(event, 'other-team', 'venue'), false);
});

test('rejects incomplete Ticketmaster event data safely', () => {
  assert.equal(isHomeGame({}, 'team', 'venue'), false);
  assert.equal(
    isHomeGame({ _embedded: { attractions: [{ id: 'team' }] } }, 'team', 'venue'),
    false,
  );
});
