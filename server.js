const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 30_000;
const AUTO_REFRESH_SECONDS = 45;

const CONFIG = {
  weights: {
    volatility: 0.25,
    momentum: 0.25,
    trend: 0.20,
    breadth: 0.20,
    macro: 0.10,
  },
  thresholds: {
    swing: { yes: 80, caution: 60 },
    day: { yes: 84, caution: 64 },
  },
  tickerTape: ['SPY', 'QQQ', '^VIX', 'DX-Y.NYB', '^TNX', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI'],
  sectors: ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC'],
  breadthUniverse: [
    'SPY', 'QQQ', 'IWM', 'DIA', 'MDY',
    'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA',
    'JPM', 'XOM', 'UNH', 'JNJ', 'HD', 'COST', 'AMD', 'NFLX',
    'CRM', 'AVGO', 'ABBV', 'WMT', 'GE', 'BAC', 'LIN', 'ORCL', 'ADBE', 'CAT'
  ],
  breakoutUniverse: ['NVDA', 'MSFT', 'META', 'AMZN', 'AVGO', 'JPM', 'GE', 'NFLX'],
  macroCalendar: [
    { name: 'FOMC Rate Decision', date: '2026-03-25T18:00:00Z', type: 'FOMC' },
    { name: 'Core PCE', date: '2026-03-27T12:30:00Z', type: 'Macro' },
    { name: 'Nonfarm Payrolls', date: '2026-04-03T12:30:00Z', type: 'Jobs' },
  ],
};

let cache = { timestamp: 0, payload: null };

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/market-data', async (req, res) => {
  const mode = req.query.mode === 'day' ? 'day' : 'swing';
  const force = req.query.force === '1';
  if (!force && cache.payload && Date.now() - cache.timestamp < CACHE_TTL_MS && cache.payload.mode === mode) {
    return res.json({ ...cache.payload, cache: 'hit' });
  }

  try {
    const payload = await buildDashboard(mode);
    cache = { timestamp: Date.now(), payload };
    res.json({ ...payload, cache: 'miss' });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to build market dashboard',
      detail: error.message,
      updatedAt: new Date().toISOString(),
    });
  }
});

