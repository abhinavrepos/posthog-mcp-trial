# Data dictionary research

Sources checked 2026-11-17:
- [VS Code MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp): tool availability depends on harness and filters; return needed context in tool results rather than relying on resource discovery. Legacy Local supports manually attached resources; native Copilot does not automatically expose native resources in the browser.
- [VS Code MCP guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers): verify an actual tool call; registering a server alone is insufficient.
- [microsoft/vscode#290063](https://github.com/microsoft/vscode/issues/290063): structuredContent can replace text content sent to the model. Put the dictionary inside the structured result.
- Repository: src/mcp/instructions.ts and test/mcp-instructions.test.ts establish the 2,048-character Claude Code instructions limit, including a normal-config margin. This is not evidence of a Copilot tool-description limit.

No documented fixed Copilot description-character cap or cross-harness guarantee that initialize instructions are read was found in these sources. Treat instructions as supplemental; put query vocabulary in tool descriptions and explicit tool results. Engineering budgets (not claimed client limits): compact dictionary 6,000 characters; complete Lens posthog_exec description 8,000; injected routing block 8,000; exec routing prefix 8,000; describe_app_events description 1,000. Full dictionary is an on-demand result/document, not a startup description. Test these budgets; retain instructions ≤2,048.

## PostHog shapes

Read info responses from /root/chlab/phlab/runs/*.jsonl, notably ph2-ph07 (trends), open2-p06 (funnel), mix-p20 (paths), mix-p12 (retention), mix3-p15 (SQL). Saved info responses include nested-schema discovery hints; use info/schema against the running version if extending these examples.

- Trends/funnels: series: [{kind:"EventsNode",event:"PageView",properties:[{key:"dialog_id",value:["DlgTask35"],operator:"exact",type:"event"}]}.
- Funnel requires ≥2 series; funnelsFilter.funnelOrderType = "ordered".
- Funnel breakdown: breakdownFilter:{breakdown:"client_id",breakdown_type:"event"}. Trends' current schema advertises breakdowns instead: breakdownFilter:{breakdowns:[{property:"client_id",type:"event"}]}. Do not copy the funnel-only legacy shape into current trends.
- Paths: pathsFilter:{includeEventTypes:["hogql"],pathsHogQLExpression:"toString(properties.dialog_id)",stepLimit:5}; top-level properties accepts event property filters.
- Retention: retentionFilter.targetEntity/returningEntity:{id:<event>,name:<event>,type:"events"}; top-level properties supplies event filters. This differs from EventsNode.
- execute-sql: {query:<HogQL string>}; group with properties.dialog_id and filter properties.client_id plus UTC timestamp bounds. Alias count() AS events_count to preserve counts under privacy masking.

The generator uses app-event meanings/examples and configured identity property names. Static examples are synthetic; live examples belong only in the full result, behind the existing privacy processing. PRIVATE omits executable SQL examples and uses Client 100 rather than source client codes.
