const { useEffect, useMemo, useState } = React;

function App() {
  const [mode, setMode] = useState('swing');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');

  const load = async (force = false) => {
    if (data) setUpdating(true);
    else setLoading(true);
    try {
      const response = await fetch(`/api/market-data?mode=${mode}${force ? '&force=1' : ''}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail || json.error || 'Unable to fetch market data');
      setData(json);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setUpdating(false);
    }
  };

  useEffect(() => { load(); }, [mode]);
  useEffect(() => {
    const id = setInterval(() => load(), 45000);
    return () => clearInterval(id);
  }, [mode, data]);

  const updatedAgo = useMemo(() => {
    if (!data?.updatedAt) return 'waiting for data';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(data.updatedAt).getTime()) / 1000));
    return `updated ${seconds}s ago`;
  }, [data, loading, updating]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="ticker">
          <div className="ticker-track">
            {(data?.ticker || []).map((item) => `${item.symbol} ${item.price} ${item.change1d >= 0 ? '+' : ''}${item.change1d}%   `).join(' • ')}
          </div>
        </div>
        <div className={`status ${updating || loading ? 'updating' : 'live'}`}>{updating || loading ? 'UPDATING' : 'LIVE'}</div>
        <div className="small">{updatedAgo}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="mode-toggle">
            <button className={mode === 'swing' ? 'active' : ''} onClick={() => setMode('swing')}>Swing</button>
            <button className={mode === 'day' ? 'active' : ''} onClick={() => setMode('day')}>Day</button>
          </div>
          <button className="refresh-btn" onClick={() => load(true)}>Refresh</button>
        </div>
      </div>

      {data?.alert && <div className="alert">⚠ {data.alert}</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="hero-wrap">
        <div className="hero">
          <h2>Should I Trade?</h2>
          <div className={`decision ${data?.decision || ''}`}>{data?.decision || '--'}</div>
          <div className="ring" style={{ '--score': data?.marketQualityScore || 0 }}>
            <div className="ring-inner">
              <div>
                <div className="score-value">{data?.marketQualityScore ?? '--'}%</div>
                <div className="small">Market Quality Score</div>
              </div>
            </div>
          </div>
        </div>
        <div className="hero panel">
          <h2>Terminal Analysis</h2>
          {loading && !data ? <div className="skeleton" /> : <div className="summary">{data?.summary}</div>}
          <div className="hero-secondary">
            <div>
              <div className="metric">{data?.executionWindowScore ?? '--'}%</div>
              <div className="small">Execution Window Score</div>
            </div>
            <div>
              <div className="metric">{data?.inputs?.trend?.regime || '--'}</div>
              <div className="small">Market Regime</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid">
        {['volatility', 'trend', 'breadth', 'momentum', 'macro'].map((key) => (
          <div className="panel span-4" key={key}>
            <h3>{key}</h3>
            {loading && !data ? <div className="skeleton" /> : <>
              <div className="metric">{data?.panels?.[key]?.value} {data?.panels?.[key]?.direction}</div>
              <div className={`interpretation ${data?.panels?.[key]?.interpretation}`}>{data?.panels?.[key]?.interpretation}</div>
            </>}
          </div>
        ))}

        <div className="panel span-6">
          <h3>Sector Heatmap</h3>
          {(data?.inputs?.momentum?.sectorPerformance || []).map((sector) => {
            const positive = sector.change5d >= 0;
            const width = Math.min(100, Math.abs(sector.change5d) * 12);
            return (
              <div className="heat-row" key={sector.symbol}>
                <div>{sector.symbol}</div>
                <div className="bar-wrap"><div className="bar" style={{ width: `${width}%`, background: positive ? 'var(--green)' : 'var(--red)' }} /></div>
                <div style={{ color: positive ? 'var(--green)' : 'var(--red)' }}>{sector.change5d}%</div>
              </div>
            );
          })}
        </div>

        <div className="panel span-6">
          <h3>Scoring Breakdown</h3>
          {data && Object.entries(data.categoryScores || {}).map(([key, score]) => {
            const weight = Math.round(data.formulas ? ({volatility:25,momentum:25,trend:20,breadth:20,macro:10}[key]) : 0);
            return (
              <div className="score-row" key={key}>
                <div>{key.toUpperCase()}</div>
                <div>{weight}%</div>
                <div className="contrib"><div style={{ width: `${score}%` }} /></div>
                <div>{score}</div>
              </div>
            );
          })}
        </div>

        <div className="panel span-8">
          <h3>Market Internals</h3>
          {data && [
            ['VIX', data.inputs.volatility.vix],
            ['VIX 5d slope', `${data.inputs.volatility.vixSlope}%`],
            ['VIX 1y percentile', `${data.inputs.volatility.vixPercentile}%`],
            ['VVIX', data.inputs.volatility.vvix ?? 'n/a'],
            ['Put/Call est.', data.inputs.volatility.putCallEstimate],
            ['SPY RSI(14)', data.inputs.trend.rsi],
            ['% > 20DMA', `${data.inputs.breadth.above20}%`],
            ['% > 50DMA', `${data.inputs.breadth.above50}%`],
            ['% > 200DMA', `${data.inputs.breadth.above200}%`],
            ['A/D ratio', data.inputs.breadth.adRatio],
            ['Nasdaq NH-NL proxy', `${data.inputs.breadth.newHighLowSpread}%`],
            ['Higher highs', `${data.inputs.momentum.higherHighs}%`],
            ['10Y yield', `${data.inputs.macro.tenYearYield}%`],
            ['DXY', data.inputs.macro.dxy],
            ['Fed stance', data.inputs.macro.fedStance],
          ].map(([label, value]) => <div className="kv" key={label}><span>{label}</span><span>{value}</span></div>)}
        </div>

        <div className="panel span-4">
          <h3>Execution Window</h3>
          {data && [
            ['Breakouts holding', data.inputs.execution.breakoutsHolding],
            ['Leaders holding gains', data.inputs.execution.leadersHolding],
            ['Pullbacks bought', data.inputs.execution.pullbacksBought],
            ['Multi-day follow-through', data.inputs.execution.followThrough],
          ].map(([label, value]) => <div className="kv" key={label}><span>{label}</span><span className="code">{value}%</span></div>)}
        </div>
      </div>

      <div className="footer-grid">
        <div className="footer-card">
          <h3>Editable formulas</h3>
          <div className="kv"><span>Market Quality</span><span className="code">{data?.formulas?.marketQualityScore}</span></div>
          <div className="kv"><span>Execution</span><span className="code">{data?.formulas?.executionWindowScore}</span></div>
          <div className="small">Server-side cache: 30s | Auto-refresh: {data?.refreshSeconds || 45}s</div>
        </div>
        <div className="footer-card">
          <h3>Data quality notes</h3>
          {(data?.notes || []).map((note) => <div className="small" key={note}>• {note}</div>)}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
