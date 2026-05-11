import type { AgentResumeBinding } from '../../../shared/types'

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function isPortableShellToken(value: string): boolean {
  return /^[A-Za-z0-9._:@/-]+$/.test(value)
}

export function buildAgentResumeCommand(binding: AgentResumeBinding): string | null {
  const sessionId = binding.sessionId.trim()
  // Why: this is typed into whatever shell the SSH host uses. Avoid POSIX-only
  // quoting; only resume ids that are safe as one token in common shells.
  if (
    !sessionId ||
    sessionId.length > 200 ||
    sessionId.startsWith('-') ||
    hasControlCharacter(sessionId) ||
    !isPortableShellToken(sessionId)
  ) {
    return null
  }

  if (binding.provider === 'claude') {
    return `claude --resume ${sessionId}`
  }

  if (binding.provider === 'codex') {
    return `codex resume ${sessionId}`
  }

  return null
}
