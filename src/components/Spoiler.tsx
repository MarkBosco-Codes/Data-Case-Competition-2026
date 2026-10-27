import { useState } from 'react'

/**
 * Sensitive value spoiler: content stays blurred and unselectable until the
 * user clicks to reveal.
 */
export function Spoiler(props: { children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => setRevealed((r) => !r)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') setRevealed((r) => !r)
      }}
      title={revealed ? 'Click to hide' : 'Click to reveal sensitive value'}
      style={
        revealed
          ? { cursor: 'pointer' }
          : {
              cursor: 'pointer',
              filter: 'blur(5px)',
              userSelect: 'none',
              background: '#e9ecef',
              borderRadius: 4,
              padding: '0 3px',
            }
      }
    >
      {props.children}
    </span>
  )
}

/** True for keys whose values must be spoilered. */
export function isSensitiveKey(key: string): boolean {
  return /bank|iban|account|tax|email|phone|contact\b/i.test(key)
}
