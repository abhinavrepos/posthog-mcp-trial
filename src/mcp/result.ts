/** Preserve the data in text and MCP structured output, with no masking. */
export const jsonResult = (label: string, value: unknown) => ({
    content:[{type:'text' as const,text:label + '\n' + JSON.stringify(value)}],
    structuredContent: value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {rows:value},
})
