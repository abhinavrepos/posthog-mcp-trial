import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkBase, posthogLinkHost } from '../src/core/config.ts'

test('link base: one address as scheme://host[:port], never two glued together', () => {
    assert.equal(linkBase('10.10.10.5:8010'), 'http://10.10.10.5:8010')
    assert.equal(linkBase('http://10.10.10.5:8080/'), 'http://10.10.10.5:8080')
    assert.equal(linkBase('http://10.10.10.5/c1.posthog.example.com'), 'http://10.10.10.5')
    assert.equal(linkBase('10.10.10.5/c1.posthog.example.com'), 'http://10.10.10.5')
    assert.equal(linkBase('https://c1.posthog.example.com, http://10.10.10.5'), 'https://c1.posthog.example.com')
    assert.equal(linkBase('c1.posthog.example.com'), 'https://c1.posthog.example.com')
    assert.equal(linkBase('localhost:8080'), 'http://localhost:8080')
    assert.equal(linkBase(''), '')
})

test('PostHog links: POSTHOG_LINK_URL wins, then POSTHOG_PUBLIC_HOST, then the first address', () => {
    assert.equal(posthogLinkHost({ POSTHOG_LINK_URL: '10.10.10.5:8010', POSTHOG_PUBLIC_HOST: 'https://c1.example.com' }), 'http://10.10.10.5:8010')
    assert.equal(posthogLinkHost({ POSTHOG_PUBLIC_HOST: 'http://10.10.10.5/c1.example.com' }), 'http://10.10.10.5')
    assert.equal(posthogLinkHost({ POSTHOG_ADDRESS: '10.10.10.5,c1.example.com' }), 'http://10.10.10.5')
    assert.equal(posthogLinkHost({}), 'http://localhost')
})
