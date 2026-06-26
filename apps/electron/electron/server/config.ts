export interface ServerConfig {
  googleClientId: string
  googleClientSecret: string
  publicUrl: string
  adminEmail: string
  sessionSecret: string
  port: number
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export function getServerConfig(): ServerConfig {
  const sessionSecret = required('SESSION_SECRET')
  if (sessionSecret.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters')
  return {
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
    publicUrl: required('PUBLIC_URL').replace(/\/$/, ''),
    adminEmail: process.env.ADMIN_EMAIL || 'rogercoxjr@gmail.com',
    sessionSecret,
    port: process.env.PORT ? Number(process.env.PORT) : 8788
  }
}
