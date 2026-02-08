import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext } from '../../server/types.ts'
import { resolve } from 'path'

export default function createViewImagePlugin(): Plugin {
  return {
    name: 'view-image',
    description: 'View image files with vision. Use view_image to look at screenshots, photos, diagrams, etc.',

    tools: [
      {
        name: 'view_image',
        description: 'View an image file. Reads the file, resizes if needed (max 1024px wide), and returns it as a vision content block so you can see it.',
        inputSchema: {
          type: 'object',
          properties: {
            image_path: { type: 'string', description: 'Path to the image file' },
          },
          required: ['image_path'],
        },
        async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
          const { image_path } = input as { image_path: string }
          const absPath = resolve(context.workingDir, image_path)

          const file = Bun.file(absPath)
          if (!(await file.exists())) {
            return { content: `File not found: ${absPath}`, is_error: true }
          }

          // use imagemagick to resize (if wider than 1024px) and convert to png
          // -resize 1024x> means: only shrink if wider than 1024, preserve aspect ratio
          // -write info:/dev/stderr outputs "WxH" dimensions to stderr
          const proc = Bun.spawn(
            ['magick', absPath, '-resize', '1024x>', '-format', '%wx%h', '-write', 'info:/dev/stderr', 'png:-'],
            { stdout: 'pipe', stderr: 'pipe' }
          )

          const [exitCode, pngBytes, stderrText] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).arrayBuffer(),
            new Response(proc.stderr).text(),
          ])

          if (exitCode !== 0) {
            return {
              content: `ImageMagick failed (exit ${exitCode}): ${stderrText}`,
              is_error: true,
            }
          }

          // stderr contains dimensions (e.g. "1024x768"), possibly with extra warnings
          const dimMatch = stderrText.match(/(\d+x\d+)/)
          const dimensions = dimMatch ? dimMatch[1] : '?x?'
          const filename = absPath.split('/').pop() ?? absPath
          const data = Buffer.from(pngBytes).toString('base64')

          return {
            content: [
              { type: 'text', text: `image: ${filename} (${dimensions})` },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data,
                },
              },
            ],
          }
        },
      },
    ],
  }
}
