# Agent evaluation: real questions through the Lens MCP server

A standing check of what an agent (default Sonnet, as GitHub Copilot would run it) gets from Lens: each question
is a fresh headless Claude session with only the Lens MCP server connected. `analyze.py` reports, per question,
wall time, turns and tool calls, and lists every tool call over 30 s (close to the ~60 s limit many MCP clients
apply) and over 60 s, plus tool errors. Read the answers too: numbers must come from tools, and missing data must
be stated, never invented.

```sh
export EVAL_DIR=/path/to/eval-output
export EVAL_MCP_CONFIG=/path/to/mcp.json   # {"mcpServers":{"lens":{"type":"http","url":"https://lens.example/mcp","headers":{"Authorization":"Bearer <personal Lens token>"}}}}
tools/agent-eval/battery.sh run1            # all questions in questions.tsv
python3 tools/agent-eval/analyze.py run1
```

Keep the MCP config file private (it holds a personal token). Use a test or staging Lens, never production data
you are not allowed to send to the model provider.
