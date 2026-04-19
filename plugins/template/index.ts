// template plugin for toebeans

export default function create() {
  return {
    name: 'template',
    description: 'TODO: describe what this plugin does',

    tools: [
      {
        name: 'template_hello',
        description: 'A sample tool. Replace me!',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'A message' },
          },
          required: ['message'],
        },
        async execute(input: unknown) {
          const { message } = input as { message: string }
          return { content: `hello from template: ${message}` }
        },
      },
    ],

    // optional lifecycle hooks:
    // init(config) { },
    // destroy() { },
  }
}
