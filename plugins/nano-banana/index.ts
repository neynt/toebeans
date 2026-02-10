// nano-banana plugin for toebeans
// generates images using google's gemini api and sends them to discord

import type { Plugin, Tool, ToolResult } from '../../server/types.ts'
import { mkdir } from 'node:fs/promises'
import { join } from 'path'
import { getDataDir } from '../../server/session.ts'

interface NanoBananaConfig {
  apiKey: string
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<
        | { text: string }
        | { inlineData: { mimeType: string; data: string } }
      >
    }
  }>
}

const IMAGE_DIR = join(getDataDir(), 'nano-banana')

async function ensureImageDir(): Promise<void> {
  await mkdir(IMAGE_DIR, { recursive: true })
}

export default function create(): Plugin {
  let config: NanoBananaConfig | null = null

  const tools: Tool[] = [
    {
      name: 'generate_image',
      description: 'Generate an image using Google Gemini API (Nano Banana). Returns the file path of the saved image.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text prompt describing the image to generate' },
        },
        required: ['prompt'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!config?.apiKey) {
          return { content: 'gemini api key not configured', is_error: true }
        }

        const { prompt } = input as { prompt: string }

        try {
          await ensureImageDir()

          // call gemini api
          const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
            {
              method: 'POST',
              headers: {
                'x-goog-api-key': config.apiKey,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
              }),
            }
          )

          if (!response.ok) {
            const errorText = await response.text()
            return { content: `gemini api error: ${response.status} - ${errorText}`, is_error: true }
          }

          const data = await response.json() as GeminiResponse

          // find image in response
          let imageData: string | null = null
          let imageType = 'image/png'

          for (const part of data.candidates?.[0]?.content?.parts || []) {
            if ('inlineData' in part) {
              imageData = part.inlineData.data
              imageType = part.inlineData.mimeType
              break
            }
          }

          if (!imageData) {
            return { content: 'no image generated in response', is_error: true }
          }

          // save image
          const timestamp = Date.now()
          const ext = imageType.split('/')[1] || 'png'
          const filename = `gemini-${timestamp}.${ext}`
          const filepath = join(IMAGE_DIR, filename)

          // decode base64 and write
          const buffer = Buffer.from(imageData, 'base64')
          await Bun.write(filepath, buffer)

          return { content: `image saved to: ${filepath}` }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `failed to generate image: ${error.message}`, is_error: true }
        }
      },
    },

    {
      name: 'edit_image',
      description: 'Edit one or more images using Google Gemini API (Nano Banana). Supports multiple input images. Returns the file path of the saved result.',
      inputSchema: {
        type: 'object',
        properties: {
          image_paths: { type: 'array', items: { type: 'string' }, description: 'Paths to local image files to edit' },
          prompt: { type: 'string', description: 'Edit instructions describing what changes to make' },
        },
        required: ['image_paths', 'prompt'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        if (!config?.apiKey) {
          return { content: 'gemini api key not configured', is_error: true }
        }

        const { image_paths, prompt } = input as { image_paths: string[]; prompt: string }

        try {
          await ensureImageDir()

          // read and base64-encode each source image
          const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = []
          for (const image_path of image_paths) {
            const file = Bun.file(image_path)
            if (!(await file.exists())) {
              return { content: `image file not found: ${image_path}`, is_error: true }
            }
            const fileBuffer = await file.arrayBuffer()
            const base64Data = Buffer.from(fileBuffer).toString('base64')
            const mimeType = file.type || 'image/png'
            imageParts.push({ inlineData: { mimeType, data: base64Data } })
          }

          // call gemini api with images + text prompt
          const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
            {
              method: 'POST',
              headers: {
                'x-goog-api-key': config.apiKey,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                contents: [{
                  parts: [
                    ...imageParts,
                    { text: prompt },
                  ],
                }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
              }),
            }
          )

          if (!response.ok) {
            const errorText = await response.text()
            return { content: `gemini api error: ${response.status} - ${errorText}`, is_error: true }
          }

          const data = await response.json() as GeminiResponse

          // find image in response
          let imageData: string | null = null
          let imageType = 'image/png'

          for (const part of data.candidates?.[0]?.content?.parts || []) {
            if ('inlineData' in part) {
              imageData = part.inlineData.data
              imageType = part.inlineData.mimeType
              break
            }
          }

          if (!imageData) {
            return { content: 'no image generated in response', is_error: true }
          }

          // save image
          const timestamp = Date.now()
          const ext = imageType.split('/')[1] || 'png'
          const filename = `gemini-edit-${timestamp}.${ext}`
          const filepath = join(IMAGE_DIR, filename)

          // decode base64 and write
          const buffer = Buffer.from(imageData, 'base64')
          await Bun.write(filepath, buffer)

          return { content: `image saved to: ${filepath}` }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `failed to edit image: ${error.message}`, is_error: true }
        }
      },
    },

  ]

  return {
    name: 'nano-banana',
    description: 'generate and edit images using google gemini api',

    tools,

    async init(cfg: unknown) {
      config = cfg as NanoBananaConfig
      if (!config?.apiKey) {
        console.warn('nano-banana: no gemini api key provided')
      }
      await ensureImageDir()
    },
  }
}
