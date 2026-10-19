#!/usr/bin/env bash
# Runs inside the build container: applies the patches and runs the Betaflight unit tests that
# cover the autostart module and the files it touches. Usage: test.sh
set -euo pipefail
cd /bf
for p in /repo/patches/*.patch; do git apply --whitespace=nowarn "$p"; done
cd src/test
for t in test_autostart_unittest test_cli_unittest test_pg_unittest test_scheduler_unittest test_flight_failsafe_unittest; do
  if make "$t" > "/tmp/$t.log" 2>&1; then
    echo "PASS $t ($(grep -Eo '\[  PASSED  \] [0-9]+ tests?' "/tmp/$t.log" | tail -1))"
  else
    echo "FAIL $t"; grep -E "FAILED|error:" "/tmp/$t.log" | head -20; exit 1
  fi
done
