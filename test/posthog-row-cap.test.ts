import assert from 'node:assert/strict'
import {test} from 'node:test'
import {noteSqlRowCap,SQL_ROW_CAP_NOTE} from '../src/mcp/posthog-proxy.ts'

test('execute-sql annotates exactly 500 rows without changing them',()=>{
    const data=['value',...Array.from({length:500},(_,i)=>String(i))].join('\n')
    const original={content:[{type:'text',text:data}]}
    const result=noteSqlRowCap('call execute-sql {"query":"SELECT value"}',original)
    assert.equal(original.content[0].text,data)
    assert.equal(result.content[0].text,data+'\n\n'+SQL_ROW_CAP_NOTE)
    assert.equal(noteSqlRowCap('call execute-sql {}',result).content[0].text,result.content[0].text)
    assert.equal(noteSqlRowCap('call execute-sql {}',{content:[{type:'text',text:data.slice(0,-4)}]}).content[0].text.includes(SQL_ROW_CAP_NOTE),false)
    assert.equal(noteSqlRowCap('call query-trends {}',original),original)
})
