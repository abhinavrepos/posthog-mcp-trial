#!/bin/bash
# ask.sh <id> <question>: one headless Claude session (default Sonnet) with ONLY the Lens MCP server connected,
# every stream line timestamped so analyze.py can time each tool call. Requires the Claude Code CLI, logged in.
#   EVAL_DIR   output folder (default ./eval-runs)        EVAL_MCP_CONFIG  MCP config JSON for the lens server
#   EVAL_MODEL model id (default claude-sonnet-5-5)       MCP_TOOL_TIMEOUT client tool timeout in ms (default 900000:
#              measure real durations; compare them with the ~60 s limit common in MCP clients)
set -u
id=$1; q=$2; DIR=${EVAL_DIR:-./eval-runs}; mkdir -p "$DIR/runs" "$DIR/empty"
SYS="You are GitHub Copilot in VS Code, helping a product manager at ION who works on Reval (treasury and hedge-accounting software). You have one MCP server, Lens, with tools over Reval's product analytics. Answer the question using Lens tools: concrete, with numbers from the tools and which tool gave them. Say clearly when something cannot be determined or data is missing. Do not invent numbers."
cd "$DIR/empty" && MCP_TOOL_TIMEOUT=${MCP_TOOL_TIMEOUT:-900000} timeout 1800 claude -p "$q" --model "${EVAL_MODEL:-claude-sonnet-5-5}" --restricted --strict-mcp-config \
  --mcp-config "${EVAL_MCP_CONFIG:?set EVAL_MCP_CONFIG to an MCP config JSON with a lens server}" --system-prompt "$SYS" \
  --disallowedTools Read Write Edit Glob Grep WebSearch WebFetch Agent NotebookEdit TodoWrite ScheduleWakeup CronCreate Monitor --allowedTools "mcp__lens" \
  --output-format stream-json --verbose --no-session-persistence < /dev/null 2>"../runs/$id.err" \
  | while IFS= read -r line; do printf '%s\t%s\n' "$(date +%s.%N)" "$line"; done > "../runs/$id.jsonl"
echo "exit=${PIPESTATUS[0]}" >> "../runs/$id.err"
