#!/usr/bin/env python3
"""Buat grafik + ringkasan per level dari keluaran k6 (--out json=...).

Pemakaian:  python3 loadtest/plot_results.py loadtest/results/raw.json.gz [folder_keluaran]
Keluaran:   stress_graph.png (VU, throughput, response time, error rate),
            stage_summary.csv, dan tabel markdown di layar (salin ke laporan).
Butuh:      pip install matplotlib
"""
import csv
import gzip
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

WANTED = ('http_reqs', 'http_req_duration', 'http_req_failed', '"vus"')
BIN = 5  # detik per titik grafik
ERR_LIMIT, P95_LIMIT = 0.01, 1000.0  # ambang "gagal": error >= 1% atau p95 >= 1000 ms


def ts(s):
    s = re.sub(r'(\.\d{6})\d*', r'\1', s)  # nanodetik -> mikrodetik
    return datetime.fromisoformat(s).timestamp()


def pct(vals, p):
    if not vals:
        return float('nan')
    v = sorted(vals)
    return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]


def load(path):
    op = gzip.open if str(path).endswith('.gz') else open
    pts = defaultdict(list)  # metric -> [(t, value, stage)]
    with op(path, 'rt') as f:
        for line in f:
            if '"Point"' not in line or not any(w in line for w in WANTED):
                continue
            o = json.loads(line)
            m = o.get('metric')
            if m in ('http_reqs', 'http_req_duration', 'http_req_failed', 'vus'):
                d = o['data']
                pts[m].append((ts(d['time']), d['value'], (d.get('tags') or {}).get('stage', '')))
    return pts


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else src.parent
    out.mkdir(parents=True, exist_ok=True)
    pts = load(src)
    if not pts['http_reqs']:
        sys.exit('Tidak ada data http_reqs di berkas ini. Pastikan memakai --out json=...')
    t0 = min(p[0] for p in pts['http_reqs'])

    # ---- deret waktu per BIN detik ----
    bins = defaultdict(lambda: {'n': 0, 'dur': [], 'fail': [], 'vus': 0})
    for t, v, _ in pts['http_reqs']:
        bins[int((t - t0) // BIN)]['n'] += v
    for t, v, _ in pts['http_req_duration']:
        bins[int((t - t0) // BIN)]['dur'].append(v)
    for t, v, _ in pts['http_req_failed']:
        bins[int((t - t0) // BIN)]['fail'].append(v)
    for t, v, _ in pts['vus']:
        b = bins[int((t - t0) // BIN)]
        b['vus'] = max(b['vus'], v)
    xs = sorted(bins)
    X = [x * BIN for x in xs]
    vus = [bins[x]['vus'] for x in xs]
    rps = [bins[x]['n'] / BIN for x in xs]
    p50 = [pct(bins[x]['dur'], 50) for x in xs]
    p95 = [pct(bins[x]['dur'], 95) for x in xs]
    err = [100 * sum(bins[x]['fail']) / len(bins[x]['fail']) if bins[x]['fail'] else 0 for x in xs]

    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(4, 1, figsize=(11, 10), sharex=True)
    ax[0].plot(X, vus, color='#444'); ax[0].set_ylabel('Virtual users')
    ax[1].plot(X, rps, color='#1f77b4'); ax[1].set_ylabel('Throughput (req/s)')
    ax[2].plot(X, p50, label='p50', color='#2ca02c'); ax[2].plot(X, p95, label='p95', color='#d62728')
    ax[2].axhline(P95_LIMIT, ls='--', color='#999', lw=0.8); ax[2].set_ylabel('Response time (ms)'); ax[2].legend()
    ax[3].plot(X, err, color='#d62728'); ax[3].set_ylabel('Error rate (%)'); ax[3].set_xlabel('Detik sejak mulai')
    for a in ax:
        a.grid(alpha=0.3)
    fig.suptitle('Stress test Portal Ujian CBT (10 - 100 - 500 - 1000 VU)')
    fig.tight_layout()
    png = out / 'stress_graph.png'
    fig.savefig(png, dpi=130)

    # ---- ringkasan per tahap ----
    st = defaultdict(lambda: {'t': [], 'n': 0, 'dur': [], 'fail': []})
    for t, v, s in pts['http_reqs']:
        st[s]['t'].append(t); st[s]['n'] += v
    for t, v, s in pts['http_req_duration']:
        st[s]['dur'].append(v)
    for t, v, s in pts['http_req_failed']:
        st[s]['fail'].append(v)

    def order(s):
        m = re.match(r'(\d+)_(ramp|hold)', s)
        return (int(m.group(1)), m.group(2) == 'hold') if m else (10 ** 9, False)

    rows, first_fail = [], None
    for s in sorted(st, key=order):
        d = st[s]
        span = (max(d['t']) - min(d['t'])) or 1
        e = sum(d['fail']) / len(d['fail']) if d['fail'] else 0
        r = {'tahap': s, 'request': int(d['n']), 'throughput_rps': round(d['n'] / span, 1),
             'avg_ms': round(sum(d['dur']) / len(d['dur']), 1) if d['dur'] else 0,
             'p95_ms': round(pct(d['dur'], 95), 1), 'p99_ms': round(pct(d['dur'], 99), 1),
             'error_pct': round(100 * e, 2)}
        rows.append(r)
        if s.endswith('_hold') and first_fail is None and (e >= ERR_LIMIT or r['p95_ms'] >= P95_LIMIT):
            first_fail = s
    with open(out / 'stage_summary.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)

    print('| Tahap | Request | Throughput (req/s) | Avg (ms) | p95 (ms) | p99 (ms) | Error (%) |')
    print('|---|---|---|---|---|---|---|')
    for r in rows:
        print(f"| {r['tahap']} | {r['request']} | {r['throughput_rps']} | {r['avg_ms']} | {r['p95_ms']} | {r['p99_ms']} | {r['error_pct']} |")
    print()
    print(f"Titik gagal (error >= {ERR_LIMIT*100:.0f}% atau p95 >= {P95_LIMIT:.0f} ms): "
          + (first_fail.replace('_hold', ' VU') if first_fail else 'tidak ada level yang melewati ambang'))
    print(f'Grafik: {png}\nCSV   : {out / "stage_summary.csv"}')


if __name__ == '__main__':
    main()
