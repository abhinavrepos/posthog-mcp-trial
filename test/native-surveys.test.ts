import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeValidation, nativePayload } from '../src/core/native-surveys.ts'

test('native survey keeps branching, appearance, triggers, and recurrence', () => {
    const survey=nativeValidation({name:'Feedback',type:'popover',questions:[
        {type:'single_choice',question:'Which?',choices:['A','B'],shuffleOptions:true,branching:{type:'response_based',responseValues:{0:1,1:'end'}}},
        {type:'rating',question:'How good?',scale:5,display:'emoji',lowerBoundLabel:'Poor',upperBoundLabel:'Great'},
    ],appearance:{position:'top_right',surveyPopupDelaySeconds:5,displayThankYouMessage:true,thankYouMessageHeader:'Thanks'},conditions:{events:{values:[{name:'Export'}],repeatedActivation:true},url:'/reports',urlMatchType:'icontains',deviceTypes:['Desktop']},schedule:'recurring',iteration_count:3,iteration_frequency_days:7,responses_limit:100})
    assert.equal((survey.questions[0] as {branching:{type:string}}).branching.type,'response_based')
    assert.equal(survey.appearance?.surveyPopupDelaySeconds,5)
    assert.equal(survey.conditions?.events?.values[0].name,'Export')
    assert.equal(survey.iteration_count,3)
})

test('client audience becomes native person targeting with rollout', () => {
    const payload=nativePayload(nativeValidation({name:'SEM feedback',questions:[{type:'open',question:'What can improve?'}],clients:['SEM'],sample_percent:25}))
    assert.deepEqual(payload.targeting_flag_filters,{groups:[{properties:[{key:'distinct_id',type:'person',value:'^[^|]*\\|[^|]*\\|(?:SEM)\\|',operator:'regex'}],rollout_percentage:25}]})
    const several=nativePayload(nativeValidation({name:'Several',questions:[{type:'open',question:'Why?'}],clients:['SEM','A+B']}))
    assert.equal((several.targeting_flag_filters as any).groups[0].properties[0].value,'^[^|]*\\|[^|]*\\|(?:SEM|A\\+B)\\|')
})

test('invalid branching and unsupported legacy steps have clear paths', () => {
    assert.throws(()=>nativeValidation({name:'Bad',questions:[{type:'open',question:'Why?',branching:{type:'specific_question',index:9}}]}),/questions\.0\.branching\.index/)
    assert.throws(()=>nativeValidation({name:'Bad',questions:[{type:'open',question:'Why?'}],steps:[{event:'Export'}]}),/Unrecognized key: "steps"/)
})

test('legacy one-event survey migrates property filters to native events without stopping', async t => {
    const { config }=await import('../src/core/config.ts')
    const { migrateLegacySurvey }=await import('../src/core/native-surveys.ts')
    const oldHost=config.posthog.host,oldProject=config.posthog.projectId,oldKey=config.posthog.surveyApiKey,oldEnabled=config.surveys.enabled
    Object.assign(config.posthog,{host:'http://posthog.test',projectId:'1',surveyApiKey:'test-key'})
    config.surveys.enabled=true
    t.after(()=>{Object.assign(config.posthog,{host:oldHost,projectId:oldProject,surveyApiKey:oldKey});config.surveys.enabled=oldEnabled})
    const writes:Record<string,unknown>[]=[]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{
        const body=JSON.parse(String(init?.body)) as Record<string,unknown>;writes.push(body)
        return Response.json({...legacy,...body})
    })
    const legacy={id:'00000000-0000-0000-0000-000000000001',name:'Old',type:'popover',questions:[{type:'open',question:'Why?'}],conditions:{events:{values:[{name:'lens_chain:old'}]},lensChain:{managedBy:'lens',steps:[{event:'Event',properties:{action_name:{operator:'exact',values:['Export']}}}],quietDaysAfterClose:7}},appearance:{},start_date:'2026-11-01T00:00:00Z',end_date:null,created_at:'2026-11-01T00:00:00Z'} as any
    const migrated=await migrateLegacySurvey(legacy)
    assert.equal(writes.length,1)
    assert.deepEqual((writes[0].conditions as any).events.values,[{name:'Event',propertyFilters:{action_name:{operator:'exact',values:['Export']}}}])
    assert.equal((writes[0].conditions as any).lensChain,undefined)
    assert.equal((migrated as any).start_date,legacy.start_date)
})

test('legacy multi-event survey stops before reducing its trigger', async t => {
    const {config}=await import('../src/core/config.ts')
    const {migrateLegacySurvey}=await import('../src/core/native-surveys.ts')
    const old={host:config.posthog.host,projectId:config.posthog.projectId,surveyApiKey:config.posthog.surveyApiKey,enabled:config.surveys.enabled}
    Object.assign(config.posthog,{host:'http://posthog.test',projectId:'1',surveyApiKey:'test-key'});config.surveys.enabled=true
    t.after(()=>{Object.assign(config.posthog,old);config.surveys.enabled=old.enabled})
    const writes:Record<string,unknown>[]=[]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));writes.push(body);return Response.json({...legacy,...body})})
    const legacy={id:'00000000-0000-0000-0000-000000000002',name:'Old chain',type:'popover',questions:[{type:'open',question:'Why?'}],conditions:{events:{values:[{name:'lens_chain:old'}]},lensChain:{managedBy:'lens',steps:[{event:'Open'},{event:'Export'}]}},appearance:{},start_date:'2026-11-01T00:00:00Z',end_date:null,created_at:'2026-11-01T00:00:00Z'} as any
    await migrateLegacySurvey(legacy)
    assert.equal(writes.length,2)
    assert.ok(writes[0].end_date)
    assert.deepEqual((writes[1].conditions as any).events.values,[{name:'Export'}])
})

test('native survey view reports regex client audience rather than everyone', async () => {
    const {viewOf}=await import('../src/core/surveys.ts')
    const survey={id:'00000000-0000-0000-0000-000000000003',name:'SEM',type:'popover',questions:[],conditions:{},appearance:{},start_date:null,end_date:null,created_at:'2026-11-01T00:00:00Z',targeting_flag:{filters:{groups:[{properties:[{key:'distinct_id',value:'^[^|]*\\|[^|]*\\|(?:SEM|A\\+B)\\|'}],rollout_percentage:25}]}}} as any
    assert.deepEqual(viewOf(survey).clients,['SEM','A+B'])
    assert.equal(viewOf(survey).sample_percent,25)
})
