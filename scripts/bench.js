#!/usr/bin/env node

const { spawn } = require('child_process');
const { resolve } = require('path');

const DEFAULT_RUNS = Number.parseInt(process.env.OPENASAR_PERF_RUNS ?? '10', 10) || 10;
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const PERFORMANCE_PATTERN = /Performance\]\s+(.*?)\s+(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/;

const scriptDir = __dirname;
const repoRoot = resolve(scriptDir, '..');
const runScript = resolve(scriptDir, process.env.OPENASAR_PERF_RUN_SCRIPT || 'run.sh');

const stripAnsi = text => text.replace(ANSI_PATTERN, '');

const createStyles = enabled => {
  const wrap = (code, text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

  return {
    bold: text => wrap('1', text),
    dim: text => wrap('2', text),
    cyan: text => wrap('36', text),
    green: text => wrap('32', text),
    yellow: text => wrap('33', text),
    red: text => wrap('31', text),
    magenta: text => wrap('35', text),
    gray: text => wrap('90', text)
  };
};

const fit = (text, width) => {
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width);
  if (width <= 3) return '.'.repeat(width);
  return `${text.slice(0, width - 3)}...`;
};

const formatMs = value => {
  if (value >= 1000) return `${value.toFixed(0)}ms`;
  if (value >= 100) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(2)}ms`;
};

const numericCell = value => formatMs(value).padStart(9);
const totalCell = value => `${(value / 1000).toFixed(2)}s`.padStart(8);

const parseArgs = argv => {
  let runs = DEFAULT_RUNS;
  let color = process.stdout.isTTY && process.env.NO_COLOR == null;
  const runArgs = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--runs') {
      runs = Number.parseInt(argv[i + 1] ?? '', 10);
      i++;
      continue;
    }

    if (arg.startsWith('--runs=')) {
      runs = Number.parseInt(arg.slice('--runs='.length), 10);
      continue;
    }

    if (arg === '--color') {
      color = true;
      continue;
    }

    if (arg === '--no-color') {
      color = false;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    if (arg === '--') {
      runArgs.push(...argv.slice(i + 1));
      break;
    }

    runArgs.push(arg);
  }

  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`Invalid run count: ${runs}`);
  }

  return { help: false, runs, color, runArgs };
};

const usage = () => [
  'Usage: ./scripts/averageStartup.js [--runs N] [--color|--no-color] [--] [args for run.sh]',
  '',
  'Examples:',
  '  ./scripts/averageStartup.js',
  '  ./scripts/averageStartup.js --runs 5',
  '  ./scripts/averageStartup.js -- --start-minimized'
].join('\n');

const parsePerformanceEvents = output => stripAnsi(output)
  .split(/\r?\n/)
  .map(line => {
    const match = line.match(PERFORMANCE_PATTERN);
    if (!match) return null;

    return {
      label: match[1],
      time: Number.parseFloat(match[2])
    };
  })
  .filter(Boolean);

const buildRunTimings = events => {
  if (events.length < 2) {
    throw new Error(`Expected at least 2 Performance events, got ${events.length}`);
  }

  const steps = [];
  for (let i = 1; i < events.length; i++) {
    steps.push({
      order: i,
      label: `${events[i - 1].label} -> ${events[i].label}`,
      delta: events[i].time - events[i - 1].time,
      totalFromStart: events[i].time
    });
  }

  return {
    events,
    steps,
    total: events[events.length - 1].time
  };
};

const computeStats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / count;
  const median = count % 2 === 1
    ? sorted[(count - 1) / 2]
    : (sorted[(count / 2) - 1] + sorted[count / 2]) / 2;
  const variance = count > 1
    ? sorted.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / (count - 1)
    : 0;

  return {
    count,
    min: sorted[0],
    median,
    max: sorted[count - 1],
    mean,
    stddev: Math.sqrt(variance)
  };
};

const summarizeRuns = runs => {
  const rowsByKey = new Map();

  for (const run of runs) {
    for (const step of run.steps) {
      const key = `${step.order}:${step.label}`;
      if (!rowsByKey.has(key)) rowsByKey.set(key, { order: step.order, label: step.label, values: [], totalValues: [] });
      rowsByKey.get(key).values.push(step.delta);
      rowsByKey.get(key).totalValues.push(step.totalFromStart);
    }
  }

  const rows = [...rowsByKey.values()]
    .sort((a, b) => a.order - b.order)
    .map(row => ({
      ...row,
      stats: computeStats(row.values),
      totalStats: computeStats(row.totalValues)
    }));

  const totalStats = computeStats(runs.map(run => run.total));
  const scaleMax = Math.max(totalStats.max, ...rows.map(row => row.stats.max), 1);

  return { rows, totalStats, scaleMax };
};

const renderBar = (stats, scaleMax, width, styles) => {
  if (width <= 0) return '';

  const toPos = value => Math.max(0, Math.min(width - 1, Math.round((value / scaleMax) * (width - 1))));
  const minPos = toPos(stats.min);
  const medianPos = toPos(stats.median);
  const maxPos = toPos(stats.max);
  const chars = new Array(width).fill('.');

  if (minPos === maxPos) {
    chars[minPos] = '*';
  } else {
    for (let i = minPos; i <= maxPos; i++) chars[i] = '=';
    chars[minPos] = '[';
    chars[maxPos] = ']';
    chars[medianPos] = (medianPos === minPos || medianPos === maxPos) ? 'o' : '|';
  }

  return chars.map(char => {
    if (char === '.') return styles.dim(char);
    if (char === '[') return styles.green(char);
    if (char === ']') return styles.red(char);
    if (char === '|' || char === 'o' || char === '*') return styles.yellow(char);
    return styles.cyan(char);
  }).join('');
};

const renderReport = ({ rows, totalStats, scaleMax }, runCount, colorEnabled) => {
  const styles = createStyles(colorEnabled);
  const columns = Math.max(96, Math.min(process.stdout.columns || 120, 140));
  const fixedWidth = 56;
  const minLabelWidth = 26;
  const maxLabelWidth = 52;
  const minBarWidth = 18;
  const labelWidth = Math.min(maxLabelWidth, Math.max(minLabelWidth, columns - fixedWidth - 24));
  const barWidth = Math.max(minBarWidth, columns - fixedWidth - labelWidth);
  const rule = styles.gray('-'.repeat(Math.min(columns, fixedWidth + labelWidth + barWidth)));
  const title = `${styles.bold(styles.cyan('OpenAsar Performance Timeline'))} ${styles.dim(`(${runCount} runs)`)}\n`;
  const subtitle = `${styles.dim('Per-step timings are shown as the delta in ms between sequential Performance events.')}\n`;
  const totalLine = [
    styles.bold('Total startup'),
    styles.green(`min ${formatMs(totalStats.min)}`),
    styles.yellow(`med ${formatMs(totalStats.median)}`),
    styles.red(`max ${formatMs(totalStats.max)}`)
  ].join(` ${styles.gray('|')} `);

  const header = [
    fit('#', 4),
    fit('Step', labelWidth),
    '      Min',
    '      Med',
    '      Max',
    '   Total',
    'Range'
  ].join(' ');

  const lines = rows.map((row, index) => {
    const id = String(index + 1).padStart(2, '0').padStart(4);

    return [
      styles.gray(id),
      fit(row.label, labelWidth),
      styles.green(numericCell(row.stats.min)),
      styles.yellow(numericCell(row.stats.median)),
      styles.red(numericCell(row.stats.max)),
      styles.cyan(totalCell(row.totalStats.median)),
      renderBar(row.stats, scaleMax, barWidth, styles)
    ].join(' ');
  });

  const note = styles.dim('Total shows median time from process start to the end of the step. Range bar spans min..max, "|" marks median.');

  return [
    title.trimEnd(),
    subtitle.trimEnd(),
    totalLine,
    rule,
    styles.bold(header),
    rule,
    ...lines,
    rule,
    note
  ].join('\n');
};

const runOnce = (runIndex, totalRuns, runArgs, colorEnabled) => new Promise((resolvePromise, reject) => {
  if (process.stdout.isTTY) {
    const styles = createStyles(colorEnabled);
    process.stdout.write(`\x1b[2K\r${styles.dim(`Collecting run ${runIndex}/${totalRuns}...`)}`);
  }

  const child = spawn('sh', [runScript, ...runArgs], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  child.on('error', reject);

  child.on('close', code => {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2K\r');

    const output = `${stdout}${stderr}`;
    if (code !== 0) {
      const err = new Error(`Run ${runIndex} failed with exit code ${code}`);
      err.output = output;
      err.code = code;
      return reject(err);
    }

    const events = parsePerformanceEvents(output);
    if (events.length < 2) {
      const err = new Error(`Run ${runIndex} emitted ${events.length} Performance event(s)`);
      err.output = output;
      return reject(err);
    }

    resolvePromise(buildRunTimings(events));
  });
});

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const runs = [];
  for (let i = 1; i <= options.runs; i++) {
    runs.push(await runOnce(i, options.runs, options.runArgs, options.color));
  }

  console.log(renderReport(summarizeRuns(runs), options.runs, options.color));
};

module.exports = {
  buildRunTimings,
  computeStats,
  parsePerformanceEvents,
  renderReport,
  summarizeRuns
};

if (require.main === module) {
  main().catch(err => {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2K\r');
    console.error(err.message);
    if (err.output) console.error(err.output);
    process.exitCode = 1;
  });
}
