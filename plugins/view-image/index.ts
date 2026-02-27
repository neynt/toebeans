import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext } from '../../server/types.ts'
import { resolve } from 'path'

export default function create(): Plugin {
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

          // get original dimensions via identify
          const idProc = Bun.spawn(
            ['magick', 'identify', '-format', '%wx%h', absPath],
            { stdout: 'pipe', stderr: 'pipe' }
          )
          const [idExit, idOut, idErr] = await Promise.all([
            idProc.exited,
            new Response(idProc.stdout).text(),
            new Response(idProc.stderr).text(),
          ])
          if (idExit !== 0) {
            return {
              content: `ImageMagick identify failed (exit ${idExit}): ${idErr}`,
              is_error: true,
            }
          }
          const dimensions = idOut.trim() || '?x?'

          // resize (if wider than 1024px) and convert to png
          const proc = Bun.spawn(
            ['magick', absPath, '-resize', '1024x>', 'png:-'],
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
