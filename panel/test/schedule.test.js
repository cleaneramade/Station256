// Checks the times for scheduled tasks (lib/cron.js). Plain node, no packages:
//   node panel/test/schedule.test.js
// Runs in New York time, where the clocks change, so the daylight saving cases are real. Exits with
// 1 if anything is wrong.
process.env.TZ = 'America/New_York'; // before anything uses a Date
const assert = require('assert');
const cron = require('../lib/cron');

let failed = 0;
function check(label, test) {
  try {
    test();
    console.log(`PASS ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${label}: ${error.message}`);
  }
}

// Local clock text for a time: "2026-11-10 21:00".
const show = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const next = (text, after) => cron.nextCron(cron.parse(text), after);
const nextText = (text, after) => show(next(text, after));
const throwsWith = (text, words) => assert.throws(() => cron.parse(text), (e) => e.message.includes(words), `"${text}" should say "${words}"`);

check('the test runs in New York time', () => assert.strictEqual(new Date(2026, 6, 1).getTimezoneOffset(), 240));

check('a plain daily time', () => {
  assert.strictEqual(nextText('0 21 * * *', at(2026, 11, 10, 20, 41)), '2026-11-10 21:00');
  assert.strictEqual(nextText('0 21 * * *', at(2026, 11, 10, 21, 0)), '2026-11-11 21:00'); // strictly after
});

check('lists, ranges and steps', () => {
  assert.strictEqual(nextText('*/15 * * * *', at(2026, 11, 10, 20, 41)), '2026-11-10 20:45');
  assert.strictEqual(nextText('5,35 * * * *', at(2026, 11, 10, 20, 41)), '2026-11-10 21:05');
  assert.strictEqual(nextText('10-20/5 3 * * *', at(2026, 11, 10, 3, 12)), '2026-11-10 03:15');
  assert.strictEqual(nextText('0 9-17/4 * * *', at(2026, 11, 10, 10, 0)), '2026-11-10 13:00');
  assert.strictEqual(nextText('5/20 * * * *', at(2026, 11, 10, 20, 6)), '2026-11-10 20:25'); // 5, 25, 45
});

check('names for days and months, any case', () => {
  // 10 Nov 2026 is a Tuesday.
  assert.strictEqual(nextText('0 9 * * mon-fri', at(2026, 11, 13, 10, 0)), '2026-11-16 09:00');
  assert.strictEqual(nextText('0 9 * * SAT', at(2026, 11, 10, 0, 0)), '2026-11-14 09:00');
  assert.strictEqual(nextText('0 0 1 jan,Jul *', at(2026, 11, 10, 0, 0)), '2027-01-01 00:00');
  assert.strictEqual(nextText('0 0 * dec,jan 0', at(2026, 11, 10, 0, 0)), '2026-12-06 00:00'); // a Sunday in December
});

check('Sunday is 0 and 7', () => {
  assert.strictEqual(next('0 8 * * 7', at(2026, 11, 10)), next('0 8 * * 0', at(2026, 11, 10)));
  assert.strictEqual(nextText('0 8 * * 7', at(2026, 11, 10)), '2026-11-15 08:00');
});

check('day of month and day of week: either one counts when both are limited', () => {
  // The 15th (a Sunday this month) or any Monday.
  assert.strictEqual(nextText('0 0 15 * 1', at(2026, 11, 10, 12, 0)), '2026-11-15 00:00');
  assert.strictEqual(nextText('0 0 15 * 1', at(2026, 11, 15, 12, 0)), '2026-11-16 00:00');
  assert.strictEqual(nextText('0 0 15 * 1', at(2026, 11, 16, 12, 0)), '2026-11-23 00:00');
  // A * on either side means only the other one limits.
  assert.strictEqual(nextText('0 0 15 * *', at(2026, 11, 10, 12, 0)), '2026-11-15 00:00');
  assert.strictEqual(nextText('0 0 15 * *', at(2026, 11, 15, 12, 0)), '2026-12-15 00:00');
  assert.strictEqual(nextText('0 0 * * 1', at(2026, 11, 10, 12, 0)), '2026-11-16 00:00');
  // */2 starts with * so the days of the month don't count as limited: both must match (odd day AND Monday).
  assert.strictEqual(nextText('0 0 */2 * 1', at(2026, 11, 10, 12, 0)), '2026-11-23 00:00');
});

