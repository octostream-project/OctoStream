export interface OctoPlayerPlugin {
  playExoPlayer(options: { url: string; title?: string }): Promise<void>
  playVlc(options: { url: string; title?: string }): Promise<void>
}
