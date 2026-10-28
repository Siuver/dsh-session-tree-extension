import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/ChatResizeContainment.module.css', import.meta.url), 'utf8')
const rules = [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map(([, selector, body]) => ({
    selectors: selector!.split(',').map(part => part.trim()),
    body: body!.trim(),
  }))

describe('Chat resize containment', () => {
  it('records row heights at rest and skips off-screen rows only while a width handle drags', () => {
    const rest = rules.find(rule => rule.body.includes('contain-intrinsic-size'))
    const drag = rules.find(rule => rule.body.includes('content-visibility'))

    expect(rest?.selectors).toEqual(['[data-conversation-scroll] [data-chat-flow-key]:not([hidden])'])
    expect(rest?.body).toBe('contain-intrinsic-size: auto 80px;')
    expect(drag?.selectors).toEqual([
      '[data-dragging] [data-conversation-scroll] [data-chat-flow-key]:not([hidden])',
      '[data-conversation-scroll]:has(~ [data-width-handle][data-dragging]) [data-chat-flow-key]:not([hidden])',
    ])
    expect(drag?.body).toBe('content-visibility: auto;')
  })

  it('keeps hidden until-found rows out of both rules', () => {
    for (const selector of rules.flatMap(rule => rule.selectors)) {
      expect(selector.endsWith('[data-chat-flow-key]:not([hidden])')).toBe(true)
    }
  })
})