check('a day that never comes gives no next run', () => {
  assert.strictEqual(next('0 0 31 2 *', at(2026, 1, 1)), null);
  assert.throws(() => cron.cleanWhen({ mode: 'cron', text: '0 0 31 2 *' }), /never/);
});

check('Feb 29 is found in a leap year', () => {
  assert.strictEqual(nextText('0 0 29 2 *', at(2026, 3, 1)), '2028-02-29 00:00');
});

check('bad cron text says what is wrong', () => {
  throwsWith('* * * *', '5 parts');
  throwsWith('60 * * * *', 'Minute');
  throwsWith('* 24 * * *', 'Hour');
  throwsWith('* * 0 * *', 'Day of month');
  throwsWith('* * * 13 *', 'Month');
  throwsWith('* * * * 8', 'Day of week');
  throwsWith('*/0 * * * *', 'step');
  throwsWith('30-10 * * * *', 'backwards');
  throwsWith('a * * * *', "isn't a number");
  throwsWith('* * * foo *', 'name');
  throwsWith('1,,2 * * * *', 'Minute');
  throwsWith('', '5 parts');
});

// ---- Daylight saving. In 2026 the clocks jump 2:00 to 3:00 on 8 March and fall back 2:00 to 1:00 on 1 November.
check('a daily 9:00 stays at 9:00 on the clock across the spring change', () => {
  const first = next('0 9 * * *', at(2026, 3, 7, 10, 0));
  assert.strictEqual(show(first), '2026-03-08 09:00');
  assert.strictEqual((first - at(2026, 3, 7, 9, 0)) / 3600000, 23); // a 23 hour day
  assert.strictEqual(nextText('0 9 * * *', first), '2026-03-09 09:00');
});

check('a daily 9:00 stays at 9:00 on the clock across the fall change', () => {
  const first = next('0 9 * * *', at(2026, 10, 31, 10, 0));
  assert.strictEqual(show(first), '2026-11-01 09:00');
  assert.strictEqual((first - at(2026, 10, 31, 9, 0)) / 3600000, 25);
});

check('a time that does not exist (2:30 on 8 March) runs once, at the clock\'s 3:30', () => {
  const day1 = next('30 2 * * *', at(2026, 3, 7, 12, 0));
  assert.strictEqual(show(day1), '2026-03-08 03:30');
  assert.strictEqual(nextText('30 2 * * *', day1), '2026-03-09 02:30');
});

check('a time that happens twice (1:30 on 1 November) runs once', () => {
  const first = next('30 1 * * *', at(2026, 11, 1, 0, 0));
  assert.strictEqual(show(first), '2026-11-01 01:30');
  assert.strictEqual(new Date(first).getTimezoneOffset(), 240); // the first 1:30, still summer time
  assert.strictEqual(nextText('30 1 * * *', first), '2026-11-02 01:30'); // not the second 1:30
});

check('hourly across the spring change never repeats or goes backwards', () => {
  let last = at(2026, 3, 8, 0, 0);
  const seen = new Set();
  for (let i = 0; i < 6; i += 1) {
    const n = next('0 * * * *', last);
    assert.ok(n > last, 'goes forward');
    assert.ok(!seen.has(n), 'no repeat');
    seen.add(n);
    last = n;
  }
});

// ---- The simple choices
check('simple choices turn into cron text', () => {
  assert.strictEqual(cron.cronFor({ mode: 'hourly' }), '0 * * * *');
  assert.strictEqual(cron.cronFor({ mode: 'daily', time: '21:05' }), '5 21 * * *');
  assert.strictEqual(cron.cronFor({ mode: 'weekdays', time: '09:00' }), '0 9 * * 1-5');
  assert.strictEqual(cron.cronFor({ mode: 'weekly', day: 2, time: '07:30' }), '30 7 * * 2');
});

