import { describe, expect, it } from 'vitest'
import { buildAgentResumeCommand } from './agent-resume-command'

describe('buildAgentResumeCommand', () => {
  it('builds provider-specific resume commands with portable shell tokens', () => {
    expect(
      buildAgentResumeCommand({
        provider: 'claude',
        sessionId: 'session-123',
        cwd: '/repo',
        updatedAt: 1
      })
    ).toBe('claude --resume session-123')

    expect(
      buildAgentResumeCommand({
        provider: 'codex',
        sessionId: 'thread_abc/123',
        cwd: '/repo',
        updatedAt: 1
      })
    ).toBe('codex resume thread_abc/123')
  })

  it('rejects unsafe shell tokens before building shell input', () => {
    expect(
      buildAgentResumeCommand({
        provider: 'codex',
        sessionId: 'session\nrm -rf',
        cwd: null,
        updatedAt: 1
      })
    ).toBeNull()
    expect(
      buildAgentResumeCommand({
        provider: 'claude',
        sessionId: "abc'def",
        cwd: null,
        updatedAt: 1
      })
    ).toBeNull()
    expect(
      buildAgentResumeCommand({
        provider: 'codex',
        sessionId: '-help',
        cwd: null,
        updatedAt: 1
      })
    ).toBeNull()
  })
})
