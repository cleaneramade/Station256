// Times for scheduled tasks: standard 5-field cron text (minute hour day-of-month month day-of-week,
// with lists, ranges, steps and names), the simple choices the Schedules page offers, and "when is
// the next run". Plain JS, no packages, and no clock of its own: every function is told the time,
// so it can be checked. All times are the house's local time.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MIN_MINUTES = 5; // the shortest wait between two runs (a test mode can go lower)
const FIELDS = [
  { label: 'Minute', min: 0, max: 59 },
  { label: 'Hour', min: 0, max: 23 },
  { label: 'Day of month', min: 1, max: 31 },
  { label: 'Month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { label: 'Day of week', min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function value(token, field) {
  const lower = token.toLowerCase();
  if (field.names && field.names.includes(lower)) return field.names.indexOf(lower) + field.nameBase;
  if (!/^\d+$/.test(token)) throw new Error(`${field.label}: "${token}" isn't a number${field.names ? ' or a name' : ''}.`);
  const number = Number(token);
  if (number < field.min || number > field.max) throw new Error(`${field.label}: ${number} is outside ${field.min} to ${field.max}.`);
  return number;
}

// One field's text as the set of numbers it allows.
function parseField(text, field) {
  const allowed = new Set();
  if (!text) throw new Error(`${field.label} is empty.`);
  for (const part of text.split(',')) {
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined || !range) throw new Error(`${field.label}: "${part}" isn't understood.`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`${field.label}: the step in "${part}" must be 1 or more.`);
      step = Number(stepText);
    }
    let from;
    let to;
    if (range === '*') {
      from = field.min;
      to = field.max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined) throw new Error(`${field.label}: "${part}" isn't understood.`);
      from = value(a, field);
      to = value(b, field);
      if (from > to) throw new Error(`${field.label}: "${range}" goes backwards.`);
    } else {
      from = value(range, field);
      to = stepText !== undefined ? field.max : from; // "5/10" means from 5 on, every 10
    }
    for (let n = from; n <= to; n += step) allowed.add(field.label === 'Day of week' && n === 7 ? 0 : n);
  }
  return allowed;
}

