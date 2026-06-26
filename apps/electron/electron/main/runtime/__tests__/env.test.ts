import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'path'
import { getDataRoot, getConfigPath } from '../env'

describe('runtime/env', () => {
  const original = { ...process.env }
  afterEach(() => {
    process.env = { ...original }
  })

  it('uses HIDOCK_DATA_ROOT when set', () => {
    process.env.HIDOCK_DATA_ROOT = '/data'
    expect(getDataRoot()).toBe('/data')
  })

  it('falls back to <cwd>/.hidock-data when unset', () => {
    delete process.env.HIDOCK_DATA_ROOT
    expect(getDataRoot()).toBe(join(process.cwd(), '.hidock-data'))
  })

  it('derives config path under the data root by default', () => {
    process.env.HIDOCK_DATA_ROOT = '/data'
    delete process.env.HIDOCK_CONFIG_PATH
    expect(getConfigPath()).toBe(join('/data', 'config.json'))
  })

  it('honors HIDOCK_CONFIG_PATH override', () => {
    process.env.HIDOCK_CONFIG_PATH = '/etc/hidock/config.json'
    expect(getConfigPath()).toBe('/etc/hidock/config.json')
  })
})
