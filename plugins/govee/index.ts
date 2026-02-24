// govee smart light control plugin for toebeans
// uses Govee Cloud API v2

import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult } from '../../server/types.ts'

const API_BASE = 'https://openapi.api.govee.com/router/api/v1'

interface GoveeConfig {
  apiKey: string
  devices?: Record<string, { sku: string; device: string }>
}

interface DeviceCapability {
  type: string
  instance: string
  parameters?: unknown
}

interface GoveeDevice {
  sku: string
  device: string
  deviceName: string
  type: string
  capabilities: DeviceCapability[]
}

export default function create(): Plugin {
  let config: GoveeConfig | null = null
  let cachedDevices: GoveeDevice[] = []

  function headers(): Record<string, string> {
    return {
      'Govee-API-Key': config!.apiKey,
      'Content-Type': 'application/json',
    }
  }

  async function fetchDevices(): Promise<GoveeDevice[]> {
    const res = await fetch(`${API_BASE}/user/devices`, { headers: headers() })
    if (!res.ok) {
      throw new Error(`govee api error: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as { data: GoveeDevice[] }
    return json.data ?? []
  }

  async function controlDevice(
    sku: string,
    device: string,
    capability: { type: string; instance: string; value: unknown },
  ): Promise<unknown> {
    const res = await fetch(`${API_BASE}/device/control`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        payload: { sku, device, capability },
      }),
    })
    if (!res.ok) {
      throw new Error(`govee control error: ${res.status} ${await res.text()}`)
    }
    return res.json()
  }

  async function queryState(sku: string, device: string): Promise<unknown> {
    const res = await fetch(`${API_BASE}/device/state`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        payload: { sku, device },
      }),
    })
    if (!res.ok) {
      throw new Error(`govee state error: ${res.status} ${await res.text()}`)
    }
    return res.json()
  }

  function resolveDevice(nameOrId: string): { sku: string; device: string } | null {
    // check friendly names from config
    if (config?.devices?.[nameOrId]) {
      return config.devices[nameOrId]
    }
    // case-insensitive friendly name match
    if (config?.devices) {
      const lower = nameOrId.toLowerCase()
      for (const [name, dev] of Object.entries(config.devices)) {
        if (name.toLowerCase() === lower) return dev
      }
    }
    // match by device id in cached devices
    const found = cachedDevices.find(
      d => d.device === nameOrId || d.deviceName === nameOrId,
    )
    if (found) return { sku: found.sku, device: found.device }
    return null
  }

  function requireDevice(input: { device: string }): { sku: string; device: string } {
    const resolved = resolveDevice(input.device)
    if (!resolved) {
      throw new Error(
        `unknown device "${input.device}". use govee_devices to list available devices.`,
      )
    }
    return resolved
  }

  const tools: Tool[] = [
    {
      name: 'govee_devices',
      description: 'List all Govee smart devices and their capabilities. Refreshes the device cache.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        try {
          cachedDevices = await fetchDevices()
          const lines = cachedDevices.map(d => {
            const caps = d.capabilities.map(c => `${c.instance}`).join(', ')
            return `- ${d.deviceName} (${d.sku}, ${d.device}) — capabilities: ${caps}`
          })
          if (config?.devices) {
            lines.push('', 'configured friendly names:')
            for (const [name, dev] of Object.entries(config.devices)) {
              lines.push(`- "${name}" → ${dev.sku} / ${dev.device}`)
            }
          }
          return { content: lines.join('\n') || 'no devices found' }
        } catch (err: unknown) {
          return { content: `failed to list devices: ${(err as Error).message}`, is_error: true }
        }
      },
    },
    {
      name: 'govee_power',
      description: 'Turn a Govee device on or off.',
      inputSchema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device friendly name or device ID' },
          on: { type: 'boolean', description: 'true to turn on, false to turn off' },
        },
        required: ['device', 'on'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        try {
          const { on, ...rest } = input as { device: string; on: boolean }
          const dev = requireDevice(rest)
          await controlDevice(dev.sku, dev.device, {
            type: 'devices.capabilities.on_off',
            instance: 'powerSwitch',
            value: on ? 1 : 0,
          })
          return { content: `${rest.device} turned ${on ? 'on' : 'off'}` }
        } catch (err: unknown) {
          return { content: (err as Error).message, is_error: true }
        }
      },
    },
    {
      name: 'govee_brightness',
      description: 'Set brightness of a Govee device (1-100).',
      inputSchema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device friendly name or device ID' },
          brightness: { type: 'number', description: 'Brightness level 1-100' },
        },
        required: ['device', 'brightness'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        try {
          const { brightness, ...rest } = input as { device: string; brightness: number }
          const dev = requireDevice(rest)
          await controlDevice(dev.sku, dev.device, {
            type: 'devices.capabilities.range',
            instance: 'brightness',
            value: Math.max(1, Math.min(100, Math.round(brightness))),
          })
          return { content: `${rest.device} brightness set to ${brightness}` }
        } catch (err: unknown) {
          return { content: (err as Error).message, is_error: true }
        }
      },
    },
    {
      name: 'govee_color',
      description: 'Set RGB color of a Govee device.',
      inputSchema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device friendly name or device ID' },
          r: { type: 'number', description: 'Red 0-255' },
          g: { type: 'number', description: 'Green 0-255' },
          b: { type: 'number', description: 'Blue 0-255' },
        },
        required: ['device', 'r', 'g', 'b'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        try {
          const { r, g, b, ...rest } = input as { device: string; r: number; g: number; b: number }
          const dev = requireDevice(rest)
          const rgb = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
          await controlDevice(dev.sku, dev.device, {
            type: 'devices.capabilities.color_setting',
            instance: 'colorRgb',
            value: rgb,
          })
          return { content: `${rest.device} color set to rgb(${r}, ${g}, ${b})` }
        } catch (err: unknown) {
          return { content: (err as Error).message, is_error: true }
        }
      },
    },
    {
      name: 'govee_color_temp',
      description: 'Set color temperature of a Govee device in Kelvin.',
      inputSchema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device friendly name or device ID' },
          temperature: { type: 'number', description: 'Color temperature in Kelvin (e.g. 2700 for warm, 6500 for cool)' },
        },
        required: ['device', 'temperature'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        try {
          const { temperature, ...rest } = input as { device: string; temperature: number }
          const dev = requireDevice(rest)
          await controlDevice(dev.sku, dev.device, {
            type: 'devices.capabilities.color_setting',
            instance: 'colorTemperatureK',
            value: temperature,
          })
          return { content: `${rest.device} color temperature set to ${temperature}K` }
        } catch (err: unknown) {
          return { content: (err as Error).message, is_error: true }
        }
      },
    },
    {
      name: 'govee_state',
      description: 'Query the current state of a Govee device (power, brightness, color, etc).',
      inputSchema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device friendly name or device ID' },
        },
        required: ['device'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        try {
          const dev = requireDevice(input as { device: string })
          const state = await queryState(dev.sku, dev.device)
          return { content: JSON.stringify(state, null, 2) }
        } catch (err: unknown) {
          return { content: (err as Error).message, is_error: true }
        }
      },
    },
  ]

  return {
    name: 'govee',
    description: 'control Govee smart lights via the cloud API',

    tools,

    async init(cfg: unknown) {
      config = cfg as GoveeConfig
      if (!config?.apiKey) {
        console.warn('govee: no apiKey configured, api calls will fail')
        return
      }
      try {
        cachedDevices = await fetchDevices()
        console.log(`govee: discovered ${cachedDevices.length} device(s)`)
      } catch (err) {
        console.warn(`govee: failed to fetch devices on init: ${(err as Error).message}`)
      }
    },

    async buildSystemPrompt() {
      const lines: string[] = ['## Govee Smart Lights']

      if (cachedDevices.length > 0) {
        lines.push('', 'discovered devices:')
        for (const d of cachedDevices) {
          lines.push(`- ${d.deviceName} (${d.sku})`)
        }
      }

      if (config?.devices && Object.keys(config.devices).length > 0) {
        lines.push('', 'configured friendly names:')
        for (const name of Object.keys(config.devices)) {
          lines.push(`- "${name}"`)
        }
      }

      if (cachedDevices.length === 0 && (!config?.devices || Object.keys(config.devices).length === 0)) {
        return null
      }

      lines.push('', 'use govee_* tools to control these lights.')
      return lines.join('\n')
    },
  }
}
