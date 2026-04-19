// sanitize a discord name (guild, channel, username) for use in route strings
export function sanitizeDiscordName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
}

export function buildDiscordRoute(channelId: string, isDM: boolean, username?: string, guildName?: string, channelName?: string): string {
  if (isDM) {
    const namePart = username ? sanitizeDiscordName(username) : 'unknown'
    return `discord:dm-${namePart}-${channelId}`
  }
  const guildPart = guildName ? sanitizeDiscordName(guildName) : 'unknown'
  const chanPart = channelName ? sanitizeDiscordName(channelName) : 'unknown'
  return `discord:${guildPart}-${chanPart}-${channelId}`
}
