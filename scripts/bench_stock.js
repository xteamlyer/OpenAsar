#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { join, resolve } = require('path');
const { tmpdir } = require('os');

const DEFAULT_RUNS = Number.parseInt(process.env.OPENASAR_PERF_RUNS ?? '10', 10) || 10;
const DEFAULT_APP_ASAR = process.env.OPENASAR_STOCK_APP_ASAR || '/opt/discord/resources/app.asar';
const DEFAULT_APP_COMMAND = process.env.OPENASAR_STOCK_APP_COMMAND || 'discord';
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const PERFORMANCE_PATTERN = /Performance\]\s+(.*?)\s+(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/;

const scriptDir = __dirname;
const repoRoot = resolve(scriptDir, '..');

let activeRunCleanup = null;

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
  const appArgs = [];

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
      appArgs.push(...argv.slice(i + 1));
      break;
    }

    appArgs.push(arg);
  }

  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`Invalid run count: ${runs}`);
  }

  return { help: false, runs, color, appArgs };
};

const usage = () => [
  'Usage: ./scripts/bench_stock.js [--runs N] [--color|--no-color] [--] [args for discord]',
  '',
  'Examples:',
  '  ./scripts/bench_stock.js',
  '  ./scripts/bench_stock.js --runs 5',
  '  ./scripts/bench_stock.js -- --start-minimized'
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
  const title = `${styles.bold(styles.cyan('Discord Stock Performance Timeline'))} ${styles.dim(`(${runCount} runs)`)}\n`;
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

const checkedSpawnSync = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    ...options
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const joined = [result.stdout, result.stderr].filter(Boolean).join('');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${joined ? `\n${joined}` : ''}`);
  }

  return result;
};

const checkedElevatedCopy = (from, to) => {
  const result = spawnSync('sudo', ['cp', from, to], {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`sudo cp ${from} ${to} failed with exit code ${result.status}`);
  }
};

const replaceOnce = (text, search, replacement, filePath) => {
  if (!text.includes(search)) {
    throw new Error(`Failed to patch ${filePath}: missing marker ${JSON.stringify(search)}`);
  }

  return text.replace(search, replacement);
};

const patchFile = (filePath, patcher) => {
  const original = readFileSync(filePath, 'utf8');
  const updated = patcher(original);
  writeFileSync(filePath, updated);
};

const patchStockBundle = extractedDir => {
  const indexPath = join(extractedDir, 'app_bootstrap', 'index.js');
  const bootstrapPath = join(extractedDir, 'app_bootstrap', 'bootstrap.js');
  const splashScreenPath = join(extractedDir, 'app_bootstrap', 'splashScreen.js');

  patchFile(indexPath, source => {
    let updated = replaceOnce(
      source,
      '"use strict";\n\n',
      '"use strict";\n\nconst __benchStockPerfLog = label => console.log(`[Performance] ${label} ${performance.now()}`);\n\n',
      indexPath
    );

    updated = replaceOnce(
      updated,
      "performance.mark('index-init');",
      "__benchStockPerfLog('index start');\nperformance.mark('index-init');",
      indexPath
    );

    return updated;
  });

  patchFile(bootstrapPath, source => {
    let updated = replaceOnce(
      source,
      '"use strict";\n\n',
      '"use strict";\n\nconst __benchStockPerfLog = label => console.log(`[Performance] ${label} ${performance.now()}`);\n\n',
      bootstrapPath
    );

    updated = replaceOnce(
      updated,
      "function startUpdate() {\n  performance.mark('bootstrap-startupdate');",
      "function startUpdate() {\n  performance.mark('bootstrap-startupdate');\n  __benchStockPerfLog('startUpdate');\n  let __benchStockFirstScience = false;\n  session.defaultSession.webRequest.onBeforeRequest({\n    urls: ['https://*/api/*/science', 'https://*/api/*/metrics', 'https://*/api/*/typing']\n  }, (_details, callback) => {\n    if (!__benchStockFirstScience) {\n      __benchStockPerfLog('first /science');\n      __benchStockFirstScience = true;\n      process.exit(0);\n      return;\n    }\n\n    callback({ cancel: false });\n  });",
      bootstrapPath
    );

    updated = replaceOnce(
      updated,
      "if (pendingAppQuit) {\n",
      "__benchStockPerfLog('bootstrap start');\nif (pendingAppQuit) {\n",
      bootstrapPath
    );

    updated = replaceOnce(
      updated,
      "      performance.measure('bootstrap-coremodule-startup-duration', 'bootstrap-coremodule-startup');",
      "      __benchStockPerfLog('desktop core started');\n      performance.measure('bootstrap-coremodule-startup-duration', 'bootstrap-coremodule-startup');",
      bootstrapPath
    );

    return updated;
  });

  patchFile(splashScreenPath, source => {
    let updated = replaceOnce(
      source,
      '"use strict";\n\n',
      '"use strict";\n\nconst __benchStockPerfLog = label => console.log(`[Performance] ${label} ${performance.now()}`);\n\n',
      splashScreenPath
    );

    updated = replaceOnce(
      updated,
      "function initSplash(startMinimized = false) {\n  console.log(`splashScreen.initSplash(${startMinimized})`);",
      "function initSplash(startMinimized = false) {\n  console.log(`splashScreen.initSplash(${startMinimized})`);\n  __benchStockPerfLog('initSplash start');",
      splashScreenPath
    );

    updated = replaceOnce(
      updated,
      "  if (newUpdater == null) {\n    initOldUpdater();\n  }\n  launchSplashWindow(startMinimized);",
      "  if (newUpdater == null) {\n    initOldUpdater();\n  }\n  __benchStockPerfLog('inited updater');\n  launchSplashWindow(startMinimized);",
      splashScreenPath
    );

    updated = replaceOnce(
      updated,
      '  launchSplashWindow(startMinimized);',
      "  launchSplashWindow(startMinimized);\n  __benchStockPerfLog('launched splash');",
      splashScreenPath
    );

    updated = replaceOnce(
      updated,
      "  splashWindow = new _electron.BrowserWindow(windowConfig);\n",
      "  splashWindow = new _electron.BrowserWindow(windowConfig);\n  splashWindow.once('ready-to-show', () => __benchStockPerfLog('splash ready-to-show'));\n",
      splashScreenPath
    );

    updated = replaceOnce(
      updated,
      '  events.emit(APP_SHOULD_LAUNCH);',
      "  __benchStockPerfLog('APP_SHOULD_LAUNCH');\n  events.emit(APP_SHOULD_LAUNCH);",
      splashScreenPath
    );

    updated = replaceOnce(
      updated,
      '  process.nextTick(() => events.emit(APP_SHOULD_SHOW));',
      "  process.nextTick(() => {\n    __benchStockPerfLog('APP_SHOULD_SHOW');\n    events.emit(APP_SHOULD_SHOW);\n  });",
      splashScreenPath
    );

    return updated;
  });
};

const prepareInstrumentedAsar = appAsarPath => {
  const workDir = mkdtempSync(join(tmpdir(), 'openasar-bench-stock-'));
  const backupAsarPath = join(workDir, 'app.original.asar');
  const extractedDir = join(workDir, 'app');
  const instrumentedAsarPath = join(workDir, 'app.instrumented.asar');

  copyFileSync(appAsarPath, backupAsarPath);
  checkedSpawnSync('asar', ['extract', backupAsarPath, extractedDir]);
  patchStockBundle(extractedDir);
  checkedSpawnSync('asar', ['pack', extractedDir, instrumentedAsarPath]);

  return { workDir, backupAsarPath, instrumentedAsarPath };
};

const cleanupPreparedRun = prepared => {
  if (prepared == null) return;

  try {
    checkedElevatedCopy(prepared.backupAsarPath, DEFAULT_APP_ASAR);
  } finally {
    rmSync(prepared.workDir, { recursive: true, force: true });
  }
};

const installTerminationHandlers = () => {
  const terminate = signal => {
    if (activeRunCleanup) {
      try {
        activeRunCleanup();
      } catch (err) {
        console.error(err.message);
      }
    }

    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  process.on('SIGINT', () => terminate('SIGINT'));
  process.on('SIGTERM', () => terminate('SIGTERM'));
};

const runOnce = (runIndex, totalRuns, appArgs, colorEnabled) => new Promise((resolvePromise, reject) => {
  if (process.stdout.isTTY) {
    const styles = createStyles(colorEnabled);
    process.stdout.write(`\x1b[2K\r${styles.dim(`Collecting run ${runIndex}/${totalRuns}...`)}`);
  }

  let prepared;

  try {
    prepared = prepareInstrumentedAsar(DEFAULT_APP_ASAR);
    activeRunCleanup = () => cleanupPreparedRun(prepared);
    checkedElevatedCopy(prepared.instrumentedAsarPath, DEFAULT_APP_ASAR);
  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2K\r');
    activeRunCleanup = null;
    if (prepared) {
      try {
        cleanupPreparedRun(prepared);
      } catch { }
    }
    reject(err);
    return;
  }

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return null;
    cleanedUp = true;
    cleanupPreparedRun(prepared);
    return null;
  };

  activeRunCleanup = cleanup;

  const child = spawn(DEFAULT_APP_COMMAND, appArgs, {
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

  child.on('error', err => {
    try {
      cleanup();
    } catch (cleanupErr) {
      err.message += `\n${cleanupErr.message}`;
    }

    activeRunCleanup = null;
    reject(err);
  });

  child.on('close', code => {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2K\r');

    let cleanupError = null;
    try {
      cleanup();
    } catch (err) {
      cleanupError = err;
    }
    activeRunCleanup = null;

    if (cleanupError) {
      reject(cleanupError);
      return;
    }

    const output = `${stdout}${stderr}`;
    if (code !== 0) {
      const err = new Error(`Run ${runIndex} failed with exit code ${code}`);
      err.output = output;
      err.code = code;
      reject(err);
      return;
    }

    const events = parsePerformanceEvents(output);
    if (events.length < 2) {
      const err = new Error(`Run ${runIndex} emitted ${events.length} Performance event(s)`);
      err.output = output;
      reject(err);
      return;
    }

    resolvePromise(buildRunTimings(events));
  });
});

const main = async () => {
  installTerminationHandlers();

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const runs = [];
  for (let i = 1; i <= options.runs; i++) {
    runs.push(await runOnce(i, options.runs, options.appArgs, options.color));
  }

  console.log(renderReport(summarizeRuns(runs), options.runs, options.color));
};

module.exports = {
  buildRunTimings,
  computeStats,
  parsePerformanceEvents,
  prepareInstrumentedAsar,
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