async function fetchChart(symbol, range = '1y', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`;
  const { stdout } = await execFileAsync('curl', ['-sL', '-A', 'Mozilla/5.0 codex dashboard', url], { maxBuffer: 20 * 1024 * 1024 });
  const json = JSON.parse(stdout);
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const opens = quote.open || [];
  const volumes = quote.volume || [];
  return timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString(),
    close: closes[index],
    high: highs[index],
    low: lows[index],
    open: opens[index],
    volume: volumes[index],
  })).filter((bar) => Number.isFinite(bar.close));
}

async function fetchMany(symbols) {
  const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await fetchChart(symbol)]));
  return Object.fromEntries(entries);
}

function sma(values, length) {
  if (values.length < length) return null;
  const slice = values.slice(-length);
  return slice.reduce((sum, value) => sum + value, 0) / length;
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function slope(values, length) {
  if (values.length < length) return 0;
  const start = values[values.length - length];
  const end = values[values.length - 1];
  return pctChange(end, start);
}

function percentile(values, current) {
  const valid = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!valid.length) return 0;
  const count = valid.filter((value) => value <= current).length;
  return (count / valid.length) * 100;
}

function computeRsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function arrow(value, flatThreshold = 0.35) {
  if (value > flatThreshold) return '↑';
  if (value < -flatThreshold) return '↓';
  return '→';
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scoreVolatility({ vix, vixSlope, vixPercentile, vvix, putCallEstimate }) {
  let score = 100;
  if (vix > 24) score -= 25;
  else if (vix > 19) score -= 10;
  if (vixSlope > 8) score -= 20;
  if (vixPercentile > 80) score -= 20;
  else if (vixPercentile > 60) score -= 10;
  if (vvix && vvix > 110) score -= 10;
  if (putCallEstimate > 1.15) score -= 8;
  return clamp(score);
}

function scoreTrend({ spy, qqq, rsi, regime }) {
  let score = 50;
  score += spy.close > spy.ma20 ? 10 : -10;
  score += spy.close > spy.ma50 ? 15 : -15;
  score += spy.close > spy.ma200 ? 20 : -20;
  score += qqq.close > qqq.ma50 ? 15 : -15;
  if (rsi >= 50 && rsi <= 68) score += 10;
  else if (rsi > 72 || rsi < 40) score -= 8;
  if (regime === 'uptrend') score += 10;
  if (regime === 'downtrend') score -= 15;
  return clamp(score);
}

function scoreBreadth(breadth) {
  let score = 0;
  score += breadth.above20 * 0.25;
  score += breadth.above50 * 0.3;
  score += breadth.above200 * 0.25;
  score += clamp((breadth.adRatio + 1) * 20, 0, 100) * 0.1;
  score += clamp(50 + breadth.newHighLowSpread, 0, 100) * 0.1;
  return clamp(score);
}

function scoreMomentum(momentum) {
  let score = 50;
  if (momentum.topBottomSpread > 4) score += 20;
  else if (momentum.topBottomSpread > 2) score += 10;
  else if (momentum.topBottomSpread < 0) score -= 15;
  score += (momentum.higherHighs - 50) * 0.5;
  score += momentum.leadingSectorsPositive ? 10 : -10;
  return clamp(score);
}

function scoreMacro(macro) {
  let score = 65;
  if (macro.tenYearTrend > 2.5) score -= 15;
  else if (macro.tenYearTrend < -2.5) score += 10;
  if (macro.dxyTrend > 1.5) score -= 12;
  else if (macro.dxyTrend < -1.5) score += 8;
  if (macro.fedStance === 'hawkish') score -= 12;
  if (macro.fedStance === 'dovish') score += 8;
  if (macro.eventRisk.imminent) score -= macro.eventRisk.sameDay ? 18 : 10;
  return clamp(score);
}

function scoreExecutionWindow(signals) {
  let score = 50;
  score += signals.breakoutsHolding * 0.25;
  score += signals.pullbacksBought * 0.25;
  score += signals.followThrough * 0.25;
  score += signals.leadersHolding * 0.25;
  return clamp(score);
}

function determineDecision(score, mode) {
  const { yes, caution } = CONFIG.thresholds[mode];
  if (score >= yes) return 'YES';
  if (score >= caution) return 'CAUTION';
  return 'NO';
}

function classifyRegime(spy) {
  const bullish = spy.close > spy.ma20 && spy.ma20 > spy.ma50 && spy.ma50 > spy.ma200;
  const bearish = spy.close < spy.ma20 && spy.ma20 < spy.ma50 && spy.ma50 < spy.ma200;
  if (bullish) return 'uptrend';
  if (bearish) return 'downtrend';
  return 'chop';
}

function pickFedStance(tenYearTrend, dxyTrend) {
  if (tenYearTrend > 2 || dxyTrend > 1) return 'hawkish';
  if (tenYearTrend < -2 && dxyTrend < -1) return 'dovish';
  return 'neutral';
}

function summarize(decision, score, executionScore, regime, categoryScores, topSectors, bottomSectors, macro) {
  const tone = decision === 'YES'
    ? 'This is a favorable swing-trading tape'
    : decision === 'CAUTION'
      ? 'This is a selective, tactical tape'
      : 'This is a defensive tape';
  const breadthMsg = categoryScores.breadth >= 65 ? 'breadth is supporting the move' : 'breadth is thin';
  const volMsg = categoryScores.volatility >= 70 ? 'volatility is contained' : 'volatility is elevated';
  const execMsg = executionScore >= 70 ? 'setups are following through' : executionScore >= 55 ? 'setups are mixed' : 'setups are failing quickly';
  const macroMsg = macro.eventRisk.imminent
    ? `${macro.eventRisk.event.name} is within ${macro.eventRisk.hoursAway} hours, so event risk matters.`
    : `macro pressure is ${macro.fedStance}.`;
  return `${tone}: ${regime} conditions, ${breadthMsg}, and ${volMsg}. Leadership is concentrated in ${topSectors.join(', ')}, while ${bottomSectors.join(', ')} are lagging. Execution score is ${Math.round(executionScore)}, so ${execMsg}. ${macroMsg}`;
}

function computeEventRisk() {
  const now = Date.now();
  const upcoming = CONFIG.macroCalendar
    .map((event) => ({ ...event, msAway: new Date(event.date).getTime() - now }))
    .filter((event) => event.msAway >= -6 * 60 * 60 * 1000)
    .sort((a, b) => a.msAway - b.msAway)[0];
  if (!upcoming) return { imminent: false, sameDay: false };
  const hoursAway = round(upcoming.msAway / (60 * 60 * 1000), 1);
  return {
    imminent: upcoming.msAway <= 72 * 60 * 60 * 1000,
    sameDay: upcoming.msAway <= 24 * 60 * 60 * 1000,
    hoursAway,
    event: upcoming,
  };
}

async function buildDashboard(mode) {
  const allSymbols = [...new Set([
    'SPY', 'QQQ', '^VIX', '^VVIX', '^TNX', 'DX-Y.NYB',
    ...CONFIG.sectors,
    ...CONFIG.breadthUniverse,
    ...CONFIG.breakoutUniverse,
  ])];
  const charts = await fetchMany(allSymbols);

  const latest = (symbol) => charts[symbol][charts[symbol].length - 1];
  const closes = (symbol) => charts[symbol].map((bar) => bar.close).filter(Number.isFinite);

  const spyCloses = closes('SPY');
  const qqqCloses = closes('QQQ');
  const vixCloses = closes('^VIX');
  const vvixCloses = charts['^VVIX']?.length ? closes('^VVIX') : [];
  const tnxCloses = closes('^TNX');
  const dxyCloses = closes('DX-Y.NYB');

  const spy = {
    close: latest('SPY').close,
    change1d: pctChange(spyCloses.at(-1), spyCloses.at(-2)),
    ma20: sma(spyCloses, 20),
    ma50: sma(spyCloses, 50),
    ma200: sma(spyCloses, 200),
  };
  const qqq = {
    close: latest('QQQ').close,
    change1d: pctChange(qqqCloses.at(-1), qqqCloses.at(-2)),
    ma50: sma(qqqCloses, 50),
  };
  const vix = latest('^VIX').close;
  const vvix = vvixCloses.length ? vvixCloses.at(-1) : null;
  const vixSlope = slope(vixCloses, 5);
  const vixPercentile = percentile(vixCloses.slice(-252), vix);
  const putCallEstimate = round(0.78 + (vix > 20 ? 0.18 : 0) + (vixSlope > 5 ? 0.09 : 0), 2);
  const rsi = computeRsi(spyCloses, 14);
  const regime = classifyRegime(spy);

  const breadthMetrics = CONFIG.breadthUniverse.map((symbol) => {
    const series = closes(symbol);
    const close = series.at(-1);
    const previous = series.at(-2);
    const high20 = Math.max(...series.slice(-20));
    const low20 = Math.min(...series.slice(-20));
    return {
      symbol,
      close,
      upDay: close > previous,
      above20: close > sma(series, 20),
      above50: close > sma(series, 50),
      above200: close > sma(series, 200),
      newHigh: close >= high20,
      newLow: close <= low20,
      higherHigh: close > series.at(-5),
    };
  });

  const breadth = {
    above20: round((breadthMetrics.filter((x) => x.above20).length / breadthMetrics.length) * 100, 1),
    above50: round((breadthMetrics.filter((x) => x.above50).length / breadthMetrics.length) * 100, 1),
    above200: round((breadthMetrics.filter((x) => x.above200).length / breadthMetrics.length) * 100, 1),
    adLine: breadthMetrics.reduce((sum, item) => sum + (item.upDay ? 1 : -1), 0),
    adRatio: round(breadthMetrics.filter((x) => x.upDay).length / Math.max(1, breadthMetrics.filter((x) => !x.upDay).length), 2),
    newHighLowSpread: round(((breadthMetrics.filter((x) => x.newHigh).length - breadthMetrics.filter((x) => x.newLow).length) / breadthMetrics.length) * 100, 1),
    higherHighs: round((breadthMetrics.filter((x) => x.higherHigh).length / breadthMetrics.length) * 100, 1),
    sampleSize: breadthMetrics.length,
  };

  const sectorPerformance = CONFIG.sectors.map((symbol) => {
    const series = closes(symbol);
    return {
      symbol,
      change5d: round(pctChange(series.at(-1), series.at(-6)), 2),
      change1d: round(pctChange(series.at(-1), series.at(-2)), 2),
    };
  }).sort((a, b) => b.change5d - a.change5d);

  const topSectors = sectorPerformance.slice(0, 3).map((item) => item.symbol);
  const bottomSectors = sectorPerformance.slice(-3).map((item) => item.symbol);
  const topBottomSpread = round(average(sectorPerformance.slice(0, 3).map((x) => x.change5d)) - average(sectorPerformance.slice(-3).map((x) => x.change5d)), 2);

  const macro = {
    tenYearYield: latest('^TNX').close / 10,
    tenYearTrend: round(slope(tnxCloses.map((x) => x / 10), 5), 2),
    dxy: latest('DX-Y.NYB').close,
    dxyTrend: round(slope(dxyCloses, 5), 2),
    fedStance: pickFedStance(slope(tnxCloses, 5), slope(dxyCloses, 5)),
    eventRisk: computeEventRisk(),
  };

  const executionSignals = (() => {
    const leaders = CONFIG.breakoutUniverse.map((symbol) => {
      const series = closes(symbol);
      const current = series.at(-1);
      const pivot = Math.max(...series.slice(-21, -1));
      const priorWeek = series.at(-6);
      const postBreakoutHold = current > pivot * 0.99;
      return {
        symbol,
        breakoutHolding: postBreakoutHold,
        leaderHolding: current > priorWeek,
        pullbackBought: current > sma(series, 10),
        followThrough: pctChange(current, series.at(-4)) > 1,
      };
    });
    return {
      breakoutsHolding: round((leaders.filter((x) => x.breakoutHolding).length / leaders.length) * 100, 1),
      leadersHolding: round((leaders.filter((x) => x.leaderHolding).length / leaders.length) * 100, 1),
      pullbacksBought: round((leaders.filter((x) => x.pullbackBought).length / leaders.length) * 100, 1),
      followThrough: round((leaders.filter((x) => x.followThrough).length / leaders.length) * 100, 1),
      sample: leaders,
    };
  })();

  const categoryScores = {
    volatility: round(scoreVolatility({ vix, vixSlope, vixPercentile, vvix, putCallEstimate }), 1),
    momentum: round(scoreMomentum({ topBottomSpread, higherHighs: breadth.higherHighs, leadingSectorsPositive: average(sectorPerformance.slice(0, 3).map((x) => x.change5d)) > 0, topBottomSpread }), 1),
    trend: round(scoreTrend({ spy, qqq, rsi, regime }), 1),
    breadth: round(scoreBreadth(breadth), 1),
    macro: round(scoreMacro(macro), 1),
  };

  const marketQualityScore = round(
    Object.entries(CONFIG.weights).reduce((sum, [key, weight]) => sum + categoryScores[key] * weight, 0),
    1,
  );
  const executionWindowScore = round(scoreExecutionWindow(executionSignals), 1);
  const decision = determineDecision(marketQualityScore, mode);

  const ticker = CONFIG.tickerTape.map((symbol) => {
    const series = closes(symbol);
    return {
      symbol,
      price: round(series.at(-1), symbol === '^TNX' ? 2 : 2),
      change1d: round(pctChange(series.at(-1), series.at(-2)), 2),
    };
  });

  const panels = {
    volatility: {
      value: `${round(vix, 2)} VIX`,
      direction: arrow(vixSlope),
      interpretation: categoryScores.volatility >= 70 ? 'healthy' : categoryScores.volatility >= 55 ? 'watchful' : 'risk-off',
    },
    trend: {
      value: `${regime}`,
      direction: arrow(spy.change1d),
      interpretation: categoryScores.trend >= 70 ? 'healthy' : categoryScores.trend >= 55 ? 'mixed' : 'weakening',
    },
    breadth: {
      value: `${breadth.above50}% > 50DMA`,
      direction: arrow(breadth.adRatio - 1),
      interpretation: categoryScores.breadth >= 70 ? 'healthy' : categoryScores.breadth >= 55 ? 'mixed' : 'weakening',
    },
    momentum: {
      value: `${topBottomSpread}% spread`,
      direction: arrow(topBottomSpread),
      interpretation: categoryScores.momentum >= 70 ? 'healthy' : categoryScores.momentum >= 55 ? 'mixed' : 'weakening',
    },
    macro: {
      value: `${round(macro.tenYearYield, 2)}% US10Y`,
      direction: arrow(-macro.tenYearTrend),
      interpretation: categoryScores.macro >= 65 ? 'supportive' : categoryScores.macro >= 50 ? 'neutral' : 'risk-off',
    },
  };

  return {
    mode,
    title: 'Should I Be Trading?',
    decision,
    marketQualityScore,
    executionWindowScore,
    summary: summarize(decision, marketQualityScore, executionWindowScore, regime, categoryScores, topSectors, bottomSectors, macro),
    updatedAt: new Date().toISOString(),
    refreshSeconds: AUTO_REFRESH_SECONDS,
    formulas: {
      marketQualityScore: 'volatility*0.25 + momentum*0.25 + trend*0.20 + breadth*0.20 + macro*0.10',
      decisionThresholds: CONFIG.thresholds,
      executionWindowScore: 'average(breakoutsHolding, leadersHolding, pullbacksBought, followThrough)',
    },
    panels,
    ticker,
    inputs: {
      volatility: { vix: round(vix, 2), vixSlope: round(vixSlope, 2), vixPercentile: round(vixPercentile, 1), vvix: vvix ? round(vvix, 2) : null, putCallEstimate },
      trend: {
        spy: { close: round(spy.close, 2), ma20: round(spy.ma20, 2), ma50: round(spy.ma50, 2), ma200: round(spy.ma200, 2) },
        qqq: { close: round(qqq.close, 2), ma50: round(qqq.ma50, 2) },
        rsi: round(rsi, 1), regime,
      },
      breadth,
      momentum: { sectorPerformance, topSectors, bottomSectors, topBottomSpread, higherHighs: breadth.higherHighs },
      macro,
      execution: executionSignals,
    },
    categoryScores,
    alert: macro.eventRisk.imminent
      ? `${macro.eventRisk.event.type} alert: ${macro.eventRisk.event.name} in ${macro.eventRisk.hoursAway} hours.`
      : null,
    notes: [
      'Breadth and execution internals use a liquid proxy basket when full exchange-level data is unavailable.',
      'Put/call is estimated from the volatility regime when direct options flow is unavailable.',
      'All formulas are defined server-side in CONFIG for easy editing.',
    ],
  };
}

app.listen(PORT, () => {
  console.log(`Should I Be Trading dashboard listening on http://localhost:${PORT}`);
});
