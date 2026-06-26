import { join } from 'path'

/**
 * Root directory for all app data (db, recordings, transcripts, config).
 * Set HIDOCK_DATA_ROOT in production (the Docker volume, e.g. /data).
 * Dev default keeps data out of the source tree under <cwd>/.hidock-data.
 */
export function getDataRoot(): string {
  return process.env.HIDOCK_DATA_ROOT || join(process.cwd(), '.hidock-data')
}

/** Absolute path to config.json. Defaults to <dataRoot>/config.json. */
export function getConfigPath(): string {
  return process.env.HIDOCK_CONFIG_PATH || join(getDataRoot(), 'config.json')
}