check('every n minutes counts from when it was saved', () => {
  const saved = at(2026, 11, 10, 20, 0);
  const when = { mode: 'minutes', n: 7 };
  assert.strictEqual(show(cron.nextRun(when, at(2026, 11, 10, 20, 1), saved)), '2026-11-10 20:07');
  assert.strictEqual(show(cron.nextRun(when, at(2026, 11, 10, 20, 7), saved)), '2026-11-10 20:14');
  assert.strictEqual(show(cron.nextRun(when, at(2026, 11, 10, 20, 56), saved)), '2026-11-10 21:03'); // not reset at the hour
});

check('the simple choices are checked', () => {
  assert.throws(() => cron.cleanWhen({ mode: 'minutes', n: 4 }), /5 to/);
  assert.throws(() => cron.cleanWhen({ mode: 'minutes', n: 'x' }), /minutes/);
  assert.deepStrictEqual(cron.cleanWhen({ mode: 'minutes', n: '5' }), { mode: 'minutes', n: 5 });
  assert.throws(() => cron.cleanWhen({ mode: 'daily', time: '25:00' }), /time/);
  assert.throws(() => cron.cleanWhen({ mode: 'daily' }), /time/);
  assert.throws(() => cron.cleanWhen({ mode: 'weekly', day: 9, time: '08:00' }), /day/);
  assert.throws(() => cron.cleanWhen({ mode: 'nope' }), /Pick when/);
  assert.deepStrictEqual(cron.cleanWhen({ mode: 'daily', time: '9:05' }), { mode: 'daily', time: '09:05' });
});

check('cron text that runs too often is refused, unless checks allow it', () => {
  assert.throws(() => cron.cleanWhen({ mode: 'cron', text: '* * * * *' }), /more often than every 5/);
  assert.throws(() => cron.cleanWhen({ mode: 'cron', text: '*/2 * * * *' }), /more often/);
  assert.throws(() => cron.cleanWhen({ mode: 'cron', text: '0,3 * * * *' }), /more often/);
  assert.deepStrictEqual(cron.cleanWhen({ mode: 'cron', text: ' */5   * * * * ' }), { mode: 'cron', text: '*/5 * * * *' });
  assert.deepStrictEqual(cron.cleanWhen({ mode: 'cron', text: '* * * * *' }, { allowFast: true }), { mode: 'cron', text: '* * * * *' });
  assert.deepStrictEqual(cron.cleanWhen({ mode: 'minutes', n: 1 }, { allowFast: true }), { mode: 'minutes', n: 1 });
});

check('words and the next-run label', () => {
  assert.strictEqual(cron.describe({ mode: 'minutes', n: 15 }), 'Every 15 minutes');
  assert.strictEqual(cron.describe({ mode: 'hourly' }), 'Every hour');
  assert.strictEqual(cron.describe({ mode: 'daily', time: '21:00' }), 'Every day at 9:00 PM');
  assert.strictEqual(cron.describe({ mode: 'weekdays', time: '00:05' }), 'Weekdays at 12:05 AM');
  assert.strictEqual(cron.describe({ mode: 'weekly', day: 0, time: '12:00' }), 'Every Sunday at 12:00 PM');
  assert.strictEqual(cron.describe({ mode: 'cron', text: '0 9 * * 1' }), 'Cron: 0 9 * * 1');
  const now = at(2026, 11, 10, 20, 41); // a Tuesday
  assert.strictEqual(cron.formatTime(at(2026, 11, 10, 21, 0), now), 'Today 9:00 PM');
  assert.strictEqual(cron.formatTime(at(2026, 11, 11, 9, 0), now), 'Tomorrow 9:00 AM');
  assert.strictEqual(cron.formatTime(at(2026, 11, 13, 9, 0), now), 'Fri 9:00 AM');
  assert.strictEqual(cron.formatTime(at(2026, 11, 24, 21, 0), now), 'Nov 24, 9:00 PM');
});

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