function parse(text) {
  const parts = String(text || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron text needs 5 parts: minute, hour, day of month, month, day of week. For example: 0 9 * * 1-5');
  const [minutes, hours, doms, months, dows] = parts.map((part, i) => parseField(part, FIELDS[i]));
  // Cron's odd rule: when both the day of month and the day of week are limited, a day counts if
  // it matches either one. A field starting with * is not limited.
  return { minutes, hours, doms, months, dows, domStar: parts[2].startsWith('*'), dowStar: parts[4].startsWith('*'), text: parts.join(' ') };
}

function dayMatches(cron, date) {
  const domOk = cron.doms.has(date.getDate());
  const dowOk = cron.dows.has(date.getDay());
  return cron.domStar || cron.dowStar ? domOk && dowOk : domOk || dowOk;
}

// The first run strictly after `after` (a number of ms), or null if there never is one (31 Feb).
// Works day by day in local time and builds each time from its clock parts, so a daylight saving
// change can't shift it: a time that doesn't exist that day (2:30 when clocks jump 2 to 3) runs
// once, at the time the clock shows instead, and a time that happens twice runs once.
function nextCron(cron, after) {
  const base = new Date(after);
  const hours = [...cron.hours].sort((a, b) => a - b);
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  for (let day = 0; day < 366 * 9; day += 1) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day);
    if (!cron.months.has(date.getMonth() + 1) || !dayMatches(cron, date)) continue;
    let best = null;
    for (const hour of hours) {
      for (const minute of minutes) {
        const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0).getTime();
        if (at > after && (best === null || at < best)) best = at;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

// The shortest wait between the next several runs, in minutes.
function shortestGap(cron, from, count = 24) {
  let last = from;
  let shortest = Infinity;
  for (let i = 0; i < count; i += 1) {
    const at = nextCron(cron, last);
    if (at === null) break;
    if (i > 0) shortest = Math.min(shortest, (at - last) / 60000);
    last = at;
  }
  return shortest;
}

// ---- The simple choices. `when` is one of:
//   { mode: 'minutes', n }  every n minutes, counted from when the task was saved (anchor)
//   { mode: 'hourly' }  { mode: 'daily', time }  { mode: 'weekdays', time }  { mode: 'weekly', day, time }
//   { mode: 'cron', text }
// time is "HH:MM", 24 hour. day is 0 (Sunday) to 6.
function timeParts(time) {
  const match = /^(\d{1,2}):(\d\d)$/.exec(String(time || ''));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Pick a time of day, like 21:00.');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const padTime = (time) => time.replace(/^(\d):/, '0$1:');

// Checks a `when` and returns a clean copy, or throws a plain sentence.
function cleanWhen(when, { allowFast = false } = {}) {
  const mode = when && when.mode;
  const shortest = allowFast ? 1 : MIN_MINUTES;
  if (mode === 'minutes') {
    const n = Number(when.n);
    if (!Number.isInteger(n) || n < shortest || n > 10080) throw new Error(`Every how many minutes? Use ${shortest} to 10080.`);
    return { mode, n };
  }
  if (mode === 'hourly') return { mode };
  if (mode === 'daily' || mode === 'weekdays') {
    timeParts(when.time);
    return { mode, time: padTime(when.time) };
  }
  if (mode === 'weekly') {
    const day = Number(when.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('Pick a day of the week.');
    timeParts(when.time);
    return { mode, day, time: padTime(when.time) };
  }
  if (mode === 'cron') {
    const cron = parse(when.text); // says what's wrong if it can't be read
    if (nextCron(cron, Date.now()) === null) throw new Error('That day never comes, so the task would never run.');
    if (shortestGap(cron, Date.now()) < shortest) throw new Error(`That runs more often than every ${shortest} minutes. Make it less often.`);
    return { mode, text: cron.text };
  }
  throw new Error('Pick when the task should run.');
}

// Cron text for every mode but minutes.
function cronFor(when) {
  if (when.mode === 'hourly') return '0 * * * *';
  if (when.mode === 'cron') return when.text;
  const { hour, minute } = timeParts(when.time);
  if (when.mode === 'daily') return `${minute} ${hour} * * *`;
  if (when.mode === 'weekdays') return `${minute} ${hour} * * 1-5`;
  return `${minute} ${hour} * * ${when.day}`;
}

// The next run after `after` (ms), or null. anchor (ms) is when an "every n minutes" task was saved.
function nextRun(when, after, anchor, unitMs = 60000) {
  if (when.mode === 'minutes') {
    const step = when.n * unitMs; // unitMs: a minute, or less in checks
    const start = Number.isFinite(anchor) ? anchor : after;
    return start + (Math.floor((after - start) / step) + 1) * step;
  }
  return nextCron(parse(cronFor(when)), after);
}

function clock(time) {
  const { hour, minute } = timeParts(time);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function describe(when) {
  if (when.mode === 'minutes') return `Every ${when.n === 1 ? 'minute' : `${when.n} minutes`}`;
  if (when.mode === 'hourly') return 'Every hour';
  if (when.mode === 'daily') return `Every day at ${clock(when.time)}`;
  if (when.mode === 'weekdays') return `Weekdays at ${clock(when.time)}`;
  if (when.mode === 'weekly') return `Every ${DAY_WORDS[when.day]} at ${clock(when.time)}`;
  return `Cron: ${when.text}`;
}

// "Today 9:00 PM", "Tue 9:00 PM", or "Nov 24, 9:00 PM" when it's a week or more away.
function formatTime(ms, now = Date.now()) {
  const at = new Date(ms);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(at) - midnight(new Date(now))) / 86400000);
  const time = clock(`${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${SHORT_DAYS[at.getDay()]} ${time}`;
  return `${SHORT_MONTHS[at.getMonth()]} ${at.getDate()}, ${time}`;
}

module.exports = { parse, nextCron, shortestGap, cleanWhen, cronFor, nextRun, describe, formatTime, MIN_MINUTES, DAY_WORDS };
