// src/hostStats.js
//
// Is this server keeping up? Every USAGE_LOG_MIN minutes (default 10) one
// [Host] line:
//   - event-loop delay: how late the bot gets round to work that is ready
//     (a buy waiting behind other work on a busy core shows up here);
//   - CPU: how busy the machine is, how much of that is the bot, and how
//     much time the hypervisor gave to OTHER customers' machines while this
//     one wanted to run ("stolen": high on busy shared-CPU droplets, ~0 on
//     dedicated cores).
// Reads /proc/stat (Linux); elsewhere only the event-loop part is shown.

const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const config = require('./config');
const { info } = require('./logger');

const RESOLUTION_MS = 10; // the monitor's sampling step, included in what it records
let hist = null;
let timer = null;
let last = null; // { cpu: {total, idle, steal}, proc: cpuUsage, at }

function readCpu() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const f = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal guest guest_nice
    const [user, nice, system, idle, iowait, irq, softirq, steal = 0] = f;
    return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait, steal };
  } catch {
    return null;
  }
}

function snapshot() {
  return { cpu: readCpu(), proc: process.cpuUsage(), at: Date.now() };
}

/** One summary of the period since the last one, and start a new period. */
function summary() {
  if (!hist || !last) return '';
  const now = snapshot();
  const parts = [];
  const lateBy = (ns) => Math.max(0, ns / 1e6 - RESOLUTION_MS);
  const p50 = lateBy(hist.percentile(50));
  const p99 = lateBy(hist.percentile(99));
  const max = lateBy(hist.max);
  if (Number.isFinite(p99) && hist.count > 0) {
    parts.push(`event-loop delay typical ${p50.toFixed(1)} ms, 99th percentile ${p99.toFixed(1)} ms, worst ${Math.round(max)} ms`);
  }
  const wallMs = now.at - last.at;
  const cores = os.cpus().length || 1;
  if (now.cpu && last.cpu && now.cpu.total > last.cpu.total) {
    const dt = now.cpu.total - last.cpu.total;
    const busy = 100 * (1 - (now.cpu.idle - last.cpu.idle) / dt);
    const stolen = (100 * (now.cpu.steal - last.cpu.steal)) / dt;
    parts.push(`CPU busy ${busy.toFixed(0)}%${stolen >= 0.05 ? `, stolen by other machines ${stolen.toFixed(1)}%` : ', none stolen'}`);
  }
  if (wallMs > 0) {
    const used = (now.proc.user - last.proc.user + now.proc.system - last.proc.system) / 1000; // ms
    parts.push(`the bot used ${((100 * used) / (wallMs * cores)).toFixed(0)}% of ${cores} core${cores > 1 ? 's' : ''}`);
  }
  last = now;
  hist.reset();
  return parts.length ? `[Host] Last ${Math.round(wallMs / 60000) || '<1'} min: ${parts.join('; ')}.` : '';
}

function start() {
  if (hist) return;
  hist = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  hist.enable();
  last = snapshot();
  const minutes = config.USAGE_LOG_MIN || 10;
  timer = setInterval(() => {
    const s = summary();
    if (s) info(s);
  }, minutes * 60_000);
  if (timer.unref) timer.unref();
  // A first look after a minute.
  const first = setTimeout(() => {
    const s = summary();
    if (s) info(s);
  }, 60_000);
  if (first.unref) first.unref();
}

function stop() {
  clearInterval(timer);
  if (hist) hist.disable();
  hist = null;
}

module.exports = { start, stop, summary, readCpu };
