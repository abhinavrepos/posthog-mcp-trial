#!/usr/bin/env bash
# Nightly MCP regression gate: the 100 questions through Claude (Sonnet) with only the Lens MCP, against the real
# PostHog, graded on ClickHouse. Fails (exit 1) below MIN_PASS percent (95). Also runs the recipe check.
#   LENS_MCP_CONFIG=run/mcp-regression/lens-mcp.json CLICKHOUSE_URL=http://<clickhouse>:8123 tools/mcp-regression/nightly.sh
# Needs the Claude Code CLI logged in (CLAUDE_CONFIG_DIR as for your login) and the lens MCP config (keys: keep it in run/).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${CLICKHOUSE_URL:?set CLICKHOUSE_URL}" "${LENS_MCP_CONFIG:=run/mcp-regression/lens-mcp.json}"
export LENS_MCP_CONFIG TAG="${TAG:-nightly-$(date -u +%Y%m%dT%H%M)}"
node --import tsx tools/mcp-regression/recipe-check.mts
node --import tsx tools/mcp-regression/run.mts | tee "run/mcp-regression/$TAG.log"
node --import tsx -e "
const r=JSON.parse(require('fs').readFileSync('run/mcp-regression/$TAG/results.json','utf8'));const p=r.filter(x=>x.pass).length*100/r.length
console.log('pass rate '+p.toFixed(1)+'% (gate ${MIN_PASS:-95}%)');process.exit(p>=${MIN_PASS:-95}?0:1)"
