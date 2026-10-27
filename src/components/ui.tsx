import type { CSSProperties, ReactNode } from 'react'

// Palette + style tokens matching www.biomediaholdings.com
export const T = {
  red: '#B52026',
  redAlt: '#D71920',
  navy: '#1F405F',
  navyDark: '#042241',
  gradient: 'linear-gradient(90deg, #1F405F 0%, #D71920 100%)',
  porcelain: 'linear-gradient(to bottom, #ecf1f2, #EDF2F3)',
  gray: '#F0F0F0',
  text: '#171b1e',
  muted: '#5f666b',
  border: '#e6eaec',
  card: '#ffffff',
  radius: 16,
  radiusLg: 20,
  font: "'Inter', 'Poppins', system-ui, -apple-system, 'Segoe UI', sans-serif",
} as const

export const pageStyle: CSSProperties = {
  fontFamily: T.font,
  color: T.text,
  maxWidth: 960,
  margin: '0 auto',
  padding: '40px 24px 64px',
}

export const card: CSSProperties = {
  background: T.card,
  border: `1px solid ${T.border}`,
  borderRadius: T.radiusLg,
  boxShadow: '0 4px 18px rgba(4, 34, 65, 0.06)',
  padding: 24,
}

export const kickerStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  padding: '8px 18px',
  borderRadius: 20,
  fontFamily: T.font,
  fontWeight: 700,
  fontSize: 13,
  lineHeight: '14px',
  letterSpacing: '0.2em',
  textTransform: 'uppercase',
  color: '#000',
  whiteSpace: 'nowrap',
  background:
    'linear-gradient(#f8fafa, #f8fafa) padding-box, linear-gradient(90deg, #1F405F 0%, #D71920 100%) border-box',
  border: '1px solid transparent',
}

export const Kicker = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div>
    <span style={{ ...kickerStyle, ...style }}>{children}</span>
  </div>
)

export const titleStyle: CSSProperties = {
  fontFamily: T.font,
  fontWeight: 500,
  fontSize: 30,
  lineHeight: 1.2,
  color: T.navyDark,
  margin: '0 0 8px',
}

export const sectionTitle: CSSProperties = {
  fontFamily: T.font,
  fontWeight: 500,
  fontSize: 20,
  color: T.navyDark,
  margin: '0 0 12px',
}

export const primaryBtn = (opts?: { disabled?: boolean }): CSSProperties => ({
  padding: '10px 18px',
  borderRadius: 999,
  border: 'none',
  background: opts?.disabled ? '#e8b9bb' : T.red,
  color: '#fff',
  fontWeight: 600,
  fontSize: 14,
  fontFamily: T.font,
  cursor: opts?.disabled ? 'not-allowed' : 'pointer',
})

export const outlineBtn = (opts?: { danger?: boolean }): CSSProperties => ({
  padding: '10px 18px',
  borderRadius: 999,
  border: `1px solid ${opts?.danger ? T.red : T.navyDark}`,
  background: '#fff',
  color: opts?.danger ? T.red : T.navyDark,
  fontWeight: 600,
  fontSize: 14,
  fontFamily: T.font,
  cursor: 'pointer',
})

export const linkStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  background: T.gradient,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
}

export const tableStyles = {
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontFamily: T.font,
    fontSize: 14,
  },
  thead: {
    textAlign: 'left' as const,
    borderBottom: `2px solid ${T.navy}`,
    color: T.navy,
    fontWeight: 600,
    fontSize: 12,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
  },
  rowBordered: { borderBottom: `1px solid ${T.border}` },
  small: { fontSize: 13 },
}

export const statusColors: Record<string, string> = {
  NEW: T.navy,
  IN_PROGRESS: '#d97706',
  PENDING_APPROVAL: '#b26a00',
  APPROVED: '#147a3d',
  CREATED_IN_MDM: '#147a3d',
  REJECTED: T.red,
  CANCELLED: T.red,
}

export const statusLabel: Record<string, string> = {
  NEW: 'New',
  IN_PROGRESS: 'In progress',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  CREATED_IN_MDM: 'Approved & applied to MDM',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
}

export const badge = (colorHex: string): CSSProperties => ({
  display: 'inline-block',
  padding: '3px 12px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  color: colorHex,
  background: `color-mix(in srgb, ${colorHex} 10%, #fff)`,
  border: `1px solid color-mix(in srgb, ${colorHex} 30%, #fff)`,
})

export const inputStyle: CSSProperties = {
  padding: '10px 12px',
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  fontFamily: T.font,
  fontSize: 14,
  color: T.text,
  background: '#fff',
}
