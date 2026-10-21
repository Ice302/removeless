#!/bin/bash
# Runs the desktop self-test. Usage: tests/selftest-run.sh <media> <outDir> [extra JSON fields]
# e.g. tests/selftest-run.sh clip.mp4 /tmp/st '"gpu":false,"previewOnly":true'
MEDIA="$1"; OUT="$2"; EXTRA="${3:+,$3}"
rm -rf "$OUT" && mkdir -p "$OUT"
unset ELECTRON_RUN_AS_NODE
REMOVELESS_SELFTEST="{\"media\":\"$MEDIA\",\"outDir\":\"$OUT\"$EXTRA}" npx electron . > "$OUT.log" 2>&1 &
PID=$!
for i in $(seq 1 300); do sleep 2; [ -f "$OUT/report.json" ] && break; kill -0 $PID 2>/dev/null || break; done
sleep 1; kill $PID 2>/dev/null
python3 - "$OUT/report.json" <<'PY'
import json, sys
try: r = json.load(open(sys.argv[1]))
except Exception as e: print('NO REPORT', e); sys.exit(1)
print('OK' if r['ok'] else 'FAIL', r.get('error', ''))
for s in r['steps']:
    d = s.get('detail') or {}
    extra = f"infer {round(d['inferMs'])} ms, total {round(d['totalMs'])} ms, {d.get('backend')}" if isinstance(d, dict) and 'inferMs' in d else ''
    print(('✓' if s['ok'] else '✗'), s['name'].ljust(34), str(s['ms']).rjust(6), 'ms', extra, s.get('error', ''))
PY
